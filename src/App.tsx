import { useI18n } from './i18n';
import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Activity, ArrowUp, ArrowUpRight, Check, CheckCheck, ChevronDown, ChevronRight, Download, FileJson2, FolderOpen, FolderPlus, History, House, LoaderCircle, Ellipsis, PanelLeftOpen, PanelLeftClose, PanelRightOpen, PanelRightClose, RefreshCw, Settings2, ShieldCheck, Square, SquarePen, Terminal, X } from 'lucide-react';
import { accentColors, defaultAccent, type AccentColor } from '../shared/appearance';
import { activeRunStates, agentHarnesses, harnesses, type AgentHarness, type AppUpdateStatus, type Approval, type Bootstrap, type ContextDetails, type Conversation, type DisplayItem, type Harness, type HistoryExportScope, type NativeModelCatalog, type Theme } from '../shared/types';
import { catalogModel, catalogModelId, connectionFor, defaultModel, harnessNames as names, isAgentHarness, modelHarness, nativeModel } from '../shared/harnesses';
import { projectKey, projectName } from '../shared/project-path';
import type { PreviewLink } from '../shared/preview-link';
import { api, message } from './api';
import { ChatMarkdown, chatPreviewLink } from './ChatMarkdown';
import type { SettingsTab } from './SettingsDialog';
import {WindowControls} from './WindowControls';
import {ModelIcon,HarnessIcon} from './BrandIcon';
import {HistoryDialog} from './HistoryDialog';
import {HistoryExportDialog} from './HistoryExportDialog';
import {modelReasoning,reasoningKey} from '../shared/reasoning';
import { CommandInput } from './CommandInput';
import { ProjectList } from './ProjectList';
import { ProjectDialog } from './ProjectDialog';
import { ReasoningControl } from './ReasoningControl';
import { ComposerUsage, useAccountUsage } from './Usage';
import { AppUpdateLog, AppUpdateReminder } from './AppUpdateNotice';
import { WorkspaceLayout } from './WorkspaceLayout';

const SettingsDialog=lazy(()=>import('./SettingsDialog').then(module=>({default:module.SettingsDialog})));
const ProjectSidebar=lazy(()=>import('./ProjectSidebar').then(module=>({default:module.ProjectSidebar})));
const labels={idle:'就绪',starting:'正在启动',running:'正在工作',waiting:'等待你的回复',stopping:'正在暂停',syncing:'正在保存上下文',error:'需要处理'};
function displayTitle(t: import('./i18n').Translate, chat?: Conversation) {
 return !chat?.title || (chat.title === '新对话' && !chat.revision && !chat.importedFrom) ? t('新对话') : chat.title;
}
const messageTimes = {
 'zh-CN': new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }),
 en: new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit' }),
};
const noProjects: string[] = [];
function Logo(){return <svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M7 5h18v5H12v4h11v5H12v4h13v5H7V5Z" fill="currentColor"/><path d="M21 10h4v13h-4z" fill="currentColor" opacity=".28"/></svg>}
export function App(){
 const { t, setLanguage } = useI18n();
 const [boot,setBoot]=useState<Bootstrap|null>(null),[chats,setChats]=useState<Conversation[]>([]),[id,setId]=useState<string|null>(null),[items,setItems]=useState<DisplayItem[]>([]);
 const idRef=useRef<string|null>(null),bottom=useRef<HTMLDivElement>(null),follow=useRef(true);
 const [workspace,setWorkspace]=useState(''),[draft,setDraft]=useState(''),[error,setError]=useState(''),[pending,setPending]=useState(false);
 const [model,setModel]=useState('deepseek-flash'),[override,setOverride]=useState<'auto'|Harness>('auto');
 const [browseModels,setBrowseModels]=useState(false),[nativeCatalogs,setNativeCatalogs]=useState(() => new Map<string, NativeModelCatalog>());
 const [settings,setSettings]=useState<SettingsTab|null>(null),[inspector,setInspector]=useState<boolean|null>(null),[sidebar,setSidebar]=useState(true),[contextOpen,setContextOpen]=useState(false);
 const [sidebarLink,setSidebarLink]=useState<{project:string;target:PreviewLink}>();
 const [themePreview,setThemePreview]=useState<Theme>(),[accentPreview,setAccentPreview]=useState<AccentColor>(),[projectOpen,setProjectOpen]=useState(false);
 const [appUpdate,setAppUpdate]=useState<AppUpdateStatus>(),[updateLogOpen,setUpdateLogOpen]=useState(false);
 const [sessionMenu,setSessionMenu]=useState(false),[logsOpen,setLogsOpen]=useState(false);
 const [historyOpen,setHistoryOpen]=useState<'import'|'export'|null>(null);
 const [historyScope,setHistoryScope]=useState<HistoryExportScope|null>(null);
 const [historyExportId,setHistoryExportId]=useState<string>(),[draftReasoning,setDraftReasoning]=useState<Record<string,string>>({});
 const contentVersion=useRef(0);
 const queuedItems=useRef(new Map<string, DisplayItem>());
 const itemFrame=useRef(0);
 const [approvals,setApprovals]=useState<Approval[]>([]),[answer,setAnswer]=useState(''),[logs,setLogs]=useState<string[]>([]);
 const c=chats.find(c=>c.id===id),busy=!!c&&activeRunStates.has(c.state);
 const models = [...new Set(harnesses.map(harness => defaultModel(boot?.settings, harness)))];
 const preferred=(m:string):Harness=>modelHarness(boot?.settings,m)??c?.harness??'deepseek';
 const selected=c?.modelId||(c?defaultModel(boot?.settings,c.harness):model);
 const mode=c?(c.harnessMode==='manual'?c.harness:'auto'):override;
 const harness=c?.harness||(override==='auto'?preferred(model):override);
 const runtime=boot?.health.find(entry=>entry.harness===harness);
 const directory=c?.workspace||workspace;
 const sidebarWorkspace=c?.workspaceMissing?'':directory;
 const sidebarProject=projectKey(sidebarWorkspace);
 const catalogScope = JSON.stringify([projectKey(directory), boot?.settings.agents]);
 const catalogKey = (engine: AgentHarness, id: string) => JSON.stringify([catalogScope, engine, id]);
 const nativeCatalog = isAgentHarness(harness) ? nativeCatalogs.get(catalogKey(harness, selected)) : undefined;
 const capability=nativeCatalog?.reasoning??boot?.reasoning.find(r=>r.modelId===selected&&r.harness===harness)??modelReasoning(selected,harness);
 const chosenReasoning=(c?.reasoningByModel||draftReasoning)[reasoningKey(selected,harness)]||'';
 const configuredReasoning=capability.levels.find(level=>level.nativeValue===connectionFor(boot?.settings,harness)?.reasoning)?.label;
 const reading=c?.contextUsage;
 const currentContext=reading&&reading.harness===harness&&reading.revision===c?.revision&&reading.modelId.toLowerCase()===selected.toLowerCase()?reading:undefined;
 const usage=useAccountUsage(boot?.settings,harness);
 const theme=themePreview??boot?.settings.theme??'light';
 const accent=accentPreview??boot?.settings.accentColor??defaultAccent;
 const transcript=useMemo(()=>items.map(item=><Message key={item.id} item={item}/>),[items]);
 function openChatLink(event:MouseEvent<HTMLDivElement>){
  if(event.button>1||!(event.target instanceof Element))return;
  const anchor=event.target.closest<HTMLAnchorElement>('.message-body a[href]');
  const target=chatPreviewLink(anchor?.getAttribute('href')||'');
  if(!target)return;
  event.preventDefault();
  setSidebarLink({project:sidebarProject,target});
  setInspector(true);
 }
 function clearItemQueue(){
  cancelAnimationFrame(itemFrame.current);itemFrame.current=0;queuedItems.current.clear();
 }
 function replaceItems(next:DisplayItem[]){
  clearItemQueue();setItems(next);
 }
 function flushItems(){
  if(!queuedItems.current.size)return;
  const updates=new Map(queuedItems.current);
  clearItemQueue();
  setItems(old=>{
   const next=old.map(item=>updates.get(item.id)??item);
   const existing=new Set(old.map(item=>item.id));
   for(const item of updates.values())if(!existing.has(item.id))next.push(item);
   return next;
  });
 }
 useEffect(() => {
  if (!boot || !directory || busy || !api?.nativeModels) return;
  const targets = new Map<AgentHarness, string>();
  if (browseModels) for (const row of boot.health) if (row.available && isAgentHarness(row.harness)) targets.set(row.harness, defaultModel(boot.settings, row.harness));
  if (isAgentHarness(harness) && boot.health.some(row => row.harness === harness && row.available)) targets.set(harness, selected);
  let active = true;
  for (const [engine, modelId] of targets) {
   const key = catalogKey(engine, modelId);
   if (nativeCatalogs.has(key)) continue;
   void api.nativeModels({ harness: engine, workspace: directory, modelId }).then(catalog => {
    if (!active) return;
    setNativeCatalogs(previous => {
     const next = new Map(previous).set(key, catalog);
     if (next.size > 64) next.delete(next.keys().next().value!);
     return next;
    });
   }).catch(() => {});
  }
  return () => { active = false; };
 }, [browseModels, boot?.settings, boot?.health, catalogScope, selected, harness, busy]);
 useLayoutEffect(()=>{
  const system=matchMedia('(prefers-color-scheme: dark)');
  const root=document.documentElement;
  const palette=accentColors[accent];
  let frame=0;
  const apply=()=>{
   const next=theme==='system'?(system.matches?'dark':'light'):theme;
   if(root.dataset.theme===next&&root.dataset.accent===accent)return;
   cancelAnimationFrame(frame);
   root.dataset.themeSwitching='';
   root.dataset.theme=next;
   root.dataset.accent=accent;
   root.style.setProperty('--accent',palette.wash);
   root.style.setProperty('--accent-light-ink',palette.lightInk);
   root.style.setProperty('--accent-dark-ink',palette.darkInk);
   root.style.setProperty('--accent-fill',palette.fill);
   root.style.setProperty('--accent-title',palette.title);
   frame=requestAnimationFrame(()=>{frame=requestAnimationFrame(()=>delete root.dataset.themeSwitching);});
  };
  apply();if(theme==='system')system.addEventListener('change',apply);
  return()=>{system.removeEventListener('change',apply);cancelAnimationFrame(frame);delete root.dataset.themeSwitching;};
 },[theme,accent]);
 async function refresh(){
  if(!api)return;
  const next=await api.bootstrap();
  setLanguage(next.settings.language??'system');
  const startup=boot?undefined:next.startupRoute;
  const resumed=startup?.conversationId?await api.loadConversation(startup.conversationId).catch(()=>undefined):undefined;
  if(resumed){
   idRef.current=resumed.conversation.id;
   setId(resumed.conversation.id);
   replaceItems(resumed.items);
  }
  setBoot(next);
  setChats(resumed?next.conversations.map(chat=>chat.id===resumed.conversation.id?resumed.conversation:chat):next.conversations);
  setWorkspace(old=>old||next.settings.defaultWorkspace);
  if(startup){
   const model=defaultModel(next.settings,startup.harness);
   setModel(model);
   if(modelHarness(next.settings,model)!==startup.harness)setOverride(startup.harness);
  }else setModel(old=>catalogModel(old) ? old : defaultModel(next.settings,modelHarness(boot?.settings,old)??'deepseek'));
 }
 useEffect(()=>{
  let mounted=true, receivedUpdate=false;
  void refresh().catch(e=>setError(message(e)));
  const unsubscribe=api?.onEvent(event=>{
  if(event.type==='app-update'){receivedUpdate=true;setAppUpdate(event.status);}
  if(event.type==='conversation'){
   if(event.conversation.id===idRef.current&&!activeRunStates.has(event.conversation.state))flushItems();
   setChats(old=>[event.conversation,...old.filter(c=>c.id!==event.conversation.id)].sort((a,b)=>b.updatedAt-a.updatedAt));
  }
  if(event.type==='item'&&event.conversationId===idRef.current){
   contentVersion.current++;queuedItems.current.set(event.item.id,event.item);
   if(!itemFrame.current)itemFrame.current=requestAnimationFrame(flushItems);
  }
  if(event.type==='approval')setApprovals(old=>[...old,event.approval]);
  if(event.type==='approval-cleared')setApprovals(old=>old.filter(a=>a.id!==event.id));
  if(event.type==='diagnostic'&&event.conversationId===idRef.current)setLogs(old=>[...old.slice(-12),event.message]);
  if(event.type==='history-sync')setBoot(old=>old?{...old,historySync:event.status}:old);
  if(event.type==='history-updated'&&event.conversation.id===idRef.current){const ticket=++contentVersion.current;void api!.loadConversation(event.conversation.id).then(data=>{if(ticket===contentVersion.current&&data.conversation.id===idRef.current)replaceItems(data.items);}).catch(e=>setError(message(e)));}
  });
  void api?.appUpdateStatus?.().then(status=>{if(mounted&&!receivedUpdate)setAppUpdate(status);}).catch(()=>{});
  return()=>{mounted=false;unsubscribe?.();clearItemQueue();};
 },[]);
 const runtimeReady=!!boot;
 useEffect(()=>{
  if(runtimeReady&&(!id||c))void api?.rememberRuntime({harness,conversationId:id??undefined}).catch(()=>{});
 },[runtimeReady,id,harness]);
 useEffect(()=>{
  if(!follow.current)return;
  const frame=requestAnimationFrame(()=>{if(follow.current)bottom.current?.scrollIntoView({behavior:'instant',block:'end'});});
  return()=>cancelAnimationFrame(frame);
 },[items,busy]);
 const newChat=useCallback((project=directory)=>{
  if(pending)return;
  contentVersion.current++;idRef.current=null;setId(null);setWorkspace(project);
  replaceItems([]);setDraft('');setError('');setLogs([]);setOverride('auto');
  setSidebarLink(undefined);
  setSessionMenu(false);setContextOpen(false);setLogsOpen(false);
 },[pending,directory]);
 useEffect(()=>{
  const key=(e:KeyboardEvent)=>{if(e.ctrlKey&&e.key.toLowerCase()==='n'&&!settings&&!projectOpen&&!historyOpen&&!historyScope&&!contextOpen&&!logsOpen&&!updateLogOpen&&!approvals.length){e.preventDefault();newChat();}};
  window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);
 },[directory,pending,settings,projectOpen,historyOpen,historyScope,contextOpen,logsOpen,updateLogOpen,approvals.length]);
 const load=useCallback(async(chat:Conversation)=>{
  if(!api||pending)return;
  contentVersion.current++;setPending(true);setError('');
  try{
   const data=await api.loadConversation(chat.id);
   if(projectKey(data.conversation.workspace)!==projectKey(directory))setDraft('');
   idRef.current=chat.id;setId(chat.id);replaceItems(data.items);setLogs([]);setSidebarLink(undefined);follow.current=true;
  }catch(e){setError(message(e));}finally{setPending(false);}
 },[pending,directory]);
 const addProject=useCallback(()=>setProjectOpen(true),[]);
 const selectProject=useCallback((project:string)=>{if(projectKey(project)!==projectKey(directory)||c?.workspaceMissing)newChat(project);},[directory,c?.workspaceMissing,newChat]);
 const syncProject=useCallback((workspace:string)=>setHistoryScope({kind:'project',workspace}),[]);
 async function route(nextModel:string,nextMode:'auto'|Harness){if(busy||pending)return;setPending(true);setError('');try{if(c){const changed=await api!.selectModel(c.id,nextModel,nextMode==='auto'?undefined:nextMode);setChats(old=>old.map(v=>v.id===changed.id?changed:v));const loaded=await api!.loadConversation(c.id);replaceItems(loaded.items);}setModel(nextModel);setOverride(nextMode);}catch(e){setError(message(e));}finally{setPending(false);}}
 async function reasoning(level:string){if(busy||pending)return;setPending(true);setError('');try{if(c){const changed=await api!.selectReasoning(c.id,level||undefined);setChats(old=>old.map(v=>v.id===changed.id?changed:v));}else setDraftReasoning(old=>({...old,[reasoningKey(selected,harness)]:level}));}catch(e){setError(message(e));}finally{setPending(false);}}
 async function send(){
  if(!draft.trim()||draft.trim()==='/'||busy||pending||!api)return;
  contentVersion.current++;
  const text=draft;
  let chat=c;
  setPending(true);setError('');
  try{
   if(!chat){
    chat=await api.createConversation(workspace,harness);
    idRef.current=chat.id;setId(chat.id);setChats(old=>[chat!,...old]);
    await api.selectModel(chat.id,model,override==='auto'?undefined:override);
    if(chosenReasoning)await api.selectReasoning(chat.id,chosenReasoning);
   }
   if(chat.workspaceMissing)throw new Error(t("请先为这条历史对话选择项目目录"));
   setDraft(old=>old===text?'':old);follow.current=true;
   await api.send(chat.id,text);
  }catch(e){
   if(!chat||idRef.current===chat.id){setDraft(old=>old||text);setError(message(e));}
  }finally{setPending(false);}
 }
 function rememberProject(project:string){
  setBoot(old=>old&&!old.projects.some(value=>projectKey(value)===projectKey(project))?{...old,projects:[project,...old.projects]}:old);
 }
 function closeSettings(){setSettings(null);setThemePreview(undefined);setAccentPreview(undefined);}
 async function choose(){
  if(!api||pending||busy)return;
  setPending(true);setError('');
  try{
   const value=await api.chooseDirectory();
   if(!value)return;
   if(c){
    if(!c.workspaceMissing&&projectKey(c.workspace)===projectKey(value))return;
    const changed=await api.relocateConversation(c.id,value);
    setChats(old=>old.map(v=>v.id===changed.id?changed:v));
   }else{
    const project=await api.addProject(value);
    rememberProject(project);setWorkspace(project);
   }
  }catch(e){setError(message(e));}finally{setPending(false);}
 }
 const approval=approvals.find(a=>a.conversationId===id);
 useEffect(()=>{const close=(e:PointerEvent)=>{if(!(e.target as HTMLElement).closest('.session-menu-wrap'))setSessionMenu(false);};const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){setSessionMenu(false);setLogsOpen(false);}};window.addEventListener('pointerdown',close);window.addEventListener('keydown',key);return()=>{window.removeEventListener('pointerdown',close);window.removeEventListener('keydown',key);};},[]);
 const dialogOpen=!!(projectOpen||historyOpen||historyScope||contextOpen||logsOpen||approval);
 return <div className="app">
  <div className="titlebar" data-tauri-drag-region>
   <div className="brand" data-tauri-drag-region><span className="brand-icon" data-tauri-drag-region><Logo/></span><strong data-tauri-drag-region>EntroTect</strong></div>
   <WindowControls onError={setError}/>
  </div>
  <div className="desktop-shell">
   <nav className="app-rail" aria-label={t("桌面导航")} inert={dialogOpen}>
    <button className={`rail-button ${settings?'':'selected'}`} title={t("工作区")} aria-current={settings?undefined:'page'} onClick={()=>{closeSettings();setSidebar(true);}}><House size={19}/></button>
    <button className="rail-button" title={t("新建或打开项目")} disabled={!boot||pending||!!settings} onClick={()=>setProjectOpen(true)}><FolderPlus size={19}/></button>
    <button className="rail-button" title={t("导入历史对话")} disabled={!boot||pending||!!settings} onClick={()=>setHistoryOpen('import')}><History size={19}/></button>
    <div className="rail-spacer"/>
    {(!sidebar||settings)&&<AppUpdateReminder update={appUpdate} compact onOpen={()=>setUpdateLogOpen(true)}/>}
    <button className={`rail-button ${settings?'selected':''}`} title={t("设置与连接")} aria-current={settings?'page':undefined} disabled={!boot||!!settings} onClick={()=>setSettings('general')}>
     <Settings2 size={19}/>{!!boot?.historySync.issues.length&&<span className="sync-warning" title={t("{0} 项暂未同步", boot.historySync.issues.length)}/>}
    </button>
   </nav>
   <div className="desktop-stage">
    <WorkspaceLayout leftOpen={sidebar} rightOpen={!!inspector} hidden={!!settings} inactive={dialogOpen||updateLogOpen}
     right={inspector!==null&&<Suspense fallback={<aside className="project-sidebar"><div className="project-opening" role="status"><LoaderCircle size={14} className="spin"/>{t("正在打开项目侧栏…")}</div></aside>}>
       <ProjectSidebar key={sidebarProject} workspace={sidebarWorkspace} revision={c?.lastSyncAt}
        active={!!inspector&&!settings&&!dialogOpen&&!updateLogOpen} onChoose={()=>void choose()} canChoose={!busy&&!pending}
        link={sidebarLink?.project===sidebarProject?sidebarLink.target:undefined}/>
     </Suspense>}
     left={
      <aside className="sidebar" aria-label={t("项目与对话")}>
       <div className="sidebar-head">
        <strong>{t("工作区")}</strong>
        <button className="icon-button" title={t("收起侧边栏")} aria-label={t("收起侧边栏")} aria-expanded={true} onClick={()=>setSidebar(false)}><PanelLeftClose size={17}/></button>
       </div>
       <button className="new-chat" disabled={pending} onClick={()=>newChat()}><SquarePen size={16}/>{t("新对话")}<kbd>Ctrl N</kbd></button>
       <ProjectList directories={boot?.projects??noProjects} conversations={chats} directory={directory} selectedId={id}
        disabled={!api||pending} onAdd={addProject} onSelect={selectProject}
        onNewChat={newChat} onOpenChat={load} onSync={syncProject}/>
       {sidebar&&!settings&&<AppUpdateReminder update={appUpdate} onOpen={()=>setUpdateLogOpen(true)}/>}
      </aside>
     }>
     <main className="main">
      <header className="main-header">
       <div className="breadcrumbs">
        {!sidebar&&<button className="icon-button" title={t("展开侧边栏")} aria-label={t("展开侧边栏")} aria-expanded={false} onClick={()=>setSidebar(true)}><PanelLeftOpen size={17}/></button>}
        <button className="project-crumb" disabled={busy||pending||!api} onClick={()=>void choose()} title={directory||t("选择工作目录")}>
         <FolderOpen size={16}/><span>{c?.workspaceMissing?t("选择工作目录"):directory?projectName(directory):t("选择工作目录")}</span>
        </button>
        <ChevronRight size={13}/><strong title={displayTitle(t,c)}>{displayTitle(t,c)}</strong>
       </div>
       <div className="header-actions">
        <button type="button" className="active-harness" aria-label={t("配置 {0}", names[harness])}
         title={runtime?.available===false?t(runtime.detail):t("配置 {0}", names[harness])} disabled={!boot||pending} onClick={()=>setSettings(harness)}>
         <HarnessIcon h={harness}/><span>{names[harness]}</span>{runtime?.available===false&&<i className="harness-attention" aria-hidden="true"/>}
        </button>
        <div className="session-menu-wrap">
         <button className="icon-button" title={t("会话菜单")} aria-expanded={sessionMenu} disabled={!c} onClick={()=>setSessionMenu(!sessionMenu)}><Ellipsis size={19}/></button>
         <div className="popover session-menu" role="menu" inert={!sessionMenu}>
          <button role="menuitem" disabled={pending||!c} onClick={()=>{if(c)setHistoryScope({kind:'conversation',id:c.id});setSessionMenu(false);}}><RefreshCw size={14}/>{t("设置对话同步")}</button>
          <button role="menuitem" disabled={busy||pending||!c?.revision} onClick={()=>{setHistoryExportId(id||undefined);setHistoryOpen('export');setSessionMenu(false);}}><ArrowUpRight size={14}/>{t("在独立 Harness 中继续")}</button>
          <button role="menuitem" disabled={!c?.canonicalPath||busy||pending} onClick={()=>{setContextOpen(true);setSessionMenu(false);}}><FileJson2 size={14}/>{t("查看统一上下文")}</button>
          <button role="menuitem" disabled={!c?.canonicalPath||busy||pending} onClick={()=>{setSessionMenu(false);void api?.exportContext(id!).catch(e=>setError(message(e)));}}><Download size={14}/>{t("导出上下文")}</button>
          <button role="menuitem" onClick={()=>{setLogsOpen(true);setSessionMenu(false);}}><Terminal size={14}/>{t("执行器日志")}</button>
         </div>
        </div>
        <button className={`icon-button ${inspector?'active':''}`} title={inspector?t("收起项目侧栏"):t("展开项目侧栏")}
         aria-label={inspector?t("收起项目侧栏"):t("展开项目侧栏")} aria-expanded={!!inspector} onClick={()=>setInspector(!inspector)}>
         {inspector?<PanelRightClose size={18}/>:<PanelRightOpen size={18}/>}
        </button>
       </div>
      </header>
      <div className="chat-scroll" onClick={openChatLink} onAuxClick={openChatLink}
       onScroll={event=>{const area=event.currentTarget;follow.current=area.scrollHeight-area.scrollTop-area.clientHeight<130;}}>
       {!items.length?<div className="welcome">
        <div className="welcome-mark"><Logo/></div>
        <h1>{t("想法，从这里展开。")}</h1>
        {directory?<button className="welcome-workspace" disabled={!api||pending||busy} onClick={()=>void choose()} title={directory}>
         <FolderOpen size={16}/><span>{projectName(directory)}</span><ChevronDown size={13}/>
        </button>:<button className="welcome-workspace" disabled={!api||pending} onClick={()=>setProjectOpen(true)}><FolderPlus size={16}/>{t("打开或创建项目")}</button>}
       </div>:<div className="messages">
        {transcript}
        {busy&&<div className="working"><LoaderCircle size={15} className="spin"/>{t(labels[c!.state])}<span>{names[harness]}</span></div>}
        <div ref={bottom}/>
       </div>}
      </div>
      <div className="composer-area">
       {(error||c?.error)&&<div className="error-banner" role="alert">{t(error||c?.error)}</div>}
       {!api&&<div className="preview-note">{t("通过 Tauri 桌面程序运行任务")}</div>}
       <div className="composer-meta">
        <span className="conversation-state" role="status" aria-label={t("运行状态")}><span className={`live-dot ${busy?'busy':''}`}/>{pending&&!busy?t("正在准备"):c?t(labels[c.state]):t("等待任务")}</span>
        <ComposerUsage context={currentContext} harness={harness} usage={usage} onSettings={()=>{if(boot)setSettings('usage');}}/>
       </div>
       <div className="composer">
        <CommandInput value={draft} onChange={setDraft} onSend={()=>void send()}
         scope={{harness,workspace:directory,modelId:selected,id:id??undefined}}
         cacheScope={JSON.stringify([connectionFor(boot?.settings,harness),runtime?.executable,c?.bindings[harness]?[c.id,c.bindings[harness]?.sessionId]:null])}
         disabled={busy||pending||!!c?.workspaceMissing}/>
        <div className="composer-controls">
         <div className="composer-route">
          <div className="control-select">
           <ModelIcon family={preferred(selected)}/>
           <select aria-label={t("选择模型")} title={nativeCatalog?.currentModel ?? nativeModel(selected) ?? names[harness]} disabled={busy||pending} value={selected} onFocus={()=>setBrowseModels(true)} onChange={e=>void route(e.target.value,'auto')}>
            {(!models.includes(selected)&&!catalogModel(selected)?[selected,...models]:models).map(value=><option key={value} value={value}>{nativeModel(value)??t("{0} · 默认模型", names[preferred(value)])}</option>)}
            {agentHarnesses.map(engine => {
             const known = nativeCatalogs.get(catalogKey(engine, defaultModel(boot?.settings, engine)))?.models ?? [];
             const active = engine === harness ? nativeCatalog?.models ?? [] : [];
             const options = new Map([...known, ...active].map(option => [catalogModelId(engine, option.id), option.label]));
             if (catalogModel(selected)?.harness === engine && !options.has(selected)) options.set(selected, nativeModel(selected)!);
             return options.size > 0 && <optgroup label={names[engine]} key={engine}>{[...options].map(([value,label])=><option key={value} value={value}>{label}</option>)}</optgroup>;
            })}
           </select><ChevronDown size={12}/>
          </div>
          <div className="control-select harness-select">
           <HarnessIcon h={harness}/>
           <select aria-label={t("选择 Harness")} title={mode==='auto'?t("自动匹配 · {0}", names[harness]):t("手动选择 · {0}", names[harness])} disabled={busy||pending} value={mode} onChange={e=>void route(selected,e.target.value as 'auto'|Harness)}>
            <option value="auto">{t("自动 ·")}{" "}{names[preferred(selected)]}</option>{harnesses.map(value=><option key={value} value={value}>{names[value]}</option>)}
           </select><ChevronDown size={12}/>
          </div>
         </div>
         <div className="composer-actions">
          {capability.levels.length>0&&<ReasoningControl key={reasoningKey(selected,harness)} modelId={nativeCatalog?.currentModel??nativeModel(selected)??selected} levels={capability.levels} value={chosenReasoning} fallback={configuredReasoning} disabled={busy||pending} onChange={level=>void reasoning(level)}/>}
          {busy?<button className="send-button" title={t("暂停任务")} aria-label={t("暂停任务")} onClick={()=>void api?.stop(id!).catch(e=>setError(message(e)))}><Square size={11} fill="currentColor"/></button>
           :<button className="send-button" title={t("发送任务（Enter）")} aria-label={t("发送任务")} disabled={!directory||!draft.trim()||draft.trim()==='/'||pending||!api||!!c?.workspaceMissing} onClick={()=>void send()}>
            {pending?<LoaderCircle size={15} className="spin"/>:<ArrowUp size={16}/>}
           </button>}
         </div>
        </div>
       </div>
       {mode!=='auto'&&harness!==preferred(selected)&&<div className="composer-footer">{t("使用手动 Harness 的连接设置，服务端需支持当前模型")}</div>}
      </div>
     </main>
    </WorkspaceLayout>
    {settings&&boot&&<Suspense fallback={<div className="project-opening" role="status"><LoaderCircle size={14} className="spin"/>{t("正在打开设置…")}</div>}>
     <SettingsDialog settings={boot.settings} conversations={chats} currentId={id||undefined} initialTab={settings} currentHarness={harness} usage={usage}
     onThemePreview={setThemePreview} onAccentPreview={setAccentPreview} onClose={closeSettings} onSaved={refresh}
     appUpdate={appUpdate} onShowUpdateLog={()=>setUpdateLogOpen(true)}
     onImport={()=>{closeSettings();setHistoryOpen('import');}}
     onExport={exportId=>{closeSettings();setHistoryExportId(exportId);setHistoryOpen('export');}}/>
    </Suspense>}
   </div>
  </div>
  {updateLogOpen&&<AppUpdateLog update={appUpdate} onClose={()=>setUpdateLogOpen(false)}/>}
  {projectOpen&&<ProjectDialog onClose={()=>setProjectOpen(false)} onProject={project=>{rememberProject(project);newChat(project);setSidebar(true);setProjectOpen(false);}}/>}
  {historyOpen&&<HistoryDialog conversation={historyOpen==='export'?chats.find(v=>v.id===(historyExportId||id)):undefined} onClose={()=>setHistoryOpen(null)} onImported={chat=>{setHistoryOpen(null);void refresh().then(()=>load(chat));}}/>}
  {historyScope&&<HistoryExportDialog scope={historyScope} title={historyScope.kind==='project'?historyScope.workspace:chats.find(chat=>chat.id===historyScope.id)?.title??t("对话")} onClose={()=>setHistoryScope(null)}/>}
  {contextOpen&&c&&<ContextDialog key={c.id} id={c.id} revision={c.revision} onClose={()=>setContextOpen(false)}/>}
  {logsOpen&&<div className="modal-backdrop" onClick={()=>setLogsOpen(false)}><section className="context-modal logs-modal" role="dialog" aria-label={t("执行器日志")} onClick={e=>e.stopPropagation()}><header><div><Terminal size={18}/><strong>{t("执行器日志")}</strong></div><button className="icon-button" title={t("关闭日志")} onClick={()=>setLogsOpen(false)}><X size={18}/></button></header><pre>{logs.length?logs.join('\n'):t("当前会话暂无诊断日志。")}</pre></section></div>}
  {approval&&<div className="modal-backdrop"><section className="approval-modal"><ShieldCheck size={28}/><h2>{t(approval.title)}</h2><pre>{t(approval.detail)}</pre>{approval.kind==='question'&&<textarea placeholder={t("输入你的回答")} value={answer} onChange={e=>setAnswer(e.target.value)}/>}<footer><button className="secondary-button" onClick={()=>void api?.answerApproval(approval.id,false).catch(e=>setError(message(e)))}>{t("拒绝 / 取消")}</button><button className="primary-button" onClick={()=>void api?.answerApproval(approval.id,true,answer).then(()=>setAnswer('')).catch(e=>setError(message(e)))}>{approval.kind==='question'?t("提交回答"):t("仅允许本次")}</button></footer></section></div>}
 </div>;
}
function ContextDialog({id,revision,onClose}:{id:string;revision:number;onClose():void}){
 const { t } = useI18n();
 const [context,setContext]=useState<ContextDetails>(),[error,setError]=useState('');
 useEffect(()=>{
  let active=true;
  void api?.context(id).then(value=>{if(active)setContext(value);},e=>{if(active)setError(message(e));});
  return()=>{active=false;};
 },[id]);
 const text=useMemo(()=>context?JSON.stringify(context.canonical,null,2):'', [context]);
 return <div className="modal-backdrop" onClick={onClose}><section className="context-modal" role="dialog" aria-label={t("统一上下文")} onClick={e=>e.stopPropagation()}>
  <header><div><FileJson2 size={18}/><strong>{t("统一上下文")}</strong><span>{t("修订 {0}", revision)}</span></div><button className="icon-button" title={t("关闭上下文")} onClick={onClose}><X size={18}/></button></header>
  {context?.path&&<p>{context.path}</p>}{error&&<p role="alert">{t(error)}</p>}
  {context?<pre>{text}</pre>:!error&&<p role="status">{t("正在读取上下文…")}</p>}
  <footer><span>{t("完整归档与有效恢复上下文")}</span><button className="primary-button" onClick={()=>void api?.exportContext(id).catch(e=>setError(message(e)))}><Download size={14}/>{t("导出 JSON")}</button></footer>
 </section></div>;
}
const Message=memo(function Message({item}:{item:DisplayItem}){
 const { t, locale } = useI18n();
 if(item.kind==='notice')return <div className="notice"><CheckCheck size={13}/>{t(item.text)}</div>;
 if(item.kind==='tool'||item.kind==='reasoning'||item.kind==='command')return <details className={`tool-message ${item.kind}`}><summary>{item.kind==='reasoning'?<Activity size={14}/>:<Terminal size={14}/>}<span>{item.kind==='reasoning'?t("思考过程"):item.kind==='command'?'/'+(item.commandName||t("命令")):item.toolName||t("工具执行")}</span>{item.status==='running'?<LoaderCircle size={13} className="spin"/>:item.status==='error'?<X size={13}/>:<Check size={13}/>}<ChevronRight size={13}/></summary><div>{item.input&&<pre>{item.input}</pre>}{item.text&&<pre>{item.text}</pre>}</div></details>;
 const date=new Date(item.time);
 return <article className={`message ${item.kind}`}><div className="message-heading">{item.kind==='user'?<span className="user-avatar">{t("你")}</span>:<HarnessIcon h={item.harness}/>}<strong>{item.kind==='user'?t("你"):names[item.harness]}</strong><time>{Number.isFinite(date.getTime())?messageTimes[locale].format(date):''}</time></div><div className="message-body"><ChatMarkdown text={item.kind==='error'?t(item.text):item.text}/></div></article>;
});
