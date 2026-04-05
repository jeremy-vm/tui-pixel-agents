/**
 * terminalOutput.ts — Convert a PixelBuffer to an ANSI terminal string using Unicode half-blocks.
 *
 * Each terminal cell is 2 pixels tall:
 *   ▀  (U+2580 UPPER HALF BLOCK)
 *   FG color = top pixel
 *   BG color = bottom pixel
 *
 * Requires a terminal that supports:
 *   - 24-bit (true color) ANSI: \x1b[38;2;R;G;Bm (foreground)
 *                                \x1b[48;2;R;G;Bm (background)
 *   - Unicode block elements
 *
 * Most modern terminal emulators (iTerm2, GNOME Terminal, Windows Terminal, Kitty, etc.) support this.
 */

import { unpackRgba, type PixelBuffer } from './pixelBuffer.js';

/** ANSI reset sequence */
const RESET = '\x1b[0m';

/** Set true-color foreground */
function fg(r: number, g: number, b: number): string {
  return `\x1b[38;2;${r};${g};${b}m`;
}

/** Set true-color background */
function bg(r: number, g: number, b: number): string {
  return `\x1b[48;2;${r};${g};${b}m`;
}

/** The half-block character — top half is FG, bottom half is BG */
const HALF_BLOCK = '▀';

/**
 * Convert a PixelBuffer to a string suitable for writing to stdout.
 *
 * The output renders the buffer at half-block resolution:
 *   - Buffer rows 0,1 → terminal row 0
 *   - Buffer rows 2,3 → terminal row 1
 *   - etc.
 *
 * @param buf The pixel buffer (width × height pixels)
 * @param bgR Terminal background red (default 0)
 * @param bgG Terminal background green (default 0)
 * @param bgB Terminal background blue (default 0)
 */
export function pixelBufferToAnsi(
  buf: PixelBuffer,
  bgR = 0,
  bgG = 0,
  bgB = 0,
): string {
  const parts: string[] = [];
  const termRows = Math.floor(buf.height / 2);

  for (let termRow = 0; termRow < termRows; termRow++) {
    const pixelRowTop = termRow * 2;
    const pixelRowBot = termRow * 2 + 1;

    let lastFgR = -1, lastFgG = -1, lastFgB = -1;
    let lastBgR = -1, lastBgG = -1, lastBgB = -1;

    for (let col = 0; col < buf.width; col++) {
      const topPixel = buf.getPixel(col, pixelRowTop);
      const botPixel = buf.getPixel(col, pixelRowBot);

      const topA = (topPixel >> 24) & 0xff;
      const botA = (botPixel >> 24) & 0xff;

      // Resolve colors with background fallback for transparent pixels
      let [topR, topG, topB] = topA > 0
        ? [((topPixel >> 16) & 0xff), ((topPixel >> 8) & 0xff), (topPixel & 0xff)]
        : [bgR, bgG, bgB];
      let [botR, botG, botB] = botA > 0
        ? [((botPixel >> 16) & 0xff), ((botPixel >> 8) & 0xff), (botPixel & 0xff)]
        : [bgR, bgG, bgB];

      // Build ANSI escape sequences only when color changes
      let esc = '';
      if (topR !== lastFgR || topG !== lastFgG || topB !== lastFgB) {
        esc += fg(topR, topG, topB);
        lastFgR = topR; lastFgG = topG; lastFgB = topB;
      }
      if (botR !== lastBgR || botG !== lastBgG || botB !== lastBgB) {
        esc += bg(botR, botG, botB);
        lastBgR = botR; lastBgG = botG; lastBgB = botB;
      }

      parts.push(esc, HALF_BLOCK);
    }
    parts.push(RESET, '\n');
    // Reset last colors for next row
    lastFgR = lastFgG = lastFgB = -1;
    lastBgR = lastBgG = lastBgB = -1;
  }

  return parts.join('');
}

/**
 * Render a status bar line using ANSI escapes.
 * Uses bright cyan text on a dark background.
 */
export function renderStatusBar(text: string, width: number): string {
  const truncated = text.slice(0, width).padEnd(width);
  return `\x1b[48;2;30;30;50m\x1b[38;2;100;200;255m${truncated}${RESET}`;
}

/**
 * Move cursor to screen position (1-based ANSI coordinates).
 */
export function moveTo(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
}

/** Hide the terminal cursor */
export const HIDE_CURSOR = '\x1b[?25l';

/** Show the terminal cursor */
export const SHOW_CURSOR = '\x1b[?25h';

/** Switch to alternate screen buffer */
export const ENTER_ALT_SCREEN = '\x1b[?1049h';

/** Switch back to normal screen buffer */
export const EXIT_ALT_SCREEN = '\x1b[?1049l';

/** Clear entire screen and move cursor to top-left */
export const CLEAR_SCREEN = '\x1b[2J\x1b[H';
