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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            check_ffmpeg,
            probe_media,
            export_project
        ])
        .run(tauri::generate_context!())
        .expect("Erro ao iniciar o Toktuja");
}
