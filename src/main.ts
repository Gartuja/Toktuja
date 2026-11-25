import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_LABELS,
  eventToShortcutString,
  formatShortcutDisplay,
  loadShortcuts,
  saveShortcuts,
} from "./shortcuts";
import type {
  AspectRatio,
  AudioClip,
  FitMode,
  MediaMetadata,
  ProjectState,
  ShortcutAction,
  ShortcutMap,
  VideoClip,
} from "./types";

// --- Audacity 4.0 Inspired Track Palettes ---
const VIDEO_PALETTE = [
  "#3b82f6", // Cobalt
  "#8b5cf6", // Violet
  "#06b6d4", // Cyan
  "#ec4899", // Pink
  "#f97316", // Orange
  "#6366f1", // Indigo
  "#0ea5e9", // Sky
  "#a855f7", // Purple
];

const AUDIO_PALETTE = [
  "#10b981", // Emerald
  "#f59e0b", // Amber
  "#14b8a6", // Teal
  "#84cc16", // Lime
  "#22c55e", // Green
  "#eab308", // Yellow
  "#34d399", // Mint
  "#a3e635", // Chartreuse
];

function hexToRgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function getTrackColor(kind: "video" | "audio", index: number): string {
  const pal = kind === "video" ? VIDEO_PALETTE : AUDIO_PALETTE;
  return pal[Math.abs(index) % pal.length];
}

// --- State ---
let state: ProjectState = {
  videoClips: [],
  audioClips: [],
  aspectRatio: "9:16",
  customAspectW: 16,
  customAspectH: 10,
  fitMode: "crop",
  videoVolume: 1.0,
  videoMuted: false,
};

let undoStack: string[] = [];
let redoStack: string[] = [];
let shortcuts: ShortcutMap = loadShortcuts();
let recordingAction: ShortcutAction | null = null;

let selectedClip: { type: "video" | "audio"; id: string } | null = null;
let playheadTime = 0;
let isPlaying = false;
let pxPerSec = 40;
let rafId: number | null = null;
let lastFrameTs = 0;
let hasUnsavedChanges = false;
let loadedBgSrc = "";

const audioPlayers = new Map<string, HTMLAudioElement>();
const visualPlayers = new Map<string, HTMLVideoElement | HTMLImageElement>();
const thumbCache = new Map<string, string>();

// --- DOM Refs ---
const previewStage = document.getElementById("preview-stage") as HTMLDivElement;
const previewLayers = document.getElementById("preview-layers") as HTMLDivElement;
const previewBgVideo = document.getElementById("preview-bg-video") as HTMLVideoElement;
const transformBox = document.getElementById("transform-box") as HTMLDivElement;
const previewEmpty = document.getElementById("preview-empty") as HTMLDivElement;
const timecodeEl = document.getElementById("timecode") as HTMLSpanElement;
const btnPlay = document.getElementById("btn-play") as HTMLButtonElement;
const btnMuteMaster = document.getElementById("btn-mute-master") as HTMLButtonElement;
const masterVolInput = document.getElementById("master-video-volume") as HTMLInputElement;

const customAspectBox = document.getElementById("custom-aspect-box") as HTMLDivElement;
const customWInput = document.getElementById("custom-w") as HTMLInputElement;
const customHInput = document.getElementById("custom-h") as HTMLInputElement;

const timelineHeaders = document.getElementById("timeline-headers") as HTMLDivElement;
const timelineScroll = document.getElementById("timeline-scroll") as HTMLDivElement;
const timelineCanvas = document.getElementById("timeline-canvas") as HTMLDivElement;
const timeRuler = document.getElementById("time-ruler") as HTMLDivElement;
const tracksLanes = document.getElementById("tracks-lanes") as HTMLDivElement;
const playheadEl = document.getElementById("playhead") as HTMLDivElement;

const inspectorBadge = document.getElementById("inspector-badge") as HTMLSpanElement;
const inspectorBody = document.getElementById("inspector-body") as HTMLDivElement;

const modalShortcuts = document.getElementById("modal-shortcuts") as HTMLDivElement;
const shortcutsList = document.getElementById("shortcuts-list") as HTMLDivElement;
const modalExport = document.getElementById("modal-export") as HTMLDivElement;
const exportStatus = document.getElementById("export-status") as HTMLParagraphElement;
const exportFill = document.getElementById("export-progress-fill") as HTMLDivElement;
const btnCloseExport = document.getElementById("btn-close-export") as HTMLButtonElement;
const modalCloseDraft = document.getElementById("modal-close-draft") as HTMLDivElement;

// --- Helpers ---
function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function pushUndo(): void {
  undoStack.push(JSON.stringify(state));
  if (undoStack.length > 40) undoStack.shift();
  redoStack = [];
  hasUnsavedChanges = true;
}

function undo(): void {
  const prev = undoStack.pop();
  if (!prev) return;
  redoStack.push(JSON.stringify(state));
  state = JSON.parse(prev) as ProjectState;
  renderAll();
  syncMediaToPlayhead(true);
}

function redo(): void {
  const next = redoStack.pop();
  if (!next) return;
  undoStack.push(JSON.stringify(state));
  state = JSON.parse(next) as ProjectState;
  renderAll();
  syncMediaToPlayhead(true);
}

function clipDur(c: { startTime: number; endTime: number }): number {
  return Math.max(0.05, c.endTime - c.startTime);
}

function getTotalVideoDuration(): number {
  return state.videoClips.reduce(
    (max, c) => Math.max(max, c.timelineStart + clipDur(c)),
    0
  );
}

function getTotalTimelineDuration(): number {
  const vTotal = getTotalVideoDuration();
  const aMax = state.audioClips.reduce(
    (max, a) => Math.max(max, a.timelineStart + clipDur(a)),
    0
  );
  return Math.max(vTotal, aMax, 5);
}

function nextVideoTrackIndex(): number {
  if (state.videoClips.length === 0) return 0;
  return Math.max(...state.videoClips.map((c) => c.trackIndex)) + 1;
}

function nextAudioTrackIndex(): number {
  if (state.audioClips.length === 0) return 0;
  return Math.max(...state.audioClips.map((c) => c.trackIndex)) + 1;
}

function formatTime(sec: number): string {
  const s = Math.max(0, sec);
  const mins = Math.floor(s / 60);
  const secs = Math.floor(s % 60);
  const tenths = Math.floor((s * 10) % 10);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${tenths}`;
}

function findActiveVideoClipsAtTime(t: number): { clip: VideoClip; localOffset: number }[] {
  return state.videoClips
    .filter((c) => t >= c.timelineStart && t < c.timelineStart + clipDur(c))
    .sort((a, b) => a.trackIndex - b.trackIndex)
    .map((clip) => ({ clip, localOffset: t - clip.timelineStart }));
}

function getTargetTransformClip(active: { clip: VideoClip }[]): VideoClip | undefined {
  if (active.length === 0) return undefined;
  if (selectedClip?.type === "video") {
    const sel = active.find((a) => a.clip.id === selectedClip?.id);
    if (sel) return sel.clip;
  }
  return active[active.length - 1].clip;
}

function findActiveAudioClipsAtTime(t: number): { clip: AudioClip; localOffset: number }[] {
  const result: { clip: AudioClip; localOffset: number }[] = [];
  for (const clip of state.audioClips) {
    const dur = clipDur(clip);
    if (t >= clip.timelineStart && t < clip.timelineStart + dur) {
      result.push({ clip, localOffset: t - clip.timelineStart });
    }
  }
  return result;
}

function generateVideoThumbnail(path: string, src: string, duration: number): void {
  if (thumbCache.has(path)) return;
  const v = document.createElement("video");
  v.muted = true;
  v.preload = "metadata";
  v.src = src;

  v.addEventListener(
    "loadedmetadata",
    () => {
      v.currentTime = Math.min(0.8, Math.max(0, duration * 0.25));
    },
    { once: true }
  );

  v.addEventListener(
    "seeked",
    () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 96;
        canvas.height = 54;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
          thumbCache.set(path, dataUrl);
          for (const c of state.videoClips) {
            if (c.path === path) c.thumbUrl = dataUrl;
          }
          renderTimeline();
        }
      } catch {
        // ignore tainted canvas if any
      } finally {
        v.removeAttribute("src");
        v.load();
      }
    },
    { once: true }
  );
}

// --- Drafts (.toktuja) ---
async function saveDraft(): Promise<boolean> {
  if (state.videoClips.length === 0 && state.audioClips.length === 0) {
    alert("Adicione algum vídeo, imagem ou áudio antes de salvar um rascunho.");
    return false;
  }
  const path = await save({
    defaultPath: "rascunho.toktuja",
    filters: [{ name: "Rascunho Toktuja", extensions: ["toktuja"] }],
  });
  if (!path) return false;

  const payload = JSON.stringify({ version: "0.3.0", state }, null, 2);
  await invoke("save_project_file", { path, content: payload });
  hasUnsavedChanges = false;
  return true;
}

async function loadDraft(path: string): Promise<void> {
  try {
    const raw = await invoke<string>("load_project_file", { path });
    const parsed = JSON.parse(raw) as { state?: ProjectState };
    const loaded = parsed.state ?? (parsed as unknown as ProjectState);
    if (!loaded || !Array.isArray(loaded.videoClips) || !Array.isArray(loaded.audioClips)) {
      throw new Error("Arquivo de rascunho inválido.");
    }

    for (const player of audioPlayers.values()) player.pause();
    audioPlayers.clear();
    for (const el of visualPlayers.values()) {
      if (el instanceof HTMLVideoElement) el.pause();
      el.remove();
    }
    visualPlayers.clear();

    loaded.videoClips = loaded.videoClips.map((c) => {
      const src = convertFileSrc(c.path);
      const mediaType = c.mediaType ?? "video";
      if (mediaType === "video") {
        generateVideoThumbnail(c.path, src, c.originalDuration || 5);
      }
      return {
        ...c,
        src,
        mediaType,
        flipH: Boolean(c.flipH),
        flipV: Boolean(c.flipV),
        thumbUrl: mediaType === "image" ? src : thumbCache.get(c.path) ?? c.thumbUrl,
      };
    });
    loaded.audioClips = loaded.audioClips.map((a) => ({
      ...a,
      src: convertFileSrc(a.path),
    }));

    state = {
      ...loaded,
      customAspectW: loaded.customAspectW || 16,
      customAspectH: loaded.customAspectH || 10,
    };
    undoStack = [];
    redoStack = [];
    selectedClip = null;
    playheadTime = 0;
    loadedBgSrc = "";
    hasUnsavedChanges = false;

    document.querySelectorAll<HTMLButtonElement>("#aspect-selector button").forEach((b) => {
      b.classList.toggle("active", b.dataset.aspect === state.aspectRatio);
    });
    customAspectBox.classList.toggle("hidden", state.aspectRatio !== "custom");
    customWInput.value = String(state.customAspectW);
    customHInput.value = String(state.customAspectH);

    document.querySelectorAll<HTMLButtonElement>("#fit-selector button").forEach((b) => {
      b.classList.toggle("active", b.dataset.fit === state.fitMode);
    });
    masterVolInput.value = String(state.videoVolume ?? 1);
    btnMuteMaster.textContent = state.videoMuted ? "🔇" : "🔊";

    renderAll();
    syncMediaToPlayhead(true);
  } catch (err) {
    alert(`Erro ao abrir rascunho: ${String(err)}`);
  }
}

async function openDraftDialog(): Promise<void> {
  const res = await open({
    multiple: false,
    filters: [{ name: "Rascunho Toktuja", extensions: ["toktuja"] }],
  });
  if (!res) return;
  await loadDraft(Array.isArray(res) ? res[0] : res);
}

// --- Media Import ---
async function importFiles(paths: string[]): Promise<void> {
  const videoExts = [".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"];
  const imageExts = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"];
  const audioExts = [".mp3", ".wav", ".aac", ".m4a", ".ogg", ".flac"];

  for (const p of paths) {
    if (p.toLowerCase().endsWith(".toktuja")) {
      await loadDraft(p);
      return;
    }
  }

  pushUndo();
  for (const p of paths) {
    const lower = p.toLowerCase();
    const isVideo = videoExts.some((ext) => lower.endsWith(ext));
    const isImage = imageExts.some((ext) => lower.endsWith(ext));
    const isAudio = audioExts.some((ext) => lower.endsWith(ext));
    if (!isVideo && !isImage && !isAudio) continue;

    try {
      const src = convertFileSrc(p);
      if (isImage) {
        const name = p.split(/[\\/]/).pop() || "imagem";
        const clip: VideoClip = {
          id: uid(),
          path: p,
          src,
          name,
          mediaType: "image",
          originalDuration: 5,
          startTime: 0,
          endTime: 5,
          timelineStart: playheadTime,
          trackIndex: nextVideoTrackIndex(),
          volume: 1.0,
          muted: true,
          hasAudio: false,
          cropX: 0,
          cropY: 0,
          zoom: 0.7,
          flipH: false,
          flipV: false,
          thumbUrl: src,
        };
        state.videoClips.push(clip);
        selectedClip = { type: "video", id: clip.id };
        continue;
      }

      const meta = await invoke<MediaMetadata>("probe_media", { path: p });
      if (isVideo && meta.has_video) {
        const dur = meta.duration || 5;
        const clip: VideoClip = {
          id: uid(),
          path: p,
          src,
          name: meta.name,
          mediaType: "video",
          originalDuration: dur,
          startTime: 0,
          endTime: dur,
          timelineStart: state.videoClips.length === 0 ? 0 : getTotalVideoDuration(),
          trackIndex: nextVideoTrackIndex(),
          volume: 1.0,
          muted: false,
          hasAudio: meta.has_audio,
          cropX: 0,
          cropY: 0,
          zoom: 1.0,
          flipH: false,
          flipV: false,
          thumbUrl: thumbCache.get(p),
        };
        state.videoClips.push(clip);
        selectedClip = { type: "video", id: clip.id };
        generateVideoThumbnail(p, src, dur);
      } else if (meta.has_audio) {
        const clip: AudioClip = {
          id: uid(),
          path: p,
          src,
          name: meta.name,
          originalDuration: meta.duration || 5,
          startTime: 0,
          endTime: meta.duration || 5,
          timelineStart: playheadTime,
          trackIndex: nextAudioTrackIndex(),
          volume: 0.8,
          muted: false,
        };
        state.audioClips.push(clip);
        selectedClip = { type: "audio", id: clip.id };
      }
    } catch (err) {
      alert(`Erro ao importar ${p}: ${String(err)}`);
    }
  }
  renderAll();
  syncMediaToPlayhead(true);
}

async function openVideoDialog(): Promise<void> {
  const res = await open({
    multiple: true,
    filters: [{ name: "Vídeos", extensions: ["mp4", "mov", "mkv", "avi", "webm", "m4v"] }],
  });
  if (!res) return;
  await importFiles(Array.isArray(res) ? res : [res]);
}

async function openImageDialog(): Promise<void> {
  const res = await open({
    multiple: true,
    filters: [{ name: "Imagens", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
  });
  if (!res) return;
  await importFiles(Array.isArray(res) ? res : [res]);
}

async function openAudioDialog(): Promise<void> {
  const res = await open({
    multiple: true,
    filters: [{ name: "Áudio / Música", extensions: ["mp3", "wav", "aac", "m4a", "ogg", "flac"] }],
  });
  if (!res) return;
  await importFiles(Array.isArray(res) ? res : [res]);
}

// --- Editing Actions ---
function splitAtPlayhead(): void {
  if (selectedClip?.type === "audio") {
    const idx = state.audioClips.findIndex((a) => a.id === selectedClip?.id);
    if (idx >= 0) {
      const a = state.audioClips[idx];
      const dur = clipDur(a);
      if (playheadTime > a.timelineStart + 0.1 && playheadTime < a.timelineStart + dur - 0.1) {
        pushUndo();
        const offset = playheadTime - a.timelineStart;
        const splitPoint = a.startTime + offset;
        const first: AudioClip = { ...a, endTime: splitPoint };
        const second: AudioClip = {
          ...a,
          id: uid(),
          startTime: splitPoint,
          timelineStart: playheadTime,
        };
        state.audioClips.splice(idx, 1, first, second);
        selectedClip = { type: "audio", id: second.id };
        renderAll();
        syncMediaToPlayhead(true);
        return;
      }
    }
  }

  let targetIdx = -1;
  if (selectedClip?.type === "video") {
    const idx = state.videoClips.findIndex((c) => c.id === selectedClip?.id);
    if (idx >= 0) {
      const c = state.videoClips[idx];
      if (playheadTime > c.timelineStart + 0.1 && playheadTime < c.timelineStart + clipDur(c) - 0.1) {
        targetIdx = idx;
      }
    }
  }

  if (targetIdx < 0) {
    const active = findActiveVideoClipsAtTime(playheadTime);
    if (active.length > 0) {
      const top = active[active.length - 1].clip;
      targetIdx = state.videoClips.findIndex((c) => c.id === top.id);
    }
  }

  if (targetIdx < 0) return;
  const clip = state.videoClips[targetIdx];
  const localOffset = playheadTime - clip.timelineStart;
  const dur = clipDur(clip);
  if (localOffset <= 0.1 || localOffset >= dur - 0.1) return;

  pushUndo();
  const splitSourceTime = clip.startTime + localOffset;
  const first: VideoClip = { ...clip, endTime: splitSourceTime };
  const second: VideoClip = {
    ...clip,
    id: uid(),
    startTime: splitSourceTime,
    timelineStart: playheadTime,
  };
  state.videoClips.splice(targetIdx, 1, first, second);
  selectedClip = { type: "video", id: second.id };
  renderAll();
  syncMediaToPlayhead(true);
}

function trimStartAtPlayhead(): void {
  if (!selectedClip) return;
  if (selectedClip.type === "video") {
    const idx = state.videoClips.findIndex((c) => c.id === selectedClip?.id);
    if (idx < 0) return;
    const clip = state.videoClips[idx];
    const localOffset = playheadTime - clip.timelineStart;
    if (localOffset <= 0.05 || localOffset >= clipDur(clip) - 0.1) return;
    pushUndo();
    state.videoClips[idx] = {
      ...clip,
      startTime: clip.startTime + localOffset,
      timelineStart: playheadTime,
    };
  } else {
    const idx = state.audioClips.findIndex((c) => c.id === selectedClip?.id);
    if (idx < 0) return;
    const clip = state.audioClips[idx];
    const localOffset = playheadTime - clip.timelineStart;
    if (localOffset <= 0.05 || localOffset >= clipDur(clip) - 0.1) return;
    pushUndo();
    state.audioClips[idx] = {
      ...clip,
      startTime: clip.startTime + localOffset,
      timelineStart: playheadTime,
    };
  }
  renderAll();
  syncMediaToPlayhead(true);
}

function trimEndAtPlayhead(): void {
  if (!selectedClip) return;
  if (selectedClip.type === "video") {
    const idx = state.videoClips.findIndex((c) => c.id === selectedClip?.id);
    if (idx < 0) return;
    const clip = state.videoClips[idx];
    const localOffset = playheadTime - clip.timelineStart;
    if (localOffset <= 0.1 || localOffset >= clipDur(clip) - 0.05) return;
    pushUndo();
    state.videoClips[idx] = { ...clip, endTime: clip.startTime + localOffset };
  } else {
    const idx = state.audioClips.findIndex((c) => c.id === selectedClip?.id);
    if (idx < 0) return;
    const clip = state.audioClips[idx];
    const localOffset = playheadTime - clip.timelineStart;
    if (localOffset <= 0.1 || localOffset >= clipDur(clip) - 0.05) return;
    pushUndo();
    state.audioClips[idx] = { ...clip, endTime: clip.startTime + localOffset };
  }
  renderAll();
  syncMediaToPlayhead(true);
}

function deleteSelectedClip(): void {
  if (!selectedClip) return;
  pushUndo();
  if (selectedClip.type === "video") {
    const el = visualPlayers.get(selectedClip.id);
    if (el) {
      if (el instanceof HTMLVideoElement) el.pause();
      el.remove();
      visualPlayers.delete(selectedClip.id);
    }
    state.videoClips = state.videoClips.filter((c) => c.id !== selectedClip?.id);
  } else {
    const player = audioPlayers.get(selectedClip.id);
    if (player) {
      player.pause();
      audioPlayers.delete(selectedClip.id);
    }
    state.audioClips = state.audioClips.filter((c) => c.id !== selectedClip?.id);
  }
  selectedClip = null;
  renderAll();
  syncMediaToPlayhead(true);
}

// --- Preview & Playback ---
function getOrCreateVisualLayer(clip: VideoClip): HTMLVideoElement | HTMLImageElement {
  let el = visualPlayers.get(clip.id);
  if (!el) {
    if (clip.mediaType === "image") {
      const img = document.createElement("img");
      img.className = "preview-layer-media";
      img.src = clip.src;
      img.onload = () => updatePreviewStageStyle();
      el = img;
    } else {
      const vid = document.createElement("video");
      vid.className = "preview-layer-media";
      vid.playsInline = true;
      vid.src = clip.src;
      vid.addEventListener("loadedmetadata", () => updatePreviewStageStyle());
      el = vid;
    }
    previewLayers.appendChild(el);
    visualPlayers.set(clip.id, el);
  }
  return el;
}

function applyLayerStyle(el: HTMLElement, clip: VideoClip): void {
  const sx = clip.flipH ? -1 : 1;
  const sy = clip.flipV ? -1 : 1;
  el.style.zIndex = String(clip.trackIndex + 1);

  if (state.fitMode === "blur") {
    el.style.objectFit = "contain";
    el.style.objectPosition = "center";
    el.style.transform = `scaleX(${sx}) scaleY(${sy})`;
  } else if (state.fitMode === "fit") {
    el.style.objectFit = "contain";
    el.style.objectPosition = "center";
    el.style.transform = `translate(${clip.cropX * 50}%, ${clip.cropY * 50}%) scale(${clip.zoom * sx}, ${clip.zoom * sy})`;
  } else {
    el.style.objectFit = "cover";
    const px = 50 + clip.cropX * 50;
    const py = 50 + clip.cropY * 50;
    el.style.objectPosition = `${px}% ${py}%`;
    const z = Math.max(1, clip.zoom);
    el.style.transform = `scale(${z * sx}, ${z * sy})`;
  }
}

function updateTransformBox(clip: VideoClip | undefined): void {
  if (state.fitMode !== "fit" || !clip) {
    transformBox.classList.add("hidden");
    return;
  }

  const el = visualPlayers.get(clip.id);
  if (!el) {
    transformBox.classList.add("hidden");
    return;
  }

  const natW = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth;
  const natH = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight;
  const sw = previewStage.clientWidth;
  const sh = previewStage.clientHeight;
  if (!natW || !natH || !sw || !sh) {
    transformBox.classList.add("hidden");
    return;
  }

  const containScale = Math.min(sw / natW, sh / natH);
  const boxW = natW * containScale * clip.zoom;
  const boxH = natH * containScale * clip.zoom;
  const centerX = sw / 2 + clip.cropX * (sw / 2);
  const centerY = sh / 2 + clip.cropY * (sh / 2);

  transformBox.classList.remove("hidden");
  transformBox.style.width = `${boxW}px`;
  transformBox.style.height = `${boxH}px`;
  transformBox.style.left = `${centerX - boxW / 2}px`;
  transformBox.style.top = `${centerY - boxH / 2}px`;
}

function updatePreviewStageStyle(): void {
  previewStage.className = "preview-stage";
  if (state.aspectRatio === "custom") {
    previewStage.classList.add("ratio-custom");
    const cw = Math.max(1, state.customAspectW);
    const ch = Math.max(1, state.customAspectH);
    previewStage.style.aspectRatio = `${cw} / ${ch}`;
    previewStage.style.width = cw >= ch ? "90%" : "auto";
    previewStage.style.height = cw >= ch ? "auto" : "100%";
  } else {
    previewStage.style.aspectRatio = "";
    previewStage.style.width = "";
    previewStage.style.height = "";
    previewStage.classList.add(`ratio-${state.aspectRatio.replace(":", "-")}`);
  }

  const active = findActiveVideoClipsAtTime(playheadTime);
  const bgClip = active.find((a) => a.clip.mediaType === "video")?.clip;

  if (state.fitMode === "blur" && bgClip) {
    previewBgVideo.classList.remove("hidden");
    if (loadedBgSrc !== bgClip.src) {
      loadedBgSrc = bgClip.src;
      previewBgVideo.src = bgClip.src;
    }
    const sx = bgClip.flipH ? -1 : 1;
    const sy = bgClip.flipV ? -1 : 1;
    previewBgVideo.style.transform = `scale(${1.15 * sx}, ${1.15 * sy})`;
  } else {
    previewBgVideo.classList.add("hidden");
    if (!previewBgVideo.paused) previewBgVideo.pause();
  }

  for (const { clip } of active) {
    const el = visualPlayers.get(clip.id);
    if (el) applyLayerStyle(el, clip);
  }

  updateTransformBox(getTargetTransformClip(active));
}

function syncAudioPlayers(forceSeek: boolean): void {
  const active = findActiveAudioClipsAtTime(playheadTime);
  const activeIds = new Set(active.map((a) => a.clip.id));

  for (const [id, player] of audioPlayers.entries()) {
    if (!activeIds.has(id)) {
      player.pause();
    }
  }

  for (const { clip, localOffset } of active) {
    let player = audioPlayers.get(clip.id);
    if (!player) {
      player = new Audio(clip.src);
      audioPlayers.set(clip.id, player);
    } else if (player.src !== clip.src) {
      player.src = clip.src;
    }

    const targetTime = clip.startTime + localOffset;
    player.volume = clip.muted ? 0 : Math.min(1, clip.volume);

    if (player.readyState >= 1 && !player.seeking) {
      const drift = Math.abs(player.currentTime - targetTime);
      if ((forceSeek && drift > 0.05) || (!forceSeek && drift > 0.6)) {
        player.currentTime = targetTime;
      }
    }

    if (isPlaying && player.paused) {
      player.play().catch(() => {});
    } else if (!isPlaying && !player.paused) {
      player.pause();
    }
  }
}

function syncMediaToPlayhead(forceSeek = false): void {
  const totalV = getTotalVideoDuration();
  timecodeEl.textContent = `${formatTime(playheadTime)} / ${formatTime(totalV)}`;
  playheadEl.style.left = `${playheadTime * pxPerSec}px`;

  const active = findActiveVideoClipsAtTime(playheadTime);
  const activeIds = new Set(active.map((a) => a.clip.id));

  if (state.videoClips.length === 0) {
    previewEmpty.classList.remove("hidden");
  } else {
    previewEmpty.classList.add("hidden");
  }

  for (const [id, el] of visualPlayers.entries()) {
    if (!activeIds.has(id)) {
      el.style.display = "none";
      if (el instanceof HTMLVideoElement && !el.paused) {
        el.pause();
      }
    }
  }

  for (const { clip, localOffset } of active) {
    const el = getOrCreateVisualLayer(clip);
    el.style.display = "block";
    applyLayerStyle(el, clip);

    if (el instanceof HTMLVideoElement) {
      const targetSrcTime = clip.startTime + localOffset;
      const effVol =
        state.videoMuted || clip.muted
          ? 0
          : Math.min(1, clip.volume * state.videoVolume);
      el.volume = effVol;

      if (el.readyState >= 1) {
        const drift = Math.abs(el.currentTime - targetSrcTime);
        const needSeek = forceSeek ? drift > 0.05 : drift > 0.85;
        if (needSeek && !el.seeking) {
          el.currentTime = targetSrcTime;
        }
      } else {
        const seekOnce = () => {
          el.currentTime = targetSrcTime;
          if (isPlaying && el.paused) el.play().catch(() => {});
        };
        el.addEventListener("loadedmetadata", seekOnce, { once: true });
      }

      if (isPlaying && el.paused && !el.seeking) {
        el.play().catch(() => {});
      } else if (!isPlaying && !el.paused) {
        el.pause();
      }
    }
  }

  // Sync blur bg video if active
  const bgItem = active.find((a) => a.clip.mediaType === "video");
  if (state.fitMode === "blur" && bgItem) {
    const targetBg = bgItem.clip.startTime + bgItem.localOffset;
    if (loadedBgSrc !== bgItem.clip.src) {
      loadedBgSrc = bgItem.clip.src;
      previewBgVideo.src = bgItem.clip.src;
    }
    if (previewBgVideo.readyState >= 1 && !previewBgVideo.seeking) {
      const drift = Math.abs(previewBgVideo.currentTime - targetBg);
      if ((forceSeek && drift > 0.05) || drift > 0.85) {
        previewBgVideo.currentTime = targetBg;
      }
    }
    if (isPlaying && previewBgVideo.paused && !previewBgVideo.seeking) {
      previewBgVideo.play().catch(() => {});
    } else if (!isPlaying && !previewBgVideo.paused) {
      previewBgVideo.pause();
    }
  } else if (!previewBgVideo.paused) {
    previewBgVideo.pause();
  }

  syncAudioPlayers(forceSeek);
  updatePreviewStageStyle();
}

function togglePlay(): void {
  if (state.videoClips.length === 0 && state.audioClips.length === 0) return;
  isPlaying = !isPlaying;
  btnPlay.textContent = isPlaying ? "⏸" : "▶";

  if (isPlaying) {
    const total = Math.max(
      getTotalVideoDuration(),
      ...state.audioClips.map((a) => a.timelineStart + clipDur(a)),
      0
    );
    if (playheadTime >= total - 0.05) {
      playheadTime = 0;
    }
    syncMediaToPlayhead(true);
    lastFrameTs = performance.now();
    rafId = requestAnimationFrame(tickPlayback);
  } else {
    for (const el of visualPlayers.values()) {
      if (el instanceof HTMLVideoElement) el.pause();
    }
    previewBgVideo.pause();
    for (const player of audioPlayers.values()) player.pause();
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function tickPlayback(now: number): void {
  if (!isPlaying) return;
  const dt = Math.min(0.1, (now - lastFrameTs) / 1000);
  lastFrameTs = now;
  playheadTime += dt;

  const total = Math.max(
    getTotalVideoDuration(),
    ...state.audioClips.map((a) => a.timelineStart + clipDur(a)),
    0
  );
  if (playheadTime >= total) {
    playheadTime = total;
    isPlaying = false;
    btnPlay.textContent = "▶";
    for (const el of visualPlayers.values()) {
      if (el instanceof HTMLVideoElement) el.pause();
    }
    previewBgVideo.pause();
    for (const player of audioPlayers.values()) player.pause();
    syncMediaToPlayhead(true);
    return;
  }

  syncMediaToPlayhead(false);
  rafId = requestAnimationFrame(tickPlayback);
}

function seekTo(time: number): void {
  const maxT = getTotalTimelineDuration();
  playheadTime = Math.max(0, Math.min(time, maxT));
  syncMediaToPlayhead(true);
}

// --- Rendering & Live Drag ---
function clampNonOverlappingStart(
  proposed: number,
  clipId: string,
  trackIndex: number,
  dur: number,
  peers: { id: string; trackIndex: number; timelineStart: number; startTime: number; endTime: number }[]
): number {
  let start = Math.max(0, proposed);
  const others = peers
    .filter((c) => c.id !== clipId && c.trackIndex === trackIndex)
    .sort((a, b) => a.timelineStart - b.timelineStart);

  for (const o of others) {
    const oStart = o.timelineStart;
    const oEnd = o.timelineStart + clipDur(o);
    if (start < oEnd && start + dur > oStart) {
      const snapLeft = oStart - dur;
      const snapRight = oEnd;
      if (snapLeft >= 0 && Math.abs(start - snapLeft) <= Math.abs(start - snapRight)) {
        start = snapLeft;
      } else {
        start = snapRight;
      }
    }
  }
  return Math.max(0, start);
}

function attachClipDrag(
  el: HTMLElement,
  kind: "video" | "audio",
  clip: VideoClip | AudioClip,
  onSelect: () => void
): void {
  el.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    onSelect();

    const startX = e.clientX;
    const startY = e.clientY;
    const origStart = clip.timelineStart;
    const origTrack = clip.trackIndex;
    const dur = clipDur(clip);
    let moved = false;

    const badge = document.createElement("span");
    badge.className = "clip-drag-badge hidden";
    el.appendChild(badge);

    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if ((Math.abs(dx) > 3 || Math.abs(dy) > 12) && !moved) {
        pushUndo();
        moved = true;
        el.classList.add("dragging");
        badge.classList.remove("hidden");
      }
      if (!moved) return;

      const laneShift = Math.round(dy / 60);
      let targetTrack = origTrack;
      if (kind === "video") {
        targetTrack = Math.max(0, origTrack - laneShift);
      } else {
        targetTrack = Math.max(0, origTrack + (laneShift < 0 ? Math.abs(laneShift) : laneShift));
      }

      const peers = kind === "video" ? state.videoClips : state.audioClips;
      const clampedStart = clampNonOverlappingStart(
        origStart + dx / pxPerSec,
        clip.id,
        targetTrack,
        dur,
        peers
      );

      clip.trackIndex = targetTrack;
      clip.timelineStart = clampedStart;
      el.style.left = `${clampedStart * pxPerSec}px`;
      el.style.transform = `translateY(${dy}px)`;
      badge.textContent = formatTime(clampedStart).slice(0, 7);
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      el.classList.remove("dragging");
      el.style.transform = "";
      badge.remove();
      if (moved) {
        renderTimeline();
        renderInspector();
        syncMediaToPlayhead(true);
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
}

function renderTimeline(): void {
  const totalSec = getTotalTimelineDuration();
  const widthPx = Math.max(timelineScroll.clientWidth, (totalSec + 4) * pxPerSec);
  timelineCanvas.style.width = `${widthPx}px`;

  timeRuler.innerHTML = "";
  const step = pxPerSec >= 60 ? 1 : pxPerSec >= 25 ? 2 : 5;
  for (let s = 0; s <= totalSec + 4; s += step) {
    const tick = document.createElement("div");
    tick.className = "ruler-tick";
    tick.style.left = `${s * pxPerSec}px`;
    tick.textContent = formatTime(s).slice(0, 5);
    timeRuler.appendChild(tick);
  }

  const videoTrackIndices = Array.from(
    new Set(state.videoClips.map((c) => c.trackIndex))
  ).sort((a, b) => b - a);
  if (videoTrackIndices.length === 0) videoTrackIndices.push(0);

  const audioTrackIndices = Array.from(
    new Set(state.audioClips.map((c) => c.trackIndex))
  ).sort((a, b) => a - b);
  if (audioTrackIndices.length === 0) audioTrackIndices.push(0);

  timelineHeaders.innerHTML = '<div class="ruler-corner">Tempo</div>';
  tracksLanes.innerHTML = "";

  // Render Video/Image Tracks
  for (const tIdx of videoTrackIndices) {
    const trackColor = getTrackColor("video", tIdx);
    const trackBg = hexToRgba(trackColor, 0.32);

    const header = document.createElement("div");
    header.className = "track-header";
    header.style.setProperty("--track-color", trackColor);
    const hasImage = state.videoClips.some((c) => c.trackIndex === tIdx && c.mediaType === "image");
    header.textContent = `${hasImage ? "🖼" : "🎬"} Camada ${tIdx + 1}`;
    timelineHeaders.appendChild(header);

    const lane = document.createElement("div");
    lane.className = "track-lane";

    for (const clip of state.videoClips.filter((c) => c.trackIndex === tIdx)) {
      const dur = clipDur(clip);
      const el = document.createElement("div");
      el.className = "clip";
      el.style.setProperty("--track-color", trackColor);
      el.style.setProperty("--track-bg", trackBg);
      if (selectedClip?.type === "video" && selectedClip.id === clip.id) {
        el.classList.add("selected");
      }
      el.style.left = `${clip.timelineStart * pxPerSec}px`;
      el.style.width = `${Math.max(48, dur * pxPerSec)}px`;

      const thumbHtml = clip.thumbUrl
        ? `<img class="clip-thumb" src="${clip.thumbUrl}" alt="" />`
        : "";
      el.innerHTML = `
        <div class="clip-accent-bar"></div>
        ${thumbHtml}
        <div class="clip-info">
          <span class="clip-title">${clip.mediaType === "image" ? "🖼 " : ""}${clip.name}</span>
          <span class="clip-meta">${dur.toFixed(1)}s${clip.muted && clip.mediaType === "video" ? " 🔇" : ""}${clip.flipH || clip.flipV ? " ⇄" : ""}</span>
        </div>
      `;

      attachClipDrag(el, "video", clip, () => {
        selectedClip = { type: "video", id: clip.id };
        renderTimeline();
        renderInspector();
        updatePreviewStageStyle();
      });
      lane.appendChild(el);
    }

    tracksLanes.appendChild(lane);
  }

  // Render Audio Tracks
  for (const tIdx of audioTrackIndices) {
    const trackColor = getTrackColor("audio", tIdx);
    const trackBg = hexToRgba(trackColor, 0.32);

    const header = document.createElement("div");
    header.className = "track-header";
    header.style.setProperty("--track-color", trackColor);
    header.textContent = `🎵 Áudio ${tIdx + 1}`;
    timelineHeaders.appendChild(header);

    const lane = document.createElement("div");
    lane.className = "track-lane";

    for (const aclip of state.audioClips.filter((c) => c.trackIndex === tIdx)) {
      const dur = clipDur(aclip);
      const el = document.createElement("div");
      el.className = "clip";
      el.style.setProperty("--track-color", trackColor);
      el.style.setProperty("--track-bg", trackBg);
      if (selectedClip?.type === "audio" && selectedClip.id === aclip.id) {
        el.classList.add("selected");
      }
      el.style.left = `${aclip.timelineStart * pxPerSec}px`;
      el.style.width = `${Math.max(40, dur * pxPerSec)}px`;
      el.innerHTML = `
        <div class="clip-accent-bar"></div>
        <div class="clip-info">
          <span class="clip-title">🎵 ${aclip.name}</span>
          <span class="clip-meta">${dur.toFixed(1)}s${aclip.muted ? " 🔇" : ""}</span>
        </div>
      `;
      attachClipDrag(el, "audio", aclip, () => {
        selectedClip = { type: "audio", id: aclip.id };
        renderTimeline();
        renderInspector();
      });
      lane.appendChild(el);
    }

    tracksLanes.appendChild(lane);
  }

  playheadEl.style.left = `${playheadTime * pxPerSec}px`;
}

function renderInspector(): void {
  if (!selectedClip) {
    inspectorBadge.textContent = "Nada selecionado";
    inspectorBody.innerHTML =
      '<p class="empty-msg">Selecione um clipe na timeline para ajustar volume, espelhamento, corte ou enquadramento.</p>';
    return;
  }

  if (selectedClip.type === "video") {
    const clip = state.videoClips.find((c) => c.id === selectedClip?.id);
    if (!clip) return;
    inspectorBadge.textContent = `${clip.mediaType === "image" ? "Imagem" : "Vídeo"} • Camada ${clip.trackIndex + 1}`;

    const audioControls =
      clip.mediaType === "video"
        ? `
      <div class="field">
        <div class="field-row">
          <label>Volume do Clipe</label>
          <span>${Math.round(clip.volume * 100)}%</span>
        </div>
        <input id="ins-vol" type="range" min="0" max="1.5" step="0.05" value="${clip.volume}" />
      </div>
      <div class="field">
        <label><input id="ins-mute" type="checkbox" ${clip.muted ? "checked" : ""} /> Silenciar este clipe</label>
      </div>`
        : `
      <div class="field">
        <div class="field-row">
          <label>Duração da Imagem (s)</label>
          <span id="ins-dur-val">${clipDur(clip).toFixed(1)}s</span>
        </div>
        <input id="ins-img-dur" type="range" min="0.5" max="30" step="0.5" value="${clipDur(clip)}" />
      </div>`;

    inspectorBody.innerHTML = `
      <div class="field">
        <div class="field-row"><strong>${clip.name}</strong><span>${clipDur(clip).toFixed(1)}s</span></div>
      </div>
      ${audioControls}
      <div class="field">
        <div class="field-row"><label>Tamanho / Zoom</label><span>${clip.zoom.toFixed(2)}x</span></div>
        <input id="ins-zoom" type="range" min="0.2" max="3" step="0.05" value="${clip.zoom}" />
      </div>
      <div class="field">
        <div class="field-row"><label>Posição Horizontal</label><span>${Math.round(clip.cropX * 100)}%</span></div>
        <input id="ins-cx" type="range" min="-1.5" max="1.5" step="0.05" value="${clip.cropX}" />
      </div>
      <div class="field">
        <div class="field-row"><label>Posição Vertical</label><span>${Math.round(clip.cropY * 100)}%</span></div>
        <input id="ins-cy" type="range" min="-1.5" max="1.5" step="0.05" value="${clip.cropY}" />
      </div>
      <div class="inspector-actions">
        <button id="ins-fliph" class="btn btn-secondary btn-toggle ${clip.flipH ? "active" : ""}">⇄ Espelhar H</button>
        <button id="ins-flipv" class="btn btn-secondary btn-toggle ${clip.flipV ? "active" : ""}">⇅ Espelhar V</button>
      </div>
      <p class="hint">Arraste o clipe na timeline para mover no tempo ou para cima/baixo para criar camadas.</p>
    `;

    if (clip.mediaType === "video") {
      (document.getElementById("ins-vol") as HTMLInputElement).oninput = (e) => {
        clip.volume = parseFloat((e.target as HTMLInputElement).value);
        hasUnsavedChanges = true;
        syncMediaToPlayhead(false);
      };
      (document.getElementById("ins-mute") as HTMLInputElement).onchange = (e) => {
        pushUndo();
        clip.muted = (e.target as HTMLInputElement).checked;
        renderTimeline();
        syncMediaToPlayhead(false);
      };
    } else {
      (document.getElementById("ins-img-dur") as HTMLInputElement).oninput = (e) => {
        const d = parseFloat((e.target as HTMLInputElement).value);
        clip.endTime = clip.startTime + d;
        hasUnsavedChanges = true;
        document.getElementById("ins-dur-val")!.textContent = `${d.toFixed(1)}s`;
        renderTimeline();
      };
    }

    (document.getElementById("ins-zoom") as HTMLInputElement).oninput = (e) => {
      clip.zoom = parseFloat((e.target as HTMLInputElement).value);
      hasUnsavedChanges = true;
      updatePreviewStageStyle();
    };
    (document.getElementById("ins-cx") as HTMLInputElement).oninput = (e) => {
      clip.cropX = parseFloat((e.target as HTMLInputElement).value);
      hasUnsavedChanges = true;
      updatePreviewStageStyle();
    };
    (document.getElementById("ins-cy") as HTMLInputElement).oninput = (e) => {
      clip.cropY = parseFloat((e.target as HTMLInputElement).value);
      hasUnsavedChanges = true;
      updatePreviewStageStyle();
    };
    (document.getElementById("ins-fliph") as HTMLButtonElement).onclick = () => {
      pushUndo();
      clip.flipH = !clip.flipH;
      renderInspector();
      renderTimeline();
      updatePreviewStageStyle();
    };
    (document.getElementById("ins-flipv") as HTMLButtonElement).onclick = () => {
      pushUndo();
      clip.flipV = !clip.flipV;
      renderInspector();
      renderTimeline();
      updatePreviewStageStyle();
    };
  } else {
    const aclip = state.audioClips.find((c) => c.id === selectedClip?.id);
    if (!aclip) return;
    inspectorBadge.textContent = `Áudio ${aclip.trackIndex + 1}`;
    inspectorBody.innerHTML = `
      <div class="field">
        <div class="field-row"><strong>${aclip.name}</strong><span>${clipDur(aclip).toFixed(1)}s</span></div>
      </div>
      <div class="field">
        <div class="field-row">
          <label>Volume da Música</label>
          <span>${Math.round(aclip.volume * 100)}%</span>
        </div>
        <input id="ins-avol" type="range" min="0" max="1.5" step="0.05" value="${aclip.volume}" />
      </div>
      <div class="field">
        <label><input id="ins-amute" type="checkbox" ${aclip.muted ? "checked" : ""} /> Silenciar faixa</label>
      </div>
      <p class="hint">Arraste o clipe na timeline para ajustar em que momento a música começa ou criar camadas.</p>
    `;

    (document.getElementById("ins-avol") as HTMLInputElement).oninput = (e) => {
      aclip.volume = parseFloat((e.target as HTMLInputElement).value);
      hasUnsavedChanges = true;
      syncMediaToPlayhead(false);
    };
    (document.getElementById("ins-amute") as HTMLInputElement).onchange = (e) => {
      pushUndo();
      aclip.muted = (e.target as HTMLInputElement).checked;
      renderTimeline();
      syncMediaToPlayhead(false);
    };
  }
}

function renderShortcutBadges(): void {
  document.querySelectorAll<HTMLElement>("[data-shortcut-label]").forEach((el) => {
    const action = el.dataset.shortcutLabel as ShortcutAction;
    el.textContent = formatShortcutDisplay(shortcuts[action] || "");
  });
}

function renderShortcutsModal(): void {
  shortcutsList.innerHTML = "";
  (Object.keys(SHORTCUT_LABELS) as ShortcutAction[]).forEach((action) => {
    const row = document.createElement("div");
    row.className = "shortcut-row";
    const isRec = recordingAction === action;
    row.innerHTML = `
      <span>${SHORTCUT_LABELS[action]}</span>
      <button class="shortcut-key-btn ${isRec ? "recording" : ""}">
        ${isRec ? "Pressione tecla..." : formatShortcutDisplay(shortcuts[action])}
      </button>
    `;
    const btn = row.querySelector("button") as HTMLButtonElement;
    btn.onclick = () => {
      recordingAction = action;
      renderShortcutsModal();
    };
    shortcutsList.appendChild(row);
  });
}

function renderAll(): void {
  renderTimeline();
  renderInspector();
  renderShortcutBadges();
  updatePreviewStageStyle();
}

// --- Export ---
async function exportVideo(): Promise<void> {
  if (state.videoClips.length === 0) {
    alert("Adicione pelo menos um vídeo ou imagem na timeline antes de exportar.");
    return;
  }

  const outputPath = await save({
    defaultPath: "toktuja-export.mp4",
    filters: [{ name: "Vídeo MP4", extensions: ["mp4"] }],
  });
  if (!outputPath) return;

  modalExport.classList.remove("hidden");
  btnCloseExport.classList.add("hidden");
  exportFill.style.width = "0%";
  exportStatus.textContent = "Iniciando renderização com FFmpeg...";

  try {
    const resVal = (document.getElementById("export-resolution") as HTMLSelectElement).value || "1080p";
    const fpsVal = parseInt((document.getElementById("export-fps") as HTMLSelectElement).value || "30", 10);

    const resultPath = await invoke<string>("export_project", {
      request: {
        video_clips: state.videoClips.map((c) => ({
          path: c.path,
          media_type: c.mediaType,
          start_time: c.startTime,
          end_time: c.endTime,
          timeline_start: c.timelineStart,
          track_index: c.trackIndex,
          volume: c.volume,
          muted: c.muted,
          has_audio: c.hasAudio,
          crop_x: c.cropX,
          crop_y: c.cropY,
          zoom: c.zoom,
          flip_h: c.flipH,
          flip_v: c.flipV,
        })),
        audio_clips: state.audioClips.map((a) => ({
          path: a.path,
          start_time: a.startTime,
          end_time: a.endTime,
          timeline_start: a.timelineStart,
          volume: a.volume,
          muted: a.muted,
        })),
        aspect_ratio: state.aspectRatio,
        custom_aspect_w: state.customAspectW,
        custom_aspect_h: state.customAspectH,
        resolution: resVal,
        fps: fpsVal,
        fit_mode: state.fitMode,
        video_volume: state.videoVolume,
        video_muted: state.videoMuted,
        output_path: outputPath,
      },
    });
    exportFill.style.width = "100%";
    exportStatus.textContent = `Concluído! Salvo em: ${resultPath}`;
    hasUnsavedChanges = false;
  } catch (err) {
    exportStatus.textContent = `Erro: ${String(err)}`;
  } finally {
    btnCloseExport.classList.remove("hidden");
  }
}

// --- Event Wiring ---
function initEvents(): void {
  document.getElementById("btn-open-draft")!.onclick = () => void openDraftDialog();
  document.getElementById("btn-save-draft")!.onclick = () => void saveDraft();
  document.getElementById("btn-add-video")!.onclick = openVideoDialog;
  document.getElementById("btn-add-image")!.onclick = openImageDialog;
  document.getElementById("btn-add-audio")!.onclick = openAudioDialog;
  document.getElementById("btn-split")!.onclick = splitAtPlayhead;
  document.getElementById("btn-trim-start")!.onclick = trimStartAtPlayhead;
  document.getElementById("btn-trim-end")!.onclick = trimEndAtPlayhead;
  document.getElementById("btn-delete")!.onclick = deleteSelectedClip;
  document.getElementById("btn-undo")!.onclick = undo;
  document.getElementById("btn-redo")!.onclick = redo;
  document.getElementById("btn-export")!.onclick = exportVideo;

  btnPlay.onclick = togglePlay;
  document.getElementById("btn-step-back")!.onclick = () => seekTo(playheadTime - 0.5);
  document.getElementById("btn-step-forward")!.onclick = () => seekTo(playheadTime + 0.5);

  btnMuteMaster.onclick = () => {
    state.videoMuted = !state.videoMuted;
    btnMuteMaster.textContent = state.videoMuted ? "🔇" : "🔊";
    syncMediaToPlayhead(false);
  };
  masterVolInput.oninput = () => {
    state.videoVolume = parseFloat(masterVolInput.value);
    syncMediaToPlayhead(false);
  };

  document.getElementById("btn-zoom-in")!.onclick = () => {
    pxPerSec = Math.min(140, pxPerSec + 15);
    renderTimeline();
  };
  document.getElementById("btn-zoom-out")!.onclick = () => {
    pxPerSec = Math.max(15, pxPerSec - 15);
    renderTimeline();
  };

  // Aspect & Fit Selectors
  document.querySelectorAll<HTMLButtonElement>("#aspect-selector button").forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll("#aspect-selector button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.aspectRatio = btn.dataset.aspect as AspectRatio;
      customAspectBox.classList.toggle("hidden", state.aspectRatio !== "custom");
      hasUnsavedChanges = true;
      updatePreviewStageStyle();
    };
  });

  customWInput.oninput = () => {
    state.customAspectW = Math.max(1, parseInt(customWInput.value || "16", 10));
    hasUnsavedChanges = true;
    updatePreviewStageStyle();
  };
  customHInput.oninput = () => {
    state.customAspectH = Math.max(1, parseInt(customHInput.value || "10", 10));
    hasUnsavedChanges = true;
    updatePreviewStageStyle();
  };

  document.querySelectorAll<HTMLButtonElement>("#fit-selector button").forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll("#fit-selector button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.fitMode = btn.dataset.fit as FitMode;
      hasUnsavedChanges = true;
      updatePreviewStageStyle();
    };
  });

  // Ruler scrubbing
  const scrubFromClientX = (clientX: number) => {
    const rect = timeRuler.getBoundingClientRect();
    const x = Math.max(0, clientX - rect.left);
    seekTo(x / pxPerSec);
  };

  timeRuler.addEventListener("mousedown", (e) => {
    scrubFromClientX(e.clientX);
    const onMove = (ev: MouseEvent) => scrubFromClientX(ev.clientX);
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });

  // Shortcuts Modal
  document.getElementById("btn-shortcuts")!.onclick = () => {
    recordingAction = null;
    renderShortcutsModal();
    modalShortcuts.classList.remove("hidden");
  };
  document.getElementById("btn-close-shortcuts")!.onclick = () => {
    recordingAction = null;
    modalShortcuts.classList.add("hidden");
  };
  document.getElementById("btn-done-shortcuts")!.onclick = () => {
    recordingAction = null;
    modalShortcuts.classList.add("hidden");
  };
  document.getElementById("btn-reset-shortcuts")!.onclick = () => {
    shortcuts = { ...DEFAULT_SHORTCUTS };
    saveShortcuts(shortcuts);
    recordingAction = null;
    renderShortcutsModal();
    renderShortcutBadges();
  };

  btnCloseExport.onclick = () => modalExport.classList.add("hidden");

  // Keyboard shortcuts handler
  window.addEventListener("keydown", (e) => {
    if (recordingAction) {
      e.preventDefault();
      const combo = eventToShortcutString(e);
      if (!combo) return;
      shortcuts[recordingAction] = combo;
      saveShortcuts(shortcuts);
      recordingAction = null;
      renderShortcutsModal();
      renderShortcutBadges();
      return;
    }

    const activeTag = document.activeElement?.tagName;
    if (activeTag === "INPUT" && (document.activeElement as HTMLInputElement).type !== "range") {
      return;
    }

    const combo = eventToShortcutString(e);
    if (!combo) return;

    const actionMap: Record<ShortcutAction, () => void> = {
      playPause: togglePlay,
      split: splitAtPlayhead,
      addVideo: () => void openVideoDialog(),
      addImage: () => void openImageDialog(),
      addAudio: () => void openAudioDialog(),
      trimStart: trimStartAtPlayhead,
      trimEnd: trimEndAtPlayhead,
      deleteClip: deleteSelectedClip,
      stepBack: () => seekTo(playheadTime - 0.2),
      stepForward: () => seekTo(playheadTime + 0.2),
      undo,
      redo,
      exportVideo: () => void exportVideo(),
    };

    for (const [act, keyCombo] of Object.entries(shortcuts) as [ShortcutAction, string][]) {
      if (keyCombo.toLowerCase() === combo.toLowerCase()) {
        e.preventDefault();
        actionMap[act]();
        return;
      }
    }
  });

  // Drag & Drop via Tauri webview
  getCurrentWebview()
    .onDragDropEvent((event) => {
      if (event.payload.type === "drop") {
        void importFiles(event.payload.paths);
      }
    })
    .catch(() => {});

  // Close confirmation when unexported changes exist
  const appWindow = getCurrentWindow();
  appWindow
    .onCloseRequested((event) => {
      if (hasUnsavedChanges && (state.videoClips.length > 0 || state.audioClips.length > 0)) {
        event.preventDefault();
        modalCloseDraft.classList.remove("hidden");
      }
    })
    .catch(() => {});

  document.getElementById("btn-close-cancel")!.onclick = () => {
    modalCloseDraft.classList.add("hidden");
  };
  document.getElementById("btn-close-discard")!.onclick = () => {
    hasUnsavedChanges = false;
    modalCloseDraft.classList.add("hidden");
    void appWindow.destroy();
  };
  document.getElementById("btn-close-save")!.onclick = async () => {
    const saved = await saveDraft();
    if (saved) {
      modalCloseDraft.classList.add("hidden");
      void appWindow.destroy();
    }
  };

  // Direct mouse transform on preview (drag to move, corner handles to resize, wheel to zoom)
  transformBox.addEventListener("mousedown", (e) => {
    const active = findActiveVideoClipsAtTime(playheadTime);
    const clip = getTargetTransformClip(active);
    if (!clip || state.fitMode !== "fit") return;
    e.preventDefault();
    e.stopPropagation();

    selectedClip = { type: "video", id: clip.id };
    const handle = (e.target as HTMLElement).dataset.handle;
    const rect = previewStage.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2 + clip.cropX * (rect.width / 2);
    const centerY = rect.top + rect.height / 2 + clip.cropY * (rect.height / 2);

    pushUndo();

    if (handle) {
      const initDist = Math.max(10, Math.hypot(e.clientX - centerX, e.clientY - centerY));
      const origZoom = clip.zoom;

      const onMove = (ev: MouseEvent) => {
        const dist = Math.max(10, Math.hypot(ev.clientX - centerX, ev.clientY - centerY));
        clip.zoom = Math.max(0.2, Math.min(3.0, origZoom * (dist / initDist)));
        updatePreviewStageStyle();
        renderInspector();
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    } else {
      const startX = e.clientX;
      const startY = e.clientY;
      const origCX = clip.cropX;
      const origCY = clip.cropY;

      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        clip.cropX = Math.max(-1.5, Math.min(1.5, origCX + dx / (rect.width / 2)));
        clip.cropY = Math.max(-1.5, Math.min(1.5, origCY + dy / (rect.height / 2)));
        updatePreviewStageStyle();
        renderInspector();
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    }
  });

  previewStage.addEventListener(
    "wheel",
    (e) => {
      const active = findActiveVideoClipsAtTime(playheadTime);
      const clip = getTargetTransformClip(active);
      if (!clip || (state.fitMode !== "fit" && state.fitMode !== "crop")) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.08 : -0.08;
      const minZ = state.fitMode === "crop" ? 1.0 : 0.2;
      clip.zoom = Math.max(minZ, Math.min(3.0, clip.zoom + delta));
      hasUnsavedChanges = true;
      updatePreviewStageStyle();
      renderInspector();
    },
    { passive: false }
  );

  window.addEventListener("resize", () => updatePreviewStageStyle());

  // Export progress event
  listen<{ percent: number; status: string }>("export-progress", (event) => {
    exportFill.style.width = `${event.payload.percent}%`;
    exportStatus.textContent = event.payload.status;
  }).catch(() => {});
}

// --- Boot ---
initEvents();
renderAll();
syncMediaToPlayhead(true);

invoke<string | null>("get_startup_draft")
  .then((draftPath) => {
    if (draftPath) void loadDraft(draftPath);
  })
  .catch(() => {});
