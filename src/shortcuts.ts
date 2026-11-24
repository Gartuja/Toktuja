import type { ShortcutAction, ShortcutMap } from "./types";

const STORAGE_KEY = "toktuja.shortcuts.v1";

export const DEFAULT_SHORTCUTS: ShortcutMap = {
  playPause: "Space",
  split: "S",
  addVideo: "A",
  addAudio: "M",
  trimStart: "I",
  trimEnd: "O",
  deleteClip: "Delete",
  stepBack: "ArrowLeft",
  stepForward: "ArrowRight",
  undo: "Ctrl+Z",
  redo: "Ctrl+Y",
  exportVideo: "Ctrl+E",
};

export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  playPause: "Play / Pausar",
  split: "Cortar clipe na agulha (Split)",
  addVideo: "Adicionar vídeo",
  addAudio: "Adicionar música / áudio",
  trimStart: "Aparar início até a agulha",
  trimEnd: "Aparar fim a partir da agulha",
  deleteClip: "Excluir clipe selecionado",
  stepBack: "Voltar 0.2s na timeline",
  stepForward: "Avançar 0.2s na timeline",
  undo: "Desfazer",
  redo: "Refazer",
  exportVideo: "Exportar vídeo",
};

export function loadShortcuts(): ShortcutMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SHORTCUTS };
    const parsed = JSON.parse(raw) as Partial<ShortcutMap>;
    return { ...DEFAULT_SHORTCUTS, ...parsed };
  } catch {
    return { ...DEFAULT_SHORTCUTS };
  }
}

export function saveShortcuts(map: ShortcutMap): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

export function eventToShortcutString(e: KeyboardEvent): string | null {
  const ignored = ["Control", "Shift", "Alt", "Meta"];
  if (ignored.includes(e.key)) return null;

  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");

  let key = e.key;
  if (key === " ") key = "Space";
  else if (key.length === 1) key = key.toUpperCase();

  parts.push(key);
  return parts.join("+");
}

export function formatShortcutDisplay(combo: string): string {
  return combo
    .replace("Space", "Espaço")
    .replace("ArrowLeft", "←")
    .replace("ArrowRight", "→")
    .replace("Delete", "Del");
}
