//! Coquille Tauri : expose le stockage (ds-store) à l'interface. Aucun calcul financier ici.

use ds_store::backup::{self, Manifest, Reason, RestorePreview, Store, StoreStatus};
use ds_store::db::{self, ApplyResult, Locations, Stmt};
use ds_store::{migrations, StoreError};
use serde_json::{Map, Value};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, State};

struct AppState {
    store: Mutex<Store>,
    staged: Mutex<Option<RestorePreview>>,
}

type CmdResult<T> = Result<T, StoreError>;

#[tauri::command]
fn db_query(state: State<AppState>, sql: String, params: Vec<Value>) -> CmdResult<Vec<Map<String, Value>>> {
    let s = state.store.lock().unwrap();
    db::query(&s.conn, &sql, &params)
}

#[tauri::command]
fn db_apply(state: State<AppState>, plan: Vec<Stmt>) -> CmdResult<ApplyResult> {
    state.store.lock().unwrap().apply(&plan)
}

#[tauri::command]
fn store_status(state: State<AppState>) -> StoreStatus {
    state.store.lock().unwrap().status()
}

#[tauri::command]
fn backup_now(state: State<AppState>) -> CmdResult<Manifest> {
    state.store.lock().unwrap().backup(Reason::Manuelle)
}

#[tauri::command]
fn list_backups(state: State<AppState>) -> CmdResult<Vec<Manifest>> {
    let s = state.store.lock().unwrap();
    backup::list(&s.loc.backups_dir)
}

#[tauri::command]
fn stage_restore(state: State<AppState>, file: String) -> CmdResult<RestorePreview> {
    let p = state.store.lock().unwrap().stage_restore(&file)?;
    *state.staged.lock().unwrap() = Some(p.clone());
    Ok(p)
}

#[tauri::command]
fn commit_restore(state: State<AppState>) -> CmdResult<Manifest> {
    let p = state.staged.lock().unwrap().take().ok_or_else(|| StoreError::msg("Aucune restauration préparée"))?;
    state.store.lock().unwrap().commit_restore(&p)
}

#[tauri::command]
fn fresh_start(state: State<AppState>) -> CmdResult<Manifest> {
    state.store.lock().unwrap().fresh_start()
}

#[tauri::command]
fn read_drafts(state: State<AppState>) -> CmdResult<String> {
    let p = state.store.lock().unwrap().loc.drafts.clone();
    Ok(std::fs::read_to_string(p).unwrap_or_else(|_| "{}".into()))
}

#[tauri::command]
fn write_drafts(state: State<AppState>, content: String) -> CmdResult<()> {
    let p = state.store.lock().unwrap().loc.drafts.clone();
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, content)?;
    std::fs::rename(tmp, p)?;
    Ok(())
}

/// Écrit un fichier choisi par l'utilisateur dans la boîte « Enregistrer sous » (modèle, export).
#[tauri::command]
fn save_file(path: String, bytes: Vec<u8>) -> CmdResult<()> {
    std::fs::write(path, bytes)?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let store = Store::open(Locations::new(data_dir, None), env!("CARGO_PKG_VERSION"), migrations::embedded())
                .map_err(|e| Box::new(std::io::Error::other(e.to_string())))?;
            app.manage(AppState { store: Mutex::new(store), staged: Mutex::new(None) });
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(60));
                let state = handle.state::<AppState>();
                if let Ok(mut s) = state.store.lock() {
                    let _ = s.maybe_autobackup(Duration::from_secs(600));
                };
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let state = window.state::<AppState>();
                if let Ok(mut s) = state.store.lock() {
                    let _ = s.on_close();
                };
            }
        })
        .invoke_handler(tauri::generate_handler![
            db_query, db_apply, store_status, backup_now, list_backups,
            stage_restore, commit_restore, fresh_start, read_drafts, write_drafts, save_file
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de DS Finances");
}
