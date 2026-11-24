import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
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

// --- State ---
let state: ProjectState = {
  videoClips: [],
  audioClips: [],
  aspectRatio: "9:16",
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
let loadedVideoSrc = "";
let activeVideoClipId: string | null = null;
let pendingVideoSeek: number | null = null;

const audioPlayers = new Map<string, HTMLAudioElement>();

// --- DOM Refs ---
const previewStage = document.getElementById("preview-stage") as HTMLDivElement;
const previewVideo = document.getElementById("preview-video") as HTMLVideoElement;
const previewBgVideo = document.getElementById("preview-bg-video") as HTMLVideoElement;
const previewEmpty = document.getElementById("preview-empty") as HTMLDivElement;
const timecodeEl = document.getElementById("timecode") as HTMLSpanElement;
const btnPlay = document.getElementById("btn-play") as HTMLButtonElement;
const btnMuteMaster = document.getElementById("btn-mute-master") as HTMLButtonElement;
const masterVolInput = document.getElementById("master-video-volume") as HTMLInputElement;

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

// --- Helpers ---
function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function pushUndo(): void {
  undoStack.push(JSON.stringify(state));
  if (undoStack.length > 40) undoStack.shift();
  redoStack = [];
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

function findTopVideoClipAtTime(t: number): {
  clip: VideoClip;
  localOffset: number;
} | null {
  const active = state.videoClips.filter((c) => {
    const dur = clipDur(c);
    return t >= c.timelineStart && t < c.timelineStart + dur;
  });
  if (active.length === 0) return null;
  active.sort((a, b) => b.trackIndex - a.trackIndex);
  const clip = active[0];
  return { clip, localOffset: t - clip.timelineStart };
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

// --- Media Import ---
async function importFiles(paths: string[]): Promise<void> {
  const videoExts = [".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"];
  const audioExts = [".mp3", ".wav", ".aac", ".m4a", ".ogg", ".flac"];

  pushUndo();
  for (const p of paths) {
    const lower = p.toLowerCase();
    const isVideo = videoExts.some((ext) => lower.endsWith(ext));
    const isAudio = audioExts.some((ext) => lower.endsWith(ext));
    if (!isVideo && !isAudio) continue;

    try {
      const meta = await invoke<MediaMetadata>("probe_media", { path: p });
      const src = convertFileSrc(p);

      if (isVideo && meta.has_video) {
        const clip: VideoClip = {
          id: uid(),
          path: p,
          src,
          name: meta.name,
          originalDuration: meta.duration || 5,
          startTime: 0,
          endTime: meta.duration || 5,
          timelineStart: getTotalVideoDuration(),
          trackIndex: nextVideoTrackIndex(),
          volume: 1.0,
          muted: false,
          hasAudio: meta.has_audio,
          cropX: 0,
          cropY: 0,
          zoom: 1.0,
        };
        state.videoClips.push(clip);
        selectedClip = { type: "video", id: clip.id };
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
    const top = findTopVideoClipAtTime(playheadTime);
    if (top) {
      targetIdx = state.videoClips.findIndex((c) => c.id === top.clip.id);
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
function updatePreviewStageStyle(): void {
  previewStage.className = "preview-stage";
  previewStage.classList.add(`ratio-${state.aspectRatio.replace(":", "-")}`);

  const found = findTopVideoClipAtTime(playheadTime);
  const clip = found?.clip;

  if (state.fitMode === "blur") {
    previewBgVideo.classList.remove("hidden");
    previewVideo.style.objectFit = "contain";
    previewVideo.style.objectPosition = "center";
    previewVideo.style.transform = "none";
  } else if (state.fitMode === "fit") {
    previewBgVideo.classList.add("hidden");
    previewVideo.style.objectFit = "contain";
    previewVideo.style.objectPosition = "center";
    if (clip) {
      previewVideo.style.transform = `translate(${clip.cropX * 50}%, ${clip.cropY * 50}%) scale(${clip.zoom})`;
    } else {
      previewVideo.style.transform = "none";
    }
  } else {
    previewBgVideo.classList.add("hidden");
    previewVideo.style.objectFit = "cover";
    const px = clip ? 50 + clip.cropX * 50 : 50;
    const py = clip ? 50 + clip.cropY * 50 : 50;
    previewVideo.style.objectPosition = `${px}% ${py}%`;
    previewVideo.style.transform = clip ? `scale(${Math.max(1, clip.zoom)})` : "none";
  }
}

previewVideo.addEventListener("loadedmetadata", () => {
  if (pendingVideoSeek !== null) {
    previewVideo.currentTime = pendingVideoSeek;
    if (state.fitMode === "blur") {
      previewBgVideo.currentTime = pendingVideoSeek;
    }
    pendingVideoSeek = null;
  }
  if (isPlaying && previewVideo.paused) {
    previewVideo.play().catch(() => {});
  }
});

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

  const foundV = findTopVideoClipAtTime(playheadTime);
  if (!foundV) {
    activeVideoClipId = null;
    if (state.videoClips.length === 0) {
      previewEmpty.classList.remove("hidden");
    } else {
      previewEmpty.classList.add("hidden");
    }
    if (!previewVideo.paused) previewVideo.pause();
    if (!previewBgVideo.paused) previewBgVideo.pause();
    if (state.videoClips.length === 0 && loadedVideoSrc) {
      previewVideo.removeAttribute("src");
      previewBgVideo.removeAttribute("src");
      loadedVideoSrc = "";
    }
  } else {
    previewEmpty.classList.add("hidden");
    const { clip, localOffset } = foundV;
    const targetSrcTime = clip.startTime + localOffset;
    const clipChanged = activeVideoClipId !== clip.id;
    activeVideoClipId = clip.id;

    if (loadedVideoSrc !== clip.src) {
      loadedVideoSrc = clip.src;
      pendingVideoSeek = targetSrcTime;
      previewVideo.src = clip.src;
      previewBgVideo.src = clip.src;
    } else {
      const effVol =
        state.videoMuted || clip.muted
          ? 0
          : Math.min(1, clip.volume * state.videoVolume);
      previewVideo.volume = effVol;

      if (previewVideo.readyState >= 1) {
        const drift = Math.abs(previewVideo.currentTime - targetSrcTime);
        const needSeek = forceSeek
          ? drift > 0.05
          : clipChanged
            ? drift > 0.5
            : drift > 0.85;

        if (needSeek && !previewVideo.seeking) {
          previewVideo.currentTime = targetSrcTime;
          if (state.fitMode === "blur") {
            previewBgVideo.currentTime = targetSrcTime;
          }
        }
      } else {
        pendingVideoSeek = targetSrcTime;
      }

      if (isPlaying && previewVideo.paused && !previewVideo.seeking) {
        previewVideo.play().catch(() => {});
      }
      if (isPlaying && state.fitMode === "blur" && previewBgVideo.paused && !previewBgVideo.seeking) {
        previewBgVideo.play().catch(() => {});
      }
    }
  }

  syncAudioPlayers(forceSeek);
  updatePreviewStageStyle();
}

function togglePlay(): void {
  if (state.videoClips.length === 0 && state.audioClips.length === 0) return;
  isPlaying = !isPlaying;
  btnPlay.textContent = isPlaying ? "⏸" : "▶";

  if (isPlaying) {
    const total = Math.max(getTotalVideoDuration(), ...state.audioClips.map((a) => a.timelineStart + clipDur(a)), 0);
    if (playheadTime >= total - 0.05) {
      playheadTime = 0;
    }
    syncMediaToPlayhead(true);
    lastFrameTs = performance.now();
    rafId = requestAnimationFrame(tickPlayback);
  } else {
    previewVideo.pause();
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
    previewVideo.pause();
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

// --- Rendering ---
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

    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if ((Math.abs(dx) > 3 || Math.abs(dy) > 18) && !moved) {
        pushUndo();
        moved = true;
      }
      if (!moved) return;

      const laneShift = Math.round(dy / 60);
      let targetTrack = origTrack;
      if (kind === "video") {
        // Video tracks render descending (V2 above V1), so dragging UP (dy < 0) increases trackIndex
        targetTrack = Math.max(0, origTrack - laneShift);
      } else {
        // Dragging UP or DOWN past A1 creates/switches audio layers
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
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
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

  // Ruler
  timeRuler.innerHTML = "";
  const step = pxPerSec >= 60 ? 1 : pxPerSec >= 25 ? 2 : 5;
  for (let s = 0; s <= totalSec + 4; s += step) {
    const tick = document.createElement("div");
    tick.className = "ruler-tick";
    tick.style.left = `${s * pxPerSec}px`;
    tick.textContent = formatTime(s).slice(0, 5);
    timeRuler.appendChild(tick);
  }

  // Dynamic tracks
  const videoTrackIndices = Array.from(
    new Set(state.videoClips.map((c) => c.trackIndex))
  ).sort((a, b) => b - a); // higher track on top
  if (videoTrackIndices.length === 0) videoTrackIndices.push(0);

  const audioTrackIndices = Array.from(
    new Set(state.audioClips.map((c) => c.trackIndex))
  ).sort((a, b) => a - b);
  if (audioTrackIndices.length === 0) audioTrackIndices.push(0);

  timelineHeaders.innerHTML = '<div class="ruler-corner">Tempo</div>';
  tracksLanes.innerHTML = "";

  // Render Video Tracks
  for (const tIdx of videoTrackIndices) {
    const header = document.createElement("div");
    header.className = "track-header";
    header.textContent = `🎬 Vídeo ${tIdx + 1}`;
    timelineHeaders.appendChild(header);

    const lane = document.createElement("div");
    lane.className = "track-lane";

    for (const clip of state.videoClips.filter((c) => c.trackIndex === tIdx)) {
      const dur = clipDur(clip);
      const el = document.createElement("div");
      el.className = "clip clip-video";
      if (selectedClip?.type === "video" && selectedClip.id === clip.id) {
        el.classList.add("selected");
      }
      el.style.left = `${clip.timelineStart * pxPerSec}px`;
      el.style.width = `${Math.max(24, dur * pxPerSec)}px`;
      el.innerHTML = `
        <span class="clip-title">${clip.name}</span>
        <span class="clip-meta">${dur.toFixed(1)}s${clip.muted ? " 🔇" : ""}</span>
      `;
      attachClipDrag(el, "video", clip, () => {
        selectedClip = { type: "video", id: clip.id };
        renderTimeline();
        renderInspector();
      });
      lane.appendChild(el);
    }

    tracksLanes.appendChild(lane);
  }

  // Render Audio Tracks
  for (const tIdx of audioTrackIndices) {
    const header = document.createElement("div");
    header.className = "track-header";
    header.textContent = `🎵 Áudio ${tIdx + 1}`;
    timelineHeaders.appendChild(header);

    const lane = document.createElement("div");
    lane.className = "track-lane";

    for (const aclip of state.audioClips.filter((c) => c.trackIndex === tIdx)) {
      const dur = clipDur(aclip);
      const el = document.createElement("div");
      el.className = "clip clip-audio";
      if (selectedClip?.type === "audio" && selectedClip.id === aclip.id) {
        el.classList.add("selected");
      }
      el.style.left = `${aclip.timelineStart * pxPerSec}px`;
      el.style.width = `${Math.max(24, dur * pxPerSec)}px`;
      el.innerHTML = `
        <span class="clip-title">🎵 ${aclip.name}</span>
        <span class="clip-meta">${dur.toFixed(1)}s${aclip.muted ? " 🔇" : ""}</span>
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
      '<p class="empty-msg">Selecione um clipe na timeline para ajustar volume, corte ou enquadramento.</p>';
    return;
  }

  if (selectedClip.type === "video") {
    const clip = state.videoClips.find((c) => c.id === selectedClip?.id);
    if (!clip) return;
    inspectorBadge.textContent = `Vídeo ${clip.trackIndex + 1}`;
    inspectorBody.innerHTML = `
      <div class="field">
        <div class="field-row"><strong>${clip.name}</strong><span>${clipDur(clip).toFixed(1)}s</span></div>
      </div>
      <div class="field">
        <div class="field-row">
          <label>Volume do Clipe</label>
          <span>${Math.round(clip.volume * 100)}%</span>
        </div>
        <input id="ins-vol" type="range" min="0" max="1.5" step="0.05" value="${clip.volume}" />
      </div>
      <div class="field">
        <label><input id="ins-mute" type="checkbox" ${clip.muted ? "checked" : ""} /> Silenciar este clipe</label>
      </div>
      <div class="field">
        <div class="field-row"><label>Tamanho / Zoom</label><span>${clip.zoom.toFixed(2)}x</span></div>
        <input id="ins-zoom" type="range" min="0.2" max="3" step="0.05" value="${clip.zoom}" />
      </div>
      <div class="field">
        <div class="field-row"><label>Posição Horizontal</label><span>${Math.round(clip.cropX * 100)}%</span></div>
        <input id="ins-cx" type="range" min="-1" max="1" step="0.05" value="${clip.cropX}" />
      </div>
      <div class="field">
        <div class="field-row"><label>Posição Vertical</label><span>${Math.round(clip.cropY * 100)}%</span></div>
        <input id="ins-cy" type="range" min="-1" max="1" step="0.05" value="${clip.cropY}" />
      </div>
      <p class="hint">Arraste o clipe na timeline para mover no tempo ou para cima para criar uma nova faixa.</p>
    `;

    (document.getElementById("ins-vol") as HTMLInputElement).oninput = (e) => {
      clip.volume = parseFloat((e.target as HTMLInputElement).value);
      syncMediaToPlayhead(false);
    };
    (document.getElementById("ins-mute") as HTMLInputElement).onchange = (e) => {
      pushUndo();
      clip.muted = (e.target as HTMLInputElement).checked;
      renderTimeline();
      syncMediaToPlayhead(false);
    };
    (document.getElementById("ins-zoom") as HTMLInputElement).oninput = (e) => {
      clip.zoom = parseFloat((e.target as HTMLInputElement).value);
      updatePreviewStageStyle();
    };
    (document.getElementById("ins-cx") as HTMLInputElement).oninput = (e) => {
      clip.cropX = parseFloat((e.target as HTMLInputElement).value);
      updatePreviewStageStyle();
    };
    (document.getElementById("ins-cy") as HTMLInputElement).oninput = (e) => {
      clip.cropY = parseFloat((e.target as HTMLInputElement).value);
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
      <p class="hint">Arraste o clipe verde na timeline para ajustar em que momento a música começa.</p>
    `;

    (document.getElementById("ins-avol") as HTMLInputElement).oninput = (e) => {
      aclip.volume = parseFloat((e.target as HTMLInputElement).value);
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
    alert("Adicione pelo menos um vídeo na timeline antes de exportar.");
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
    const resultPath = await invoke<string>("export_project", {
      request: {
        video_clips: state.videoClips.map((c) => ({
          path: c.path,
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
        resolution: (document.getElementById("export-resolution") as HTMLSelectElement).value || "1080p",
        fit_mode: state.fitMode,
        video_volume: state.videoVolume,
        video_muted: state.videoMuted,
        output_path: outputPath,
      },
    });
    exportFill.style.width = "100%";
    exportStatus.textContent = `Concluído! Salvo em: ${resultPath}`;
  } catch (err) {
    exportStatus.textContent = `Erro: ${String(err)}`;
  } finally {
    btnCloseExport.classList.remove("hidden");
  }
}

// --- Event Wiring ---
function initEvents(): void {
  document.getElementById("btn-add-video")!.onclick = openVideoDialog;
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
      updatePreviewStageStyle();
    };
  });

  document.querySelectorAll<HTMLButtonElement>("#fit-selector button").forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll("#fit-selector button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.fitMode = btn.dataset.fit as FitMode;
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
