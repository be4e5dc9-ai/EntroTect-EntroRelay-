#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::{collections::HashMap, io::{BufRead,BufReader,Write}, path::PathBuf, process::{Child,ChildStdin,Command,Stdio}, sync::{Arc,Mutex,atomic::{AtomicBool,AtomicU64,Ordering}}};
use std::os::windows::process::CommandExt;
use tauri::{Emitter,Manager};
use serde_json::{Value,json};
use tokio::sync::oneshot;
use base64::{Engine,engine::general_purpose::STANDARD};
mod app_update;
mod browser_preview;
use app_update::AppUpdater;

#[repr(C)] struct Blob { len:u32, data:*mut u8 }
#[link(name="Crypt32")] extern "system" {
 fn CryptProtectData(input:*const Blob, description:*const u16, entropy:*const Blob,reserved:*mut std::ffi::c_void,prompt:*mut std::ffi::c_void,flags:u32,output:*mut Blob)->i32;
 fn CryptUnprotectData(input:*const Blob, description:*mut *mut u16,entropy:*const Blob,reserved:*mut std::ffi::c_void,prompt:*mut std::ffi::c_void,flags:u32,output:*mut Blob)->i32;
}
#[link(name="Kernel32")] extern "system" { fn LocalFree(memory:*mut std::ffi::c_void)->*mut std::ffi::c_void; }
fn crypt(method:&str,value:&str)->Result<String,String>{
 let mut bytes=if method=="protect"{value.as_bytes().to_vec()}else{STANDARD.decode(value).map_err(|e|e.to_string())?};
 let input=Blob{len:bytes.len() as u32,data:bytes.as_mut_ptr()};let mut out=Blob{len:0,data:std::ptr::null_mut()};
 unsafe {let ok=if method=="protect" {CryptProtectData(&input,std::ptr::null(),std::ptr::null(),std::ptr::null_mut(),std::ptr::null_mut(),1,&mut out)}else{CryptUnprotectData(&input,std::ptr::null_mut(),std::ptr::null(),std::ptr::null_mut(),std::ptr::null_mut(),1,&mut out)};
 if ok==0{return Err(format!("Windows 凭据保护失败：{}",std::io::Error::last_os_error()));}
 let result=std::slice::from_raw_parts(out.data,out.len as usize).to_vec();LocalFree(out.data.cast());
 if method=="protect"{Ok(STANDARD.encode(result))}else{String::from_utf8(result).map_err(|e|e.to_string())}}
}
type Pending=Arc<Mutex<HashMap<u64,oneshot::Sender<Result<Value,String>>>>>;
struct Backend{root:PathBuf,stdin:Arc<Mutex<ChildStdin>>,child:Mutex<Child>,pending:Pending,next:AtomicU64,closing:AtomicBool}
impl Backend {
 fn start(app:&tauri::AppHandle)->Result<Self,Box<dyn std::error::Error>>{
  let exe=std::env::current_exe()?;let parent=exe.parent().unwrap();
  let project=PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_owned();
  let runtime=std::env::var_os("ENTROTECT_RUNTIME_DIR").map(PathBuf::from).unwrap_or_else(||if parent.join("runtimes").exists(){parent.join("runtimes")}else{project.join(".runtime")});
  let worker=if parent.join("backend/worker.cjs").exists(){parent.join("backend/worker.cjs")}else{project.join("dist-backend/worker.cjs")};
  let root=std::env::var_os("ENTROTECT_DATA_DIR").map(PathBuf::from).unwrap_or_else(||PathBuf::from(std::env::var_os("APPDATA").unwrap()).join("EntroTectNative"));std::fs::create_dir_all(&root)?;
  let mut child=Command::new(runtime.join("node/node.exe")).arg(worker).env("ENTROTECT_RUNTIME_DIR",&runtime).env("ENTROTECT_DATA_DIR",&root).env_remove("ELECTRON_RUN_AS_NODE").creation_flags(0x08000000).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn()?;
  let stdin=Arc::new(Mutex::new(child.stdin.take().unwrap()));let output=child.stdout.take().unwrap();let pending:Pending=Arc::new(Mutex::new(HashMap::new()));
  let writer=stdin.clone();let waiters=pending.clone();let handle=app.clone();
  std::thread::spawn(move||{
   for line in BufReader::new(output).lines(){let Ok(line)=line else{break};let Ok(frame)=serde_json::from_str::<Value>(&line)else{continue};
    if let Some(event)=frame.get("event"){let _=handle.emit("entrotect:event",event);}
    else if let Some(req)=frame.get("hostRequest"){
     let result=crypt(req["method"].as_str().unwrap_or(""),req["value"].as_str().unwrap_or(""));
     let reply=match result{Ok(value)=>json!({"hostReply":{"id":req["id"],"result":value}}),Err(error)=>json!({"hostReply":{"id":req["id"],"error":error}})};
     let _=writeln!(writer.lock().unwrap(),"{}",reply);
    }else if let Some(id)=frame["id"].as_u64(){if let Some(sender)=waiters.lock().unwrap().remove(&id){let result=if let Some(error)=frame["error"].as_str(){Err(error.to_owned())}else{Ok(frame["result"].clone())};let _=sender.send(result);}}
   }
   for (_,sender) in waiters.lock().unwrap().drain(){let _=sender.send(Err("本地执行服务已退出，请重新启动应用".into()));}
   let _=handle.emit("entrotect:event",json!({"type":"diagnostic","conversationId":"","message":"本地执行服务已退出"}));
  });
  Ok(Self{root,stdin,child:Mutex::new(child),pending,next:AtomicU64::new(1),closing:AtomicBool::new(false)})
 }
 async fn call(&self,method:&str,params:Value)->Result<Value,String>{
  let id=self.next.fetch_add(1,Ordering::Relaxed);let(tx,rx)=oneshot::channel();self.pending.lock().unwrap().insert(id,tx);
  if let Err(e)=writeln!(self.stdin.lock().unwrap(),"{}",json!({"id":id,"method":method,"params":params})){self.pending.lock().unwrap().remove(&id);return Err(e.to_string());}
  match tokio::time::timeout(std::time::Duration::from_secs(180),rx).await{Ok(Ok(result))=>result,_=>{self.pending.lock().unwrap().remove(&id);Err("本地执行服务响应超时".into())}}
 }
 fn stop_child(&self) {
  let mut child=self.child.lock().unwrap();
  let _=child.kill();
  let _=child.wait();
 }
}
fn request_shutdown(app:&tauri::AppHandle){
 if app.state::<Backend>().closing.swap(true,Ordering::AcqRel){return;}
 if let Some(window)=app.get_webview_window("main"){let _=window.hide();}
 let app=app.clone();
 tauri::async_runtime::spawn(async move{
  let backend=app.state::<Backend>();
  let updater=app.state::<AppUpdater>();
  let ready=if let Some(update)=updater.ready(false){
   updater.read_installer(&app,&update).await.ok().map(|bytes|(update,bytes))
  }else{None};
  if backend.call("shutdown",json!({})).await.is_ok(){
   if let Some((update,bytes))=ready{
    backend.stop_child();
    updater.launch(&app,update,bytes,false).await;
   }
  }
  app.exit(0);
 });
}
async fn install_app_update(app:&tauri::AppHandle,state:&Backend)->Result<Value,String>{
 if state.closing.swap(true,Ordering::AcqRel){return Err("应用正在退出".into());}
 let updater=app.state::<AppUpdater>();
 let prepared=async{
  let update=updater.ready(true).ok_or("当前没有已验证的更新包")?;
  let bytes=updater.read_installer(app,&update).await?;
  state.call("app:shutdownForUpdate",json!({})).await?;
  Ok::<_,String>((update,bytes))
 }.await;
 match prepared{
  Ok((update,bytes))=>{
   state.stop_child();
   updater.launch(app,update,bytes,true).await;
   Ok(Value::Null)
  },
  Err(error)=>{state.closing.store(false,Ordering::Release);Err(error)}
 }
}
#[tauri::command]
async fn desktop_call(app:tauri::AppHandle,state:tauri::State<'_,Backend>,method:String,params:Option<Value>)->Result<Value,String>{
 let p=params.unwrap_or_else(||json!({}));
 match method.as_str(){
  "window:close"=>{request_shutdown(&app);Ok(Value::Null)},
  "app:updateStatus"=>Ok(app.state::<AppUpdater>().status()),
  _ if state.closing.load(Ordering::Acquire)=>Err("应用正在退出".into()),
  "app:checkUpdate"=>Ok(app.state::<AppUpdater>().check(&app,true).await),
  "app:installUpdate"=>install_app_update(&app,&state).await,
  "settings:save"=>{
   let saved=state.call(&method,p).await?;
   app.state::<AppUpdater>().set_automatic(&app,saved["autoAppUpdate"].as_bool()!=Some(false));
   Ok(saved)
  },
  "dialog:directory"|"dialog:executable"|"dialog:database"=>{let directory=method=="dialog:directory";let database=method=="dialog:database";let file=tauri::async_runtime::spawn_blocking(move||if directory{rfd::FileDialog::new().pick_folder()}else if database{rfd::FileDialog::new().add_filter("ZCode 数据库",&["sqlite","sqlite3","db"]).pick_file()}else{rfd::FileDialog::new().add_filter("程序",&["exe","js","mjs","cjs"]).pick_file()}).await.map_err(|e|e.to_string())?;Ok(file.map(|v|json!(v)).unwrap_or(Value::Null))},
  "path:open"=>{let path=PathBuf::from(p["path"].as_str().ok_or("无效路径")?);if !path.is_absolute(){return Err("只能打开本地绝对路径".into());}Command::new("explorer.exe").arg(path).creation_flags(0x08000000).spawn().map_err(|e|e.to_string())?;Ok(Value::Null)},
  "browser:preview"=>browser_preview::dispatch(app,state.root.join("web-preview"),p).await,
  "link:open"=>{
   let url=browser_preview::web_url(p["url"].as_str().ok_or("无效链接")?)?;
   Command::new("explorer.exe").arg(url.as_str()).creation_flags(0x08000000).spawn().map_err(|e|e.to_string())?;
   Ok(Value::Null)
  },
  "agent:login" => {
   let env_key = match p["harness"].as_str() {
    Some("kimi") => "KIMI_CODE_HOME",
    Some("codex") => "CODEX_HOME",
    _ => return Err("当前 Harness 不使用独立登录".into()),
   };
   let command = state.call("agent:login", p).await?;
   let executable = PathBuf::from(command["executable"].as_str().ok_or("无效的登录程序")?);
   let home = PathBuf::from(command["home"].as_str().ok_or("无效的登录目录")?);
   let args = command["args"].as_array().ok_or("无效的登录参数")?.iter()
    .map(|value| value.as_str().ok_or("无效的登录参数")).collect::<Result<Vec<_>, _>>()?;
   if !executable.is_absolute() || !home.is_absolute() {
    return Err("登录程序和目录必须是绝对路径".into());
   }
   let mut child = Command::new(executable);
   child.args(args).current_dir(&home).env(env_key, &home).env_remove("ELECTRON_RUN_AS_NODE");
   if env_key == "CODEX_HOME" { child.env("CODEX_SQLITE_HOME", &home); }
   child.creation_flags(0x00000010).spawn().map_err(|error| error.to_string())?;
   Ok(Value::Null)
  },
  "context:export"=>{let source=state.call("context:path",p).await?;let source=source.as_str().ok_or("本轮结束后才会生成上下文")?.to_owned();let dest=tauri::async_runtime::spawn_blocking(||rfd::FileDialog::new().set_file_name("context.entrotect.json").add_filter("统一上下文",&["json"]).save_file()).await.map_err(|e|e.to_string())?;if let Some(dest)=dest{std::fs::copy(source,&dest).map_err(|e|e.to_string())?;Ok(json!(dest))}else{Ok(Value::Null)}},
  _=>state.call(&method,p).await
 }
}
fn main(){
 let mut context=tauri::generate_context!();
 // Independent data profiles need independent instance locks and WebView stores.
 // The default profile keeps the original application identifier.
 if let Some(root)=std::env::var_os("ENTROTECT_DATA_DIR") {
  use std::hash::{Hash,Hasher};
  let root=PathBuf::from(root);let root=if root.is_absolute(){root}else{std::env::current_dir().unwrap().join(root)};
  let _=std::fs::create_dir_all(&root);let root=std::fs::canonicalize(&root).unwrap_or(root);
  let mut hash=std::collections::hash_map::DefaultHasher::new();root.to_string_lossy().to_lowercase().hash(&mut hash);
  context.config_mut().identifier=format!("app.entrotect.desktop.profile-{:x}",hash.finish());
 }
 let builder=tauri::Builder::default().plugin(tauri_plugin_single_instance::init(|app,_,_|{if let Some(w)=app.get_webview_window("main"){let _=w.unminimize();let _=w.set_focus();}}));
 let builder=if context.config().plugins.0.contains_key("updater"){
  builder.plugin(tauri_plugin_updater::Builder::new().build())
 }else{builder};
 builder.setup(|app|{let backend=Backend::start(app.handle())?;let updater=AppUpdater::new(app.handle(),&backend.root);app.manage(backend);app.manage(updater);AppUpdater::start(app.handle().clone());Ok(())})
 .on_page_load(|webview,payload|{if webview.label()=="main"&&matches!(payload.event(),tauri::webview::PageLoadEvent::Started){browser_preview::close_all();}})
 .on_window_event(|window,event|{if let tauri::WindowEvent::CloseRequested{api,..}=event{api.prevent_close();request_shutdown(window.app_handle());}})
 .invoke_handler(tauri::generate_handler![desktop_call])
 .build(context).expect("Tauri 启动失败")
 .run(|app,event|{if let tauri::RunEvent::Exit=event{if let Some(state)=app.try_state::<Backend>(){let _=state.child.lock().unwrap().kill();}}});
}

#[cfg(test)] mod tests{#[test] fn windows_credentials_round_trip(){let encrypted=super::crypt("protect","test-not-a-real-key").unwrap();assert_ne!(encrypted,"test-not-a-real-key");assert_eq!(super::crypt("unprotect",&encrypted).unwrap(),"test-not-a-real-key");}}
