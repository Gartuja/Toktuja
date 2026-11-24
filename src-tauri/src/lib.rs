mod ffmpeg;

use ffmpeg::{ExportRequest, MediaMetadata};
use tauri::AppHandle;

#[tauri::command]
fn check_ffmpeg() -> bool {
    ffmpeg::check_ffmpeg_available()
}

#[tauri::command]
async fn probe_media(path: String) -> Result<MediaMetadata, String> {
    ffmpeg::probe_media(path).await
}

#[tauri::command]
async fn export_project(app: AppHandle, request: ExportRequest) -> Result<String, String> {
    ffmpeg::export_project(app, request).await
}

#[tauri::command]
fn save_project_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| format!("Erro ao salvar rascunho: {e}"))
}

#[tauri::command]
fn load_project_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Erro ao abrir rascunho: {e}"))
}

#[tauri::command]
fn get_startup_draft() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|arg| arg.to_lowercase().ends_with(".toktuja"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            check_ffmpeg,
            probe_media,
            export_project,
            save_project_file,
            load_project_file,
            get_startup_draft
        ])
        .run(tauri::generate_context!())
        .expect("Erro ao iniciar o Toktuja");
}
