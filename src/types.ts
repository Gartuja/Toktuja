export type AspectRatio = "9:16" | "16:9" | "1:1" | "4:5" | "custom";
export type FitMode = "crop" | "blur" | "fit";

export interface MediaMetadata {
  path: string;
  name: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  has_video: boolean;
  has_audio: boolean;
}

export interface VideoClip {
  id: string;
  path: string;
  src: string;
  name: string;
  mediaType: "video" | "image";
  originalDuration: number;
  startTime: number;
  endTime: number;
  timelineStart: number;
  trackIndex: number;
  volume: number;
  muted: boolean;
  hasAudio: boolean;
  cropX: number; // -1.5..1.5
  cropY: number; // -1.5..1.5
  zoom: number;  // 0.2..3.0
  flipH: boolean;
  flipV: boolean;
  thumbUrl?: string;
}

export interface AudioClip {
  id: string;
  path: string;
  src: string;
  name: string;
  originalDuration: number;
  startTime: number;
  endTime: number;
  timelineStart: number;
  trackIndex: number;
  volume: number;
  muted: boolean;
}

export interface ProjectState {
  videoClips: VideoClip[];
  audioClips: AudioClip[];
  aspectRatio: AspectRatio;
  customAspectW: number;
  customAspectH: number;
  fitMode: FitMode;
  videoVolume: number;
  videoMuted: boolean;
}

export type ShortcutAction =
  | "playPause"
  | "split"
  | "addVideo"
  | "addImage"
  | "addAudio"
  | "trimStart"
  | "trimEnd"
  | "deleteClip"
  | "stepBack"
  | "stepForward"
  | "undo"
  | "redo"
  | "exportVideo";

export type ShortcutMap = Record<ShortcutAction, string>;
