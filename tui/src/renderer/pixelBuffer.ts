/**
 * pixelBuffer.ts — Lightweight 2D pixel buffer for terminal rendering.
 *
 * Stores pixels as packed 32-bit integers: 0xAARRGGBB.
 * Alpha = 0 means transparent; alpha = 255 means fully opaque.
 * Replaces HTML5 Canvas 2D context for the TUI renderer.
 */

/** Pack RGBA components into a 32-bit integer */
export function rgba(r: number, g: number, b: number, a = 255): number {
  return ((a & 0xff) << 24) | ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
}

/** Unpack a 32-bit pixel to [r, g, b, a] */
export function unpackRgba(pixel: number): [number, number, number, number] {
  return [
    (pixel >> 16) & 0xff,
    (pixel >> 8) & 0xff,
    pixel & 0xff,
    (pixel >> 24) & 0xff,
  ];
}

/** Parse '#RRGGBB' or '#RRGGBBAA' hex string to packed RGBA */
export function hexToRgba(hex: string): number {
  if (hex.length === 7) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return rgba(r, g, b, 255);
  } else if (hex.length === 9) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const a = parseInt(hex.slice(7, 9), 16);
    return rgba(r, g, b, a);
  }
  return 0;
}

/** Parse a CSS rgba() or 'rgba(R,G,B,A)' string to packed RGBA */
export function cssRgbaToRgba(css: string): number {
  const m = css.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s]+([\d.]+))?\s*\)/);
  if (!m) return 0;
  const r = parseInt(m[1], 10);
  const g = parseInt(m[2], 10);
  const b = parseInt(m[3], 10);
  const a = m[4] !== undefined ? Math.round(parseFloat(m[4]) * 255) : 255;
  return rgba(r, g, b, a);
}

/** Parse any color string (hex or rgba) to packed RGBA */
export function parseColor(color: string): number {
  if (color.startsWith('#')) return hexToRgba(color);
  if (color.startsWith('rgba') || color.startsWith('rgb')) return cssRgbaToRgba(color);
  return 0;
}

export class PixelBuffer {
  readonly width: number;
  readonly height: number;
  /** Pixels stored as packed 0xAARRGGBB; 0 = transparent */
  readonly data: Int32Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Int32Array(width * height);
  }

  /** Clear all pixels to transparent */
  clear(): void {
    this.data.fill(0);
  }

  /** Fill entire buffer with a solid color */
  fill(pixel: number): void {
    this.data.fill(pixel);
  }

  setPixel(x: number, y: number, pixel: number): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    const a = (pixel >> 24) & 0xff;
    if (a === 0) return; // fully transparent — skip

    const idx = y * this.width + x;
    if (a === 255) {
      this.data[idx] = pixel;
      return;
    }

    // Alpha blend over existing pixel
    const dst = this.data[idx];
    const dstA = (dst >> 24) & 0xff;
    if (dstA === 0) {
      // Destination is transparent — just set
      this.data[idx] = pixel;
      return;
    }
    const srcR = (pixel >> 16) & 0xff;
    const srcG = (pixel >> 8) & 0xff;
    const srcB = pixel & 0xff;
    const dstR = (dst >> 16) & 0xff;
    const dstG = (dst >> 8) & 0xff;
    const dstB = dst & 0xff;
    const t = a / 255;
    const outR = Math.round(srcR * t + dstR * (1 - t));
    const outG = Math.round(srcG * t + dstG * (1 - t));
    const outB = Math.round(srcB * t + dstB * (1 - t));
    this.data[idx] = rgba(outR, outG, outB, 255);
  }

  fillRect(x: number, y: number, w: number, h: number, pixel: number): void {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.width, Math.floor(x + w));
    const y1 = Math.min(this.height, Math.floor(y + h));
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        this.setPixel(px, py, pixel);
      }
    }
  }

  /**
   * Draw a SpriteData (string[][]) at pixel coordinates.
   * Each string element is either '' (transparent) or '#RRGGBB'/'#RRGGBBAA'.
   * Zoom factor scales each sprite pixel to zoom×zoom terminal pixels.
   */
  drawSprite(sprite: string[][], x: number, y: number, zoom = 1, alpha = 1): void {
    const drawX = Math.round(x);
    const drawY = Math.round(y);
    for (let row = 0; row < sprite.length; row++) {
      const rowData = sprite[row];
      for (let col = 0; col < rowData.length; col++) {
        const color = rowData[col];
        if (!color) continue;
        let pixel = parseColor(color);
        if (pixel === 0) continue;
        if (alpha < 1) {
          const a = Math.round(((pixel >> 24) & 0xff) * alpha);
          pixel = (pixel & 0x00ffffff) | (a << 24);
        }
        if (zoom === 1) {
          this.setPixel(drawX + col, drawY + row, pixel);
        } else {
          const bx = drawX + col * zoom;
          const by = drawY + row * zoom;
          for (let dy = 0; dy < zoom; dy++) {
            for (let dx = 0; dx < zoom; dx++) {
              this.setPixel(bx + dx, by + dy, pixel);
            }
          }
        }
      }
    }
  }

  /** Draw a sprite flipped horizontally */
  drawSpriteFlipped(sprite: string[][], x: number, y: number, zoom = 1, alpha = 1): void {
    const flipped = sprite.map((row) => [...row].reverse());
    this.drawSprite(flipped, x, y, zoom, alpha);
  }

  getPixel(x: number, y: number): number {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return 0;
    return this.data[y * this.width + x] ?? 0;
  }
}
