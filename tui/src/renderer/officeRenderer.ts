/**
 * officeRenderer.ts — Port of renderer.ts using PixelBuffer instead of Canvas 2D.
 *
 * Renders the office scene (floor tiles, furniture, characters, speech bubbles)
 * directly into a PixelBuffer without any browser APIs.
 *
 * Key differences from the webview renderer.ts:
 *  - No CanvasRenderingContext2D — uses PixelBuffer.drawSprite() instead
 *  - No sprite caching (HTMLCanvasElement) — draws SpriteData directly
 *  - No editor overlays (not needed for TUI visualization)
 *  - Matrix effect replaced by a simplified version
 */

import {
  BUBBLE_SITTING_OFFSET_PX,
  BUBBLE_VERTICAL_OFFSET_PX,
  BUBBLE_FADE_DURATION_SEC,
  CHARACTER_SITTING_OFFSET_PX,
  CHARACTER_Z_SORT_OFFSET,
  FALLBACK_FLOOR_COLOR,
  OUTLINE_Z_SORT_OFFSET,
  SELECTED_OUTLINE_ALPHA,
  HOVERED_OUTLINE_ALPHA,
} from '../../../webview-ui/src/constants.js';
import { getColorizedFloorSprite, hasFloorSprites, WALL_COLOR } from '../../../webview-ui/src/office/floorTiles.js';
import {
  BUBBLE_PERMISSION_SPRITE,
  BUBBLE_WAITING_SPRITE,
  getCharacterSprites,
} from '../../../webview-ui/src/office/sprites/spriteData.js';
import type {
  Character,
  FurnitureInstance,
  Seat,
  SpriteData,
  TileType as TileTypeVal,
} from '../../../webview-ui/src/office/types.js';
import { CharacterState, TILE_SIZE, TileType } from '../../../webview-ui/src/office/types.js';
import { getWallInstances, hasWallSprites, wallColorToHex } from '../../../webview-ui/src/office/wallTiles.js';
import { getCharacterSprite } from '../../../webview-ui/src/office/engine/characters.js';
import type { ColorValue } from '../../../webview-ui/src/components/ui/types.js';
import { parseColor, PixelBuffer, rgba } from './pixelBuffer.js';

// ── Tile grid ───────────────────────────────────────────────────

export function renderTileGrid(
  buf: PixelBuffer,
  tileMap: TileTypeVal[][],
  offsetX: number,
  offsetY: number,
  zoom: number,
  tileColors?: Array<ColorValue | null>,
  cols?: number,
): void {
  const s = TILE_SIZE * zoom;
  const useSpriteFloors = hasFloorSprites();
  const tmRows = tileMap.length;
  const tmCols = tmRows > 0 ? tileMap[0].length : 0;
  const layoutCols = cols ?? tmCols;

  for (let r = 0; r < tmRows; r++) {
    for (let c = 0; c < tmCols; c++) {
      const tile = tileMap[r][c];

      if (tile === TileType.VOID) continue;

      const drawX = Math.round(offsetX + c * s);
      const drawY = Math.round(offsetY + r * s);

      if (tile === TileType.WALL || !useSpriteFloors) {
        let colorStr: string;
        if (tile === TileType.WALL) {
          const colorIdx = r * layoutCols + c;
          const wallColor = tileColors?.[colorIdx];
          colorStr = wallColor ? wallColorToHex(wallColor) : WALL_COLOR;
        } else {
          colorStr = FALLBACK_FLOOR_COLOR;
        }
        const pixel = parseColor(colorStr);
        buf.fillRect(drawX, drawY, s, s, pixel);
        continue;
      }

      const colorIdx = r * layoutCols + c;
      const color = tileColors?.[colorIdx] ?? { h: 0, s: 0, b: 0, c: 0 };
      const sprite = getColorizedFloorSprite(tile, color);
      buf.drawSprite(sprite, drawX, drawY, zoom);
    }
  }
}

// ── Scene (furniture + characters, z-sorted) ────────────────────

interface ZDrawable {
  zY: number;
  draw: (buf: PixelBuffer) => void;
}

export function renderScene(
  buf: PixelBuffer,
  furniture: FurnitureInstance[],
  characters: Character[],
  offsetX: number,
  offsetY: number,
  zoom: number,
  selectedAgentId: number | null,
  hoveredAgentId: number | null,
): void {
  const drawables: ZDrawable[] = [];

  // Furniture
  for (const f of furniture) {
    const fx = Math.round(offsetX + f.x * zoom);
    const fy = Math.round(offsetY + f.y * zoom);
    if (f.mirrored) {
      drawables.push({
        zY: f.zY,
        draw: (b) => b.drawSpriteFlipped(f.sprite, fx, fy, zoom),
      });
    } else {
      drawables.push({
        zY: f.zY,
        draw: (b) => b.drawSprite(f.sprite, fx, fy, zoom),
      });
    }
  }

  // Characters
  for (const ch of characters) {
    const sprites = getCharacterSprites(ch.palette, ch.hueShift);
    const spriteData = getCharacterSprite(ch, sprites) as SpriteData;
    const spriteW = (spriteData[0]?.length ?? 0) * zoom;
    const spriteH = spriteData.length * zoom;

    const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
    const drawX = Math.round(offsetX + ch.x * zoom - spriteW / 2);
    const drawY = Math.round(offsetY + (ch.y + sittingOffset) * zoom - spriteH);

    const charZY = ch.y + TILE_SIZE / 2 + CHARACTER_Z_SORT_OFFSET;

    // Skip matrix effect details — just draw the sprite
    const isSelected = selectedAgentId !== null && ch.id === selectedAgentId;
    const isHovered = hoveredAgentId !== null && ch.id === hoveredAgentId;

    if (isSelected || isHovered) {
      const outlineAlpha = isSelected ? SELECTED_OUTLINE_ALPHA : HOVERED_OUTLINE_ALPHA;
      const outlineData = getOutlineSprite(spriteData);
      const olDrawX = drawX - zoom;
      const olDrawY = drawY - zoom;
      drawables.push({
        zY: charZY - OUTLINE_Z_SORT_OFFSET,
        draw: (b) => b.drawSprite(outlineData, olDrawX, olDrawY, zoom, outlineAlpha),
      });
    }

    const dx = drawX;
    const dy = drawY;
    drawables.push({
      zY: charZY,
      draw: (b) => b.drawSprite(spriteData, dx, dy, zoom),
    });
  }

  // Sort by Y (lower = in front)
  drawables.sort((a, b) => a.zY - b.zY);
  for (const d of drawables) {
    d.draw(buf);
  }
}

// ── Speech bubbles ──────────────────────────────────────────────

export function renderBubbles(
  buf: PixelBuffer,
  characters: Character[],
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  for (const ch of characters) {
    if (!ch.bubbleType) continue;

    const sprite =
      ch.bubbleType === 'permission' ? BUBBLE_PERMISSION_SPRITE : BUBBLE_WAITING_SPRITE;

    let alpha = 1.0;
    if (ch.bubbleType === 'waiting' && ch.bubbleTimer < BUBBLE_FADE_DURATION_SEC) {
      alpha = ch.bubbleTimer / BUBBLE_FADE_DURATION_SEC;
    }

    const spriteW = (sprite[0]?.length ?? 0) * zoom;
    const spriteH = sprite.length * zoom;
    const sittingOff = ch.state === CharacterState.TYPE ? BUBBLE_SITTING_OFFSET_PX : 0;
    const bubbleX = Math.round(offsetX + ch.x * zoom - spriteW / 2);
    const bubbleY = Math.round(
      offsetY + (ch.y + sittingOff - BUBBLE_VERTICAL_OFFSET_PX) * zoom - spriteH - zoom,
    );

    buf.drawSprite(sprite, bubbleX, bubbleY, zoom, alpha);
  }
}

// ── Outline sprite generation ───────────────────────────────────

const outlineCache = new WeakMap<SpriteData, SpriteData>();

export function getOutlineSprite(sprite: SpriteData): SpriteData {
  const cached = outlineCache.get(sprite);
  if (cached) return cached;

  const rows = sprite.length;
  const cols = sprite[0]?.length ?? 0;
  const outline: string[][] = [];
  for (let r = 0; r < rows + 2; r++) {
    outline.push(new Array<string>(cols + 2).fill(''));
  }

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!sprite[r][c]) continue;
      const er = r + 1;
      const ec = c + 1;
      if (!outline[er - 1][ec]) outline[er - 1][ec] = '#FFFFFF';
      if (!outline[er + 1][ec]) outline[er + 1][ec] = '#FFFFFF';
      if (!outline[er][ec - 1]) outline[er][ec - 1] = '#FFFFFF';
      if (!outline[er][ec + 1]) outline[er][ec + 1] = '#FFFFFF';
    }
  }

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (sprite[r][c]) outline[r + 1][c + 1] = '';
    }
  }

  outlineCache.set(sprite, outline);
  return outline;
}

// ── Full frame render ───────────────────────────────────────────

export function renderFrame(
  buf: PixelBuffer,
  tileMap: TileTypeVal[][],
  furniture: FurnitureInstance[],
  characters: Character[],
  zoom: number,
  panX: number,
  panY: number,
  selectedAgentId: number | null,
  seats: Map<string, Seat>,
  tileColors?: Array<ColorValue | null>,
  layoutCols?: number,
  layoutRows?: number,
): { offsetX: number; offsetY: number } {
  // Clear to dark background
  buf.fill(rgba(15, 15, 25));

  const cols = layoutCols ?? (tileMap.length > 0 ? tileMap[0].length : 0);
  const rows = layoutRows ?? tileMap.length;

  const mapW = cols * TILE_SIZE * zoom;
  const mapH = rows * TILE_SIZE * zoom;
  const offsetX = Math.floor((buf.width - mapW) / 2) + Math.round(panX);
  const offsetY = Math.floor((buf.height - mapH) / 2) + Math.round(panY);

  renderTileGrid(buf, tileMap, offsetX, offsetY, zoom, tileColors, layoutCols);

  const wallInstances = hasWallSprites() ? getWallInstances(tileMap, tileColors, layoutCols) : [];
  const allFurniture = wallInstances.length > 0 ? [...wallInstances, ...furniture] : furniture;

  renderScene(buf, allFurniture, characters, offsetX, offsetY, zoom, selectedAgentId, null);
  renderBubbles(buf, characters, offsetX, offsetY, zoom);

  void seats; // seat indicators not drawn in TUI mode; parameter kept for API compatibility

  return { offsetX, offsetY };
}
