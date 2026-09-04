import type { KeyboardShortcutAction, KeyboardShortcutMap } from "./types";

export const keyboardShortcutActions: Array<{
  id: KeyboardShortcutAction;
  label: string;
  description: string;
}> = [
  { id: "toggleAudio", label: "Mute audio", description: "Mute or unmute iPhone audio" },
  { id: "takeScreenshot", label: "Screenshot", description: "Take a screenshot" },
  { id: "toggleRecording", label: "Recording", description: "Start or stop recording" },
  { id: "toggleView", label: "Switch view", description: "Switch between Minimal and Console" },
  { id: "toggleFullscreen", label: "Fullscreen", description: "Enter or exit fullscreen" },
  { id: "toggleMinimalChrome", label: "Minimal controls", description: "Hide or show Minimal controls" },
  { id: "openPreferences", label: "Preferences", description: "Open Preferences" },
  { id: "toggleDiagnostics", label: "Diagnostics", description: "Open Console diagnostics" },
];

export const defaultKeyboardShortcuts: KeyboardShortcutMap = {
  toggleAudio: ["M"],
  takeScreenshot: ["Control+S"],
  toggleRecording: ["Control+R"],
  toggleView: ["Control+M"],
  toggleFullscreen: ["F", "Control+F"],
  toggleMinimalChrome: ["H"],
  openPreferences: ["Control+,"],
  toggleDiagnostics: ["F1"],
};

const actionIds = keyboardShortcutActions.map(({ id }) => id);
const modifierKeys = new Set(["Alt", "Control", "Meta", "Shift"]);

export function cloneDefaultKeyboardShortcuts(): KeyboardShortcutMap {
  return Object.fromEntries(
    actionIds.map((action) => [action, [...defaultKeyboardShortcuts[action]]]),
  ) as KeyboardShortcutMap;
}

function normalizedKeyName(key: string): string | null {
  if (modifierKeys.has(key)) return null;
  if (key === " ") return "Space";
  if (key === "+") return "Plus";
  if (key.length === 1) return key.toUpperCase();
  if (/^F(?:[1-9]|1[0-2])$/i.test(key)) return key.toUpperCase();

  const namedKeys: Record<string, string> = {
    ArrowDown: "ArrowDown",
    ArrowLeft: "ArrowLeft",
    ArrowRight: "ArrowRight",
    ArrowUp: "ArrowUp",
    Backspace: "Backspace",
    Delete: "Delete",
    End: "End",
    Home: "Home",
    Insert: "Insert",
    PageDown: "PageDown",
    PageUp: "PageUp",
    Plus: "Plus",
  };
  return namedKeys[key] ?? null;
}

export function keyboardEventToShortcut(event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">): string | null {
  const key = normalizedKeyName(event.key);
  if (!key || key === "Escape" || event.metaKey) return null;

  const modifiers = [
    event.ctrlKey ? "Control" : null,
    event.altKey ? "Alt" : null,
    event.shiftKey ? "Shift" : null,
  ].filter(Boolean) as string[];

  const isSafeUnmodifiedKey = /^[A-Z0-9]$/.test(key) || /^F(?:[1-9]|1[0-2])$/.test(key);
  if (modifiers.length === 0 && !isSafeUnmodifiedKey) return null;

  return [...modifiers, key].join("+");
}

function isValidStoredShortcut(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 40) return false;

  const parts = value.split("+");
  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);
  if (!key || new Set(modifiers).size !== modifiers.length) return false;
  if (modifiers.some((modifier) => !["Control", "Alt", "Shift"].includes(modifier))) return false;

  const normalizedKey = normalizedKeyName(key);
  if (normalizedKey !== key) return false;
  return modifiers.length > 0 || /^[A-Z0-9]$/.test(key) || /^F(?:[1-9]|1[0-2])$/.test(key);
}

export function sanitizeKeyboardShortcuts(value: unknown): KeyboardShortcutMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return cloneDefaultKeyboardShortcuts();
  }

  const stored = value as Partial<Record<KeyboardShortcutAction, unknown>>;
  const result = cloneDefaultKeyboardShortcuts();
  for (const action of actionIds) {
    const bindings = stored[action];
    if (!Array.isArray(bindings)) continue;
    const validBindings = [...new Set(bindings.filter(isValidStoredShortcut))].slice(0, 2);
    if (validBindings.length > 0) result[action] = validBindings;
  }

  const seen = new Set<string>();
  for (const action of actionIds) {
    for (const binding of result[action]) {
      if (seen.has(binding)) return cloneDefaultKeyboardShortcuts();
      seen.add(binding);
    }
  }
  return result;
}

export function keyboardShortcutMatches(
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">,
  bindings: readonly string[],
): boolean {
  const pressed = keyboardEventToShortcut(event);
  return pressed !== null && bindings.includes(pressed);
}

export function findKeyboardShortcutConflict(
  shortcuts: KeyboardShortcutMap,
  action: KeyboardShortcutAction,
  binding: string,
): KeyboardShortcutAction | null {
  return actionIds.find((candidate) => candidate !== action && shortcuts[candidate].includes(binding)) ?? null;
}

export function formatKeyboardShortcut(binding: string): string {
  return binding.replace(/Control/g, "Ctrl").replace(/\+/g, " + ");
}

export function formatKeyboardShortcuts(bindings: readonly string[]): string {
  return bindings.map(formatKeyboardShortcut).join(" / ");
}

export function keyboardShortcutsToAria(bindings: readonly string[]): string {
  return bindings.join(" ");
}
