/**
 * screen.ts — Terminal size detection and ANSI utilities.
 */

export interface TerminalSize {
  cols: number;
  rows: number;
}

/** Get the current terminal dimensions (falls back to 80×24 if unavailable) */
export function getTerminalSize(): TerminalSize {
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  return { cols, rows };
}

/**
 * Listen for terminal resize events.
 * Returns a cleanup function to stop listening.
 */
export function onResize(callback: (size: TerminalSize) => void): () => void {
  const handler = () => {
    callback(getTerminalSize());
  };
  process.stdout.on('resize', handler);
  return () => {
    process.stdout.removeListener('resize', handler);
  };
}

/**
 * Move the cursor to a specific terminal row/column (1-based).
 */
export function moveCursor(row: number, col: number): void {
  process.stdout.write(`\x1b[${row};${col}H`);
}

/** Move cursor to top-left */
export function home(): void {
  process.stdout.write('\x1b[H');
}

/** Hide the cursor */
export function hideCursor(): void {
  process.stdout.write('\x1b[?25l');
}

/** Show the cursor */
export function showCursor(): void {
  process.stdout.write('\x1b[?25h');
}

/** Enter the alternate screen buffer (saves current terminal content) */
export function enterAltScreen(): void {
  process.stdout.write('\x1b[?1049h');
}

/** Exit the alternate screen buffer (restores previous terminal content) */
export function exitAltScreen(): void {
  process.stdout.write('\x1b[?1049l');
}

/** Write a string to stdout */
export function write(s: string): void {
  process.stdout.write(s);
}

/** Enable mouse reporting (for click/scroll detection) */
export function enableMouse(): void {
  process.stdout.write('\x1b[?1000h\x1b[?1006h');
}

/** Disable mouse reporting */
export function disableMouse(): void {
  process.stdout.write('\x1b[?1000l\x1b[?1006l');
}
