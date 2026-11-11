use std::{
    fs,
    path::{Path, PathBuf},
    sync::{atomic::{AtomicBool, Ordering}, Mutex},
    time::{Duration, Instant},
};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

pub struct AppUpdater {
    version: String,
    source: Option<Url>,
    installed: bool,
    cache: PathBuf,
    automatic: AtomicBool,
    check: tokio::sync::Mutex<()>,
    state: Mutex<State>,
}

struct State {
    status: Value,
    ready: Option<Update>,
}

impl AppUpdater {
    pub fn new(app: &AppHandle, root: &Path) -> Self {
        let version = app.package_info().version.to_string();
        let installed = std::env::current_exe().ok().and_then(|file| {
            Some(file.parent()?.join("installer-channel.txt").is_file())
        }).unwrap_or(false);
        let source = app.config().plugins.0.get("updater")
            .and_then(|config| config["endpoints"][0].as_str())
            .and_then(|endpoint| Url::parse(endpoint).ok())
            .filter(|url| is_github(url) && feed_repository(url).is_some());
        let cache = root.join("app-updates");
        let state = if !installed { "portable" } else if source.is_none() { "unconfigured" } else { "idle" };
        let mut status = json!({ "version": version, "state": state });
        let last_error = cache.join("install-error.txt");
        if state == "idle" {
            if let Ok(error) = fs::read_to_string(&last_error) {
                status = json!({ "version": version, "state": "error", "detail": error });
                let _ = fs::remove_file(last_error);
            }
        }
        Self {
            version, source, installed, cache, automatic: AtomicBool::new(false),
            check: tokio::sync::Mutex::new(()),
            state: Mutex::new(State { status, ready: None }),
        }
    }

    pub fn start(app: AppHandle) {
        tauri::async_runtime::spawn(async move {
            let updater = app.state::<Self>();
            if !updater.installed || updater.source.is_none() { return; }
            if let Ok(enabled) = app.state::<super::Backend>().call("app:updatePreference", json!({})).await {
                updater.automatic.store(enabled.as_bool() == Some(true), Ordering::Release);
            }
            tokio::time::sleep(Duration::from_secs(8)).await;
            loop {
                updater.check(&app, false).await;
                tokio::time::sleep(Duration::from_secs(6 * 60 * 60)).await;
            }
        });
    }

    pub fn set_automatic(&self, app: &AppHandle, enabled: bool) {
        let was_enabled = self.automatic.swap(enabled, Ordering::AcqRel);
        if enabled && !was_enabled && self.installed && self.source.is_some() {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { app.state::<Self>().check(&app, false).await; });
        }
    }

    pub fn status(&self) -> Value { self.state.lock().unwrap().status.clone() }

    fn update_status(&self, app: &AppHandle, mut status: Value) {
        status["version"] = json!(self.version);
        self.state.lock().unwrap().status = status.clone();
        let _ = app.emit("entrotect:event", json!({ "type": "app-update", "status": status }));
    }

    fn release_status(&self, app: &AppHandle, update: &Update, status: Value) {
        self.update_status(app, release_status(update, status));
    }

    pub async fn check(&self, app: &AppHandle, manual: bool) -> Value {
        let Some(source) = &self.source else { return self.status(); };
        if !self.installed || app.state::<super::Backend>().closing.load(Ordering::Acquire) || !manual && !self.automatic.load(Ordering::Acquire) {
            return self.status();
        }
        let Ok(_guard) = self.check.try_lock() else { return self.status(); };
        if self.state.lock().unwrap().ready.is_some() { return self.status(); }
        self.update_status(app, json!({ "state": "checking" }));
        match self.prepare(app, source, manual).await {
            Ok(Some(update)) => {
                let status = release_status(&update, json!({ "state": "ready" }));
                self.state.lock().unwrap().ready = Some(update);
                self.update_status(app, status);
            }
            Ok(None) if manual || self.automatic.load(Ordering::Acquire) => {
                self.update_status(app, json!({ "state": "current" }));
            }
            Ok(None) => self.update_status(app, json!({ "state": "idle" })),
            Err(detail) if manual || self.automatic.load(Ordering::Acquire) => {
                let previous = self.status();
                self.update_status(app, error_status(&previous, detail));
            }
            Err(_) => self.update_status(app, json!({ "state": "idle" })),
        }
        self.status()
    }

    async fn prepare(&self, app: &AppHandle, source: &Url, manual: bool) -> Result<Option<Update>, String> {
        let updater = app.updater_builder()
            .timeout(Duration::from_secs(30 * 60))
            .build().map_err(|error| error.to_string())?;
        let found = tokio::time::timeout(Duration::from_secs(25), updater.check()).await
            .map_err(|_| "检查 GitHub 更新超时".to_string())?
            .map_err(|error| error.to_string())?;
        let Some(update) = found else {
            let _ = fs::remove_file(self.installer());
            return Ok(None);
        };
        if !valid_installer(source, &update.download_url, &update.version) {
            return Err("安装包地址与 GitHub 发布仓库或版本不匹配".into());
        }
        if !manual && !self.automatic.load(Ordering::Acquire) { return Ok(None); }

        self.release_status(app, &update, json!({ "state": "downloading", "downloaded": 0 }));
        let cached = self.installer();
        let verify = update.clone();
        let exists = tauri::async_runtime::spawn_blocking(move || {
            fs::read(cached).is_ok_and(|bytes| verify.verify(&bytes).is_ok())
        }).await.map_err(|error| error.to_string())?;
        if exists { return Ok(Some(update)); }

        let mut downloaded = 0u64;
        let mut notified = Instant::now();
        let bytes = update.download(|chunk, total| {
            downloaded = downloaded.saturating_add(chunk as u64);
            if notified.elapsed() >= Duration::from_millis(300) {
                self.release_status(app, &update, json!({ "state": "downloading", "downloaded": downloaded, "total": total }));
                notified = Instant::now();
            }
        }, || {}).await.map_err(|error| error.to_string())?;
        if !manual && !self.automatic.load(Ordering::Acquire) { return Ok(None); }

        let file = self.installer();
        tauri::async_runtime::spawn_blocking(move || {
            fs::create_dir_all(file.parent().unwrap())?;
            let temporary = file.with_extension("partial");
            fs::write(&temporary, bytes)?;
            fs::rename(temporary, file)
        }).await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())?;
        Ok(Some(update))
    }

    fn installer(&self) -> PathBuf { self.cache.join("installer.exe") }

    pub fn ready(&self, manual: bool) -> Option<Update> {
        if !manual && !self.automatic.load(Ordering::Acquire) { return None; }
        self.state.lock().unwrap().ready.clone()
    }

    pub async fn read_installer(&self, app: &AppHandle, update: &Update) -> Result<Vec<u8>, String> {
        let file = self.installer();
        let verify = update.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            let bytes = fs::read(file).map_err(|error| error.to_string())?;
            verify.verify(&bytes).map_err(|error| error.to_string())?;
            Ok(bytes)
        }).await.map_err(|error| error.to_string())?;
        if let Err(detail) = &result {
            self.state.lock().unwrap().ready = None;
            self.release_status(app, update, json!({ "state": "error", "detail": detail }));
        }
        result
    }

    pub async fn launch(&self, app: &AppHandle, update: Update, bytes: Vec<u8>, restart: bool) {
        self.release_status(app, &update, json!({ "state": "installing" }));
        if let Some(window) = app.get_webview_window("main") { let _ = window.hide(); }
        let result = tauri::async_runtime::spawn_blocking(move || {
            update.restart_after_install(restart).install(bytes).map_err(|error| error.to_string())
        }).await;
        let error = match result { Ok(Ok(())) => return, Ok(Err(error)) => error, Err(error) => error.to_string() };
        let _ = fs::write(self.cache.join("install-error.txt"), error);
        if restart { app.restart(); }
    }
}

fn release_status(update: &Update, mut status: Value) -> Value {
    status["available"] = json!(update.version);
    if let Some(notes) = update.body.as_deref().map(str::trim).filter(|notes| !notes.is_empty()) {
        status["notes"] = json!(notes);
    }
    status
}

fn error_status(previous: &Value, detail: String) -> Value {
    let mut status = json!({ "state": "error", "detail": detail });
    for field in ["available", "notes"] {
        if let Some(value) = previous.get(field) {
            status[field] = value.clone();
        }
    }
    status
}

fn is_github(url: &Url) -> bool {
    url.scheme() == "https" && url.host_str() == Some("github.com") && url.port().is_none() &&
        url.username().is_empty() && url.password().is_none() && url.query().is_none() && url.fragment().is_none()
}

fn valid_installer(source: &Url, asset: &Url, version: &str) -> bool {
    let Some(repository) = feed_repository(source) else { return false; };
    is_github(asset) && asset.path().strip_prefix(&format!("{repository}/releases/download/v{version}/"))
        .is_some_and(|file| file.ends_with("-setup.exe") && !file.contains('/'))
}

fn feed_repository(source: &Url) -> Option<&str> {
    source.path().strip_suffix("/releases/latest/download/latest.json")
        .or_else(|| source.path().strip_suffix("/raw/refs/heads/main/updates/beta.json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_the_configured_release_installer() {
        let source = Url::parse("https://github.com/example/entrotect/releases/latest/download/latest.json").unwrap();
        for (url, expected) in [
            ("https://github.com/example/entrotect/releases/download/v0.7.8/EntroTect_0.7.8_x64-setup.exe", true),
            ("https://github.com/example/entrotect/releases/download/v0.7.7/EntroTect_0.7.7_x64-setup.exe", false),
            ("https://github.com/someone/entrotect/releases/download/v0.7.8/EntroTect_0.7.8_x64-setup.exe", false),
            ("https://github.com.example.com/example/entrotect/releases/download/v0.7.8/EntroTect_0.7.8_x64-setup.exe", false),
        ] {
            assert_eq!(valid_installer(&source, &Url::parse(url).unwrap(), "0.7.8"), expected);
        }
    }

    #[test]
    fn beta_feed_accepts_only_its_versioned_repository_asset() {
        let source = Url::parse("https://github.com/example/entrotect/raw/refs/heads/main/updates/beta.json").unwrap();
        let asset = Url::parse("https://github.com/example/entrotect/releases/download/v0.8.0-beta.1/EntroTect_0.8.0-beta.1_x64-setup.exe").unwrap();
        assert!(valid_installer(&source, &asset, "0.8.0-beta.1"));
        assert!(!valid_installer(&source, &asset, "0.8.0-beta.2"));
    }

    #[test]
    fn download_errors_keep_release_notes_without_claiming_an_undetected_update() {
        let found = json!({ "state": "downloading", "available": "0.7.9", "notes": "Changes", "downloaded": 24 });
        let error = error_status(&found, "connection lost".into());
        assert_eq!(error, json!({ "state": "error", "detail": "connection lost", "available": "0.7.9", "notes": "Changes" }));
        let checking = json!({ "state": "checking" });
        assert_eq!(error_status(&checking, "unreachable".into()), json!({ "state": "error", "detail": "unreachable" }));
    }
}
