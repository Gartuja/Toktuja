use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Stdio;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MediaMetadata {
    pub path: String,
    pub name: String,
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub has_video: bool,
    pub has_audio: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VideoClipExport {
    pub path: String,
    pub start_time: f64,
    pub end_time: f64,
    pub timeline_start: f64,
    pub track_index: usize,
    pub volume: f64,
    pub muted: bool,
    pub has_audio: bool,
    pub crop_x: f64,
    pub crop_y: f64,
    pub zoom: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AudioClipExport {
    pub path: String,
    pub start_time: f64,
    pub end_time: f64,
    pub timeline_start: f64,
    pub volume: f64,
    pub muted: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExportRequest {
    pub video_clips: Vec<VideoClipExport>,
    pub audio_clips: Vec<AudioClipExport>,
    pub aspect_ratio: String,
    pub resolution: String,
    pub fit_mode: String,
    pub video_volume: f64,
    pub video_muted: bool,
    pub output_path: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct ExportProgress {
    pub percent: f64,
    pub status: String,
}

fn find_binary(name: &str) -> String {
    let exe_name = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };

    if cfg!(windows) {
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            let winget_link = PathBuf::from(&local_app_data)
                .join("Microsoft")
                .join("WinGet")
                .join("Links")
                .join(&exe_name);
            if winget_link.exists() {
                return winget_link.to_string_lossy().to_string();
            }
        }
    }

    exe_name
}

pub fn check_ffmpeg_available() -> bool {
    let bin = find_binary("ffmpeg");
    std::process::Command::new(bin)
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

pub async fn probe_media(path: String) -> Result<MediaMetadata, String> {
    let ffprobe = find_binary("ffprobe");
    let output = Command::new(ffprobe)
        .args([
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            &path,
        ])
        .output()
        .await
        .map_err(|e| format!("Falha ao executar ffprobe: {e}"))?;

    if !output.status.success() {
        return Err("Não foi possível ler os metadados do arquivo de mídia.".to_string());
    }

    let json: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Erro ao interpretar JSON do ffprobe: {e}"))?;

    let duration = json["format"]["duration"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);

    let mut width = 0u32;
    let mut height = 0u32;
    let mut fps = 30.0f64;
    let mut has_video = false;
    let mut has_audio = false;

    if let Some(streams) = json["streams"].as_array() {
        for stream in streams {
            match stream["codec_type"].as_str() {
                Some("video") if !has_video => {
                    has_video = true;
                    width = stream["width"].as_u64().unwrap_or(0) as u32;
                    height = stream["height"].as_u64().unwrap_or(0) as u32;
                    if let Some(rate) = stream["r_frame_rate"].as_str() {
                        if let Some((num, den)) = rate.split_once('/') {
                            if let (Ok(n), Ok(d)) = (num.parse::<f64>(), den.parse::<f64>()) {
                                if d > 0.0 {
                                    fps = n / d;
                                }
                            }
                        }
                    }
                }
                Some("audio") => {
                    has_audio = true;
                }
                _ => {}
            }
        }
    }

    let name = PathBuf::from(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "midia".to_string());

    Ok(MediaMetadata {
        path,
        name,
        duration,
        width,
        height,
        fps,
        has_video,
        has_audio,
    })
}

fn target_dimensions(aspect_ratio: &str, resolution: &str) -> (u32, u32) {
    let base = match resolution {
        "480p" => 480u32,
        "720p" => 720u32,
        _ => 1080u32,
    };
    match aspect_ratio {
        "9:16" => {
            let h = ((base as f64 * 16.0 / 9.0).round() as u32) & !1;
            (base, h)
        }
        "16:9" => {
            let w = ((base as f64 * 16.0 / 9.0).round() as u32) & !1;
            (w, base)
        }
        "1:1" => (base, base),
        "4:5" => {
            let h = ((base as f64 * 5.0 / 4.0).round() as u32) & !1;
            (base, h)
        }
        _ => (1080, 1920),
    }
}

pub async fn export_project(app: AppHandle, req: ExportRequest) -> Result<String, String> {
    if req.video_clips.is_empty() {
        return Err("Adicione pelo menos um vídeo na timeline antes de exportar.".to_string());
    }

    let (target_w, target_h) = target_dimensions(&req.aspect_ratio, &req.resolution);
    let mut args: Vec<String> = vec!["-y".to_string()];

    // Sort video clips by track_index ascending so higher tracks overlay lower tracks
    let mut sorted_videos = req.video_clips.clone();
    sorted_videos.sort_by_key(|c| c.track_index);

    let mut total_duration = 0.0f64;
    for clip in &sorted_videos {
        let dur = (clip.end_time - clip.start_time).max(0.05);
        total_duration = total_duration.max(clip.timeline_start + dur);
        args.extend([
            "-ss".to_string(),
            format!("{:.3}", clip.start_time),
            "-t".to_string(),
            format!("{:.3}", dur),
            "-i".to_string(),
            clip.path.clone(),
        ]);
    }

    for aclip in &req.audio_clips {
        let dur = (aclip.end_time - aclip.start_time).max(0.05);
        args.extend([
            "-ss".to_string(),
            format!("{:.3}", aclip.start_time),
            "-t".to_string(),
            format!("{:.3}", dur),
            "-i".to_string(),
            aclip.path.clone(),
        ]);
    }

    total_duration = total_duration.max(0.1);
    let mut filter_parts: Vec<String> = Vec::new();
    filter_parts.push(format!(
        "color=c=black:s={target_w}x{target_h}:d={total_duration:.3}:r=30,format=yuv420p[base0]"
    ));
    filter_parts.push(format!(
        "anullsrc=channel_layout=stereo:sample_rate=44100:d={total_duration:.3}[abase]"
    ));

    let mut last_video_pad = "[base0]".to_string();
    let mut audio_mix_inputs = vec!["[abase]".to_string()];

    for (i, clip) in sorted_videos.iter().enumerate() {
        let dur = (clip.end_time - clip.start_time).max(0.05);
        let t_start = clip.timeline_start.max(0.0);
        let t_end = t_start + dur;
        let zoom = clip.zoom.clamp(0.2, 3.0);
        let cx = clip.crop_x.clamp(-1.0, 1.0);
        let cy = clip.crop_y.clamp(-1.0, 1.0);

        let mut ov_x = "0".to_string();
        let mut ov_y = "0".to_string();

        let v_filter = match req.fit_mode.as_str() {
            "fit" => {
                let fit_w = (((target_w as f64 * zoom).round() as u32).max(16)) & !1;
                let fit_h = (((target_h as f64 * zoom).round() as u32).max(16)) & !1;
                ov_x = format!("({target_w}-w)/2+({cx:.4})*({target_w}/2)");
                ov_y = format!("({target_h}-h)/2+({cy:.4})*({target_h}/2)");
                format!(
                    "[{i}:v]fps=30,scale={fit_w}:{fit_h}:force_original_aspect_ratio=decrease,\
                     setsar=1,format=yuv420p,setpts=PTS-STARTPTS+{t_start:.3}/TB[v{i}]"
                )
            }
            "blur" => format!(
                "[{i}:v]fps=30,split=2[bg{i}][fg{i}];\
                 [bg{i}]scale={target_w}:{target_h}:force_original_aspect_ratio=increase,\
                 crop={target_w}:{target_h},boxblur=20:5[bgb{i}];\
                 [fg{i}]scale={target_w}:{target_h}:force_original_aspect_ratio=decrease[fgs{i}];\
                 [bgb{i}][fgs{i}]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p,\
                 setpts=PTS-STARTPTS+{t_start:.3}/TB[v{i}]"
            ),
            _ => {
                let crop_zoom = zoom.max(1.0);
                let scaled_w = (target_w as f64 * crop_zoom).round() as u32;
                let scaled_h = (target_h as f64 * crop_zoom).round() as u32;
                let x_expr = format!("(iw-{target_w})*(0.5+{:.4}*0.5)", cx);
                let y_expr = format!("(ih-{target_h})*(0.5+{:.4}*0.5)", cy);
                format!(
                    "[{i}:v]fps=30,scale={scaled_w}:{scaled_h}:force_original_aspect_ratio=increase,\
                     crop={target_w}:{target_h}:{x_expr}:{y_expr},setsar=1,format=yuv420p,\
                     setpts=PTS-STARTPTS+{t_start:.3}/TB[v{i}]"
                )
            }
        };
        filter_parts.push(v_filter);

        let next_pad = format!("[ov{i}]");
        filter_parts.push(format!(
            "{last_video_pad}[v{i}]overlay={ov_x}:{ov_y}:enable='between(t,{t_start:.3},{t_end:.3})'{next_pad}"
        ));
        last_video_pad = next_pad;

        let effective_vol = if req.video_muted || clip.muted {
            0.0
        } else {
            (clip.volume * req.video_volume).clamp(0.0, 2.0)
        };

        if clip.has_audio && effective_vol > 0.001 {
            let delay_ms = (t_start * 1000.0).round() as u64;
            filter_parts.push(format!(
                "[{i}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,\
                 volume={effective_vol:.3},adelay={delay_ms}|{delay_ms}[va{i}]"
            ));
            audio_mix_inputs.push(format!("[va{i}]"));
        }
    }

    let n_video = sorted_videos.len();
    for (orig_idx, aclip) in req.audio_clips.iter().enumerate() {
        if aclip.muted || aclip.volume <= 0.001 {
            continue;
        }
        let input_idx = n_video + orig_idx;
        let delay_ms = (aclip.timeline_start.max(0.0) * 1000.0).round() as u64;
        let vol = aclip.volume.clamp(0.0, 2.0);
        filter_parts.push(format!(
            "[{input_idx}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,\
             volume={vol:.3},adelay={delay_ms}|{delay_ms}[am{orig_idx}]"
        ));
        audio_mix_inputs.push(format!("[am{orig_idx}]"));
    }

    let audio_map = if audio_mix_inputs.len() == 1 {
        "[abase]".to_string()
    } else {
        let total_mix = audio_mix_inputs.len();
        filter_parts.push(format!(
            "{}amix=inputs={total_mix}:duration=first:dropout_transition=2:normalize=0[aout]",
            audio_mix_inputs.join("")
        ));
        "[aout]".to_string()
    };

    let filter_complex = filter_parts.join(";");
    args.extend([
        "-filter_complex".to_string(),
        filter_complex,
        "-map".to_string(),
        last_video_pad,
        "-map".to_string(),
        audio_map,
        "-c:v".to_string(),
        "libx264".to_string(),
        "-preset".to_string(),
        "veryfast".to_string(),
        "-crf".to_string(),
        "20".to_string(),
        "-c:a".to_string(),
        "aac".to_string(),
        "-b:a".to_string(),
        "192k".to_string(),
        "-movflags".to_string(),
        "+faststart".to_string(),
        "-progress".to_string(),
        "pipe:1".to_string(),
        "-nostats".to_string(),
        req.output_path.clone(),
    ]);

    let _ = app.emit(
        "export-progress",
        ExportProgress {
            percent: 0.0,
            status: "Iniciando renderização...".to_string(),
        },
    );

    let ffmpeg = find_binary("ffmpeg");
    let mut child = Command::new(ffmpeg)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Falha ao iniciar FFmpeg: {e}"))?;

    if let Some(stdout) = child.stdout.take() {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(us_str) = line.strip_prefix("out_time_us=") {
                if let Ok(us) = us_str.trim().parse::<f64>() {
                    let current_sec = us / 1_000_000.0;
                    let pct = if total_duration > 0.0 {
                        ((current_sec / total_duration) * 100.0).clamp(0.0, 99.0)
                    } else {
                        0.0
                    };
                    let _ = app.emit(
                        "export-progress",
                        ExportProgress {
                            percent: pct,
                            status: format!("Renderizando... {:.0}%", pct),
                        },
                    );
                }
            }
        }
    }

    let output = child
        .wait_with_output()
        .await
        .map_err(|e| format!("Erro ao aguardar FFmpeg: {e}"))?;

    if !output.status.success() {
        let err_msg = String::from_utf8_lossy(&output.stderr);
        let tail: String = err_msg
            .lines()
            .rev()
            .take(8)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        return Err(format!("Erro na exportação FFmpeg:\n{tail}"));
    }

    let _ = app.emit(
        "export-progress",
        ExportProgress {
            percent: 100.0,
            status: "Exportação concluída!".to_string(),
        },
    );

    Ok(req.output_path)
}
