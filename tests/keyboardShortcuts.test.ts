import { describe, expect, test } from "bun:test";

import {
  cloneDefaultKeyboardShortcuts,
  findKeyboardShortcutConflict,
  formatKeyboardShortcuts,
  keyboardEventToShortcut,
  keyboardShortcutMatches,
  sanitizeKeyboardShortcuts,
} from "../src/features/mirrorsim/keyboardShortcuts";

const keyEvent = (key: string, modifiers: Partial<Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">> = {}) => ({
  key,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...modifiers,
});

describe("keyboard shortcuts", () => {
  test("normalizes supported keyboard events", () => {
    expect(keyboardEventToShortcut(keyEvent("s", { ctrlKey: true }))).toBe("Control+S");
    expect(keyboardEventToShortcut(keyEvent(",", { ctrlKey: true }))).toBe("Control+,");
    expect(keyboardEventToShortcut(keyEvent("+", { ctrlKey: true }))).toBe("Control+Plus");
    expect(keyboardEventToShortcut(keyEvent("F1"))).toBe("F1");
    expect(keyboardEventToShortcut(keyEvent("Shift"))).toBeNull();
    expect(keyboardEventToShortcut(keyEvent("Escape"))).toBeNull();
    expect(keyboardEventToShortcut(keyEvent("m", { metaKey: true }))).toBeNull();
  });

  test("matches bindings and formats labels", () => {
    expect(keyboardShortcutMatches(keyEvent("f", { ctrlKey: true }), ["F", "Control+F"])).toBe(true);
    expect(formatKeyboardShortcuts(["F", "Control+F"])).toBe("F / Ctrl + F");
  });

  test("preserves valid stored bindings and rejects corrupt maps", () => {
    const defaults = cloneDefaultKeyboardShortcuts();
    const customized = sanitizeKeyboardShortcuts({ ...defaults, toggleAudio: ["Control+Shift+A"] });
    expect(customized.toggleAudio).toEqual(["Control+Shift+A"]);

    const duplicate = sanitizeKeyboardShortcuts({ ...defaults, toggleAudio: ["Control+S"] });
    expect(duplicate).toEqual(defaults);
  });

  test("finds conflicts in another action", () => {
    const shortcuts = cloneDefaultKeyboardShortcuts();
    expect(findKeyboardShortcutConflict(shortcuts, "toggleAudio", "Control+S")).toBe("takeScreenshot");
    expect(findKeyboardShortcutConflict(shortcuts, "toggleAudio", "Control+Shift+A")).toBeNull();
  });
});
