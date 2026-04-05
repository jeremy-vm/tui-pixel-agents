/**
 * input.ts — Raw mode keyboard input handling for the TUI.
 *
 * Uses Node.js readline to enable raw mode and emit keypresses.
 */

import * as readline from 'readline';

export interface KeyEvent {
  /** The raw sequence received (may be multi-byte for special keys) */
  sequence: string;
  /** Human-readable key name */
  name: string;
  /** Whether Ctrl was held */
  ctrl: boolean;
  /** Whether the key is a special (escape) sequence */
  isSpecial: boolean;
}

type KeyHandler = (key: KeyEvent) => void;

const handlers = new Set<KeyHandler>();
let rawModeActive = false;
let rlInterface: readline.Interface | null = null;

/**
 * Enable raw mode and start capturing keystrokes.
 * Returns a cleanup function that disables raw mode.
 */
export function enableRawMode(): () => void {
  if (rawModeActive) return () => {};

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.setEncoding('utf-8');

  // Use readline to get parsed key events
  rlInterface = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  readline.emitKeypressEvents(process.stdin, rlInterface);

  const onKeypress = (str: string, key: readline.Key) => {
    const event: KeyEvent = {
      sequence: key?.sequence ?? str ?? '',
      name: key?.name ?? str ?? '',
      ctrl: key?.ctrl ?? false,
      isSpecial: !!(key?.special || (key?.sequence?.startsWith('\x1b') && key?.sequence?.length > 1)),
    };
    for (const h of handlers) h(event);
  };

  process.stdin.on('keypress', onKeypress);
  rawModeActive = true;

  return () => {
    process.stdin.removeListener('keypress', onKeypress);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    rlInterface?.close();
    rlInterface = null;
    rawModeActive = false;
  };
}

/** Register a keypress handler */
export function onKey(handler: KeyHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}
