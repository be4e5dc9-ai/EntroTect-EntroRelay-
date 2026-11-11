use serde_json::{json, Value};
use std::{cell::RefCell, path::PathBuf, rc::Rc};
use tauri::{AppHandle, Emitter, Manager, Url};
use tokio::sync::oneshot;
use webview2_com::{
    take_pwstr, HistoryChangedEventHandler, LaunchingExternalUriSchemeEventHandler,
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2_18, COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED,
    },
    NavigationCompletedEventHandler, NavigationStartingEventHandler,
    NewWindowRequestedEventHandler, SourceChangedEventHandler,
};
use windows_core::Interface;
use wry::{
    dpi::{PhysicalPosition, PhysicalSize},
    PermissionResponse, Rect, WebContext, WebView, WebViewBuilder, WebViewExtWindows,
};

struct Browser {
    id: String,
    view: WebView,
    _context: WebContext,
}

// A child WebView2 controller belongs to the same UI thread as its parent window.
thread_local! {
    static BROWSER: RefCell<Option<Browser>> = const { RefCell::new(None) };
}

pub fn close_all() {
    let browser = BROWSER.with(|cell| cell.borrow_mut().take());
    drop(browser);
}

pub fn web_url(input: &str) -> Result<Url, String> {
    let url = Url::parse(input).map_err(|_| "请输入有效的网址")?;
    if matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some_and(|host| {
            !matches!(
                host.trim_end_matches('.'),
                "tauri.localhost" | "ipc.localhost" | "asset.localhost"
            )
        })
        && url.username().is_empty()
        && url.password().is_none()
    {
        Ok(url)
    } else {
        Err("只能打开有效的 HTTP 或 HTTPS 网址".into())
    }
}

#[derive(Default)]
struct Page {
    navigation: Option<u64>,
    pending_url: Option<String>,
    error: Option<&'static str>,
}

fn report(app: &AppHandle, id: &str, view: &ICoreWebView2, page: &Page) {
    let mut source = Default::default();
    let mut back = Default::default();
    let mut forward = Default::default();
    unsafe {
        let _ = view.Source(&mut source);
        let _ = view.CanGoBack(&mut back);
        let _ = view.CanGoForward(&mut forward);
    }
    let source = take_pwstr(source);
    let url = page.pending_url.as_deref().unwrap_or(&source);
    let _ = app.emit_to(
        "main",
        "entrotect:browser",
        json!({
            "id": id,
            "url": web_url(url).map(|url| url.to_string()).unwrap_or_default(),
            "loading": page.navigation.is_some(),
            "back": back.as_bool(),
            "forward": forward.as_bool(),
            "error": page.error
        }),
    );
}

fn subscribe(
    view: &ICoreWebView2,
    app: &AppHandle,
    id: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let page = Rc::new(RefCell::new(Page::default()));
    let report = {
        let (app, id, page) = (app.clone(), id.to_owned(), page.clone());
        Rc::new(move |view: &ICoreWebView2| report(&app, &id, view, &page.borrow()))
    };
    let mut token = 0;
    unsafe {
        view.Settings()?.SetIsWebMessageEnabled(false)?;
        if let Ok(extended) = view.cast::<ICoreWebView2_18>() {
            extended.add_LaunchingExternalUriScheme(
                &LaunchingExternalUriSchemeEventHandler::create(Box::new(|_, args| {
                    if let Some(args) = args {
                        args.SetCancel(true)?;
                    }
                    Ok(())
                })),
                &mut token,
            )?;
        }
        let started = report.clone();
        let loading = page.clone();
        view.add_NavigationStarting(
            &NavigationStartingEventHandler::create(Box::new(move |view, args| {
                if let (Some(view), Some(args)) = (view, args) {
                    let mut uri = Default::default();
                    args.Uri(&mut uri)?;
                    if let Ok(url) = web_url(&take_pwstr(uri)) {
                        let mut navigation = 0;
                        args.NavigationId(&mut navigation)?;
                        *loading.borrow_mut() = Page {
                            navigation: Some(navigation),
                            pending_url: Some(url.to_string()),
                            error: None,
                        };
                        started(&view);
                    }
                }
                Ok(())
            })),
            &mut token,
        )?;
        let completed = report.clone();
        view.add_NavigationCompleted(
            &NavigationCompletedEventHandler::create(Box::new(move |view, args| {
                if let (Some(view), Some(args)) = (view, args) {
                    let mut navigation = 0;
                    args.NavigationId(&mut navigation)?;
                    if page.borrow().navigation != Some(navigation) {
                        return Ok(());
                    }
                    let mut success = Default::default();
                    let mut error = Default::default();
                    args.IsSuccess(&mut success)?;
                    args.WebErrorStatus(&mut error)?;
                    let mut current = page.borrow_mut();
                    current.navigation = None;
                    if success.as_bool() {
                        current.pending_url = None;
                    } else if error != COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED {
                        current.error = Some("网页加载失败，请检查网址或网络连接");
                    }
                    drop(current);
                    completed(&view);
                }
                Ok(())
            })),
            &mut token,
        )?;
        let source = report.clone();
        view.add_SourceChanged(
            &SourceChangedEventHandler::create(Box::new(move |view, _| {
                if let Some(view) = view {
                    source(&view);
                }
                Ok(())
            })),
            &mut token,
        )?;
        view.add_HistoryChanged(
            &HistoryChangedEventHandler::create(Box::new(move |view, _| {
                if let Some(view) = view {
                    report(&view);
                }
                Ok(())
            })),
            &mut token,
        )?;
        let (app, id) = (app.clone(), id.to_owned());
        view.add_NewWindowRequested(
            &NewWindowRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else {
                    return Ok(());
                };
                args.SetHandled(true)?;
                let mut clicked = Default::default();
                args.IsUserInitiated(&mut clicked)?;
                if clicked.as_bool() {
                    let mut uri = Default::default();
                    args.Uri(&mut uri)?;
                    if let Ok(url) = web_url(&take_pwstr(uri)) {
                        let id = id.clone();
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = app.run_on_main_thread(move || {
                                let _ = with_browser(&id, |view| view.load_url(url.as_str()));
                            });
                        });
                    }
                }
                Ok(())
            })),
            &mut token,
        )?;
    }
    Ok(())
}

fn with_browser(id: &str, action: impl FnOnce(&WebView) -> wry::Result<()>) -> Result<(), String> {
    BROWSER.with(|cell| {
        if let Some(browser) = cell.borrow().as_ref().filter(|browser| browser.id == id) {
            action(&browser.view).map_err(|error| error.to_string())?;
        }
        Ok(())
    })
}

fn navigate(app: &AppHandle, profile: PathBuf, id: &str, url: Url) -> Result<(), String> {
    let exists = BROWSER.with(|cell| {
        cell.borrow()
            .as_ref()
            .is_some_and(|browser| browser.id == id)
    });
    if !exists {
        close_all();
        let window = app.get_webview_window("main").ok_or("找不到主窗口")?;
        let mut context = WebContext::new(Some(profile));
        // The site uses its own in-private profile with no Tauri IPC or app protocols.
        let view = WebViewBuilder::new_with_web_context(&mut context)
            .with_visible(false)
            .with_focused(false)
            .with_incognito(true)
            .with_navigation_handler(|url| web_url(&url).is_ok())
            .with_permission_handler(|_| PermissionResponse::Deny)
            .with_download_started_handler(|_, _| false)
            .build_as_child(&window)
            .map_err(|error| error.to_string())?;
        subscribe(&view.webview(), app, id).map_err(|error| error.to_string())?;
        BROWSER.with(|cell| {
            cell.replace(Some(Browser {
                id: id.into(),
                view,
                _context: context,
            }))
        });
    }
    with_browser(id, |view| view.load_url(url.as_str()))
}

fn bounds(value: &Value) -> Result<Rect, String> {
    let dimension = |key, min| {
        value[key]
            .as_i64()
            .filter(|n| (min..=32767).contains(n))
            .ok_or("网页预览尺寸无效")
    };
    Ok(Rect {
        position: PhysicalPosition::new(dimension("x", 0)? as i32, dimension("y", 0)? as i32)
            .into(),
        size: PhysicalSize::new(
            dimension("width", 1)? as u32,
            dimension("height", 1)? as u32,
        )
        .into(),
    })
}

pub async fn dispatch(app: AppHandle, profile: PathBuf, params: Value) -> Result<Value, String> {
    let (sender, receiver) = oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let result = (|| {
            let id = params["id"]
                .as_str()
                .filter(|id| !id.is_empty() && id.len() <= 80)
                .ok_or("无效的网页预览")?;
            match params["action"].as_str() {
                Some("navigate") => navigate(
                    &handle,
                    profile,
                    id,
                    web_url(params["url"].as_str().ok_or("缺少网址")?)?,
                ),
                Some("bounds") => {
                    let rect = bounds(&params["bounds"])?;
                    with_browser(id, |view| {
                        view.set_bounds(rect)?;
                        view.set_visible(true)
                    })
                }
                Some("hide") => with_browser(id, |view| view.set_visible(false)),
                Some("close") => {
                    BROWSER.with(|cell| {
                        let mut browser = cell.borrow_mut();
                        if browser.as_ref().is_some_and(|browser| browser.id == id) {
                            browser.take();
                        }
                    });
                    Ok(())
                }
                Some("back") => with_browser(id, WebView::go_back),
                Some("forward") => with_browser(id, WebView::go_forward),
                Some("reload") => with_browser(id, WebView::reload),
                _ => Err("未知的网页预览操作".into()),
            }
        })();
        let _ = sender.send(result);
    })
    .map_err(|error| error.to_string())?;
    receiver.await.map_err(|error| error.to_string())??;
    Ok(Value::Null)
}
