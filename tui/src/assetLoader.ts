/**
 * assetLoader.ts — Port of src/assetLoader.ts without VS Code webview dependency.
 * Functions that send data to the webview are replaced by simply returning the data.
 */

import * as fs from 'fs';
import * as path from 'path';

import { CHAR_COUNT, CHAR_FRAMES_PER_ROW, WALL_BITMASK_COUNT } from '../../shared/assets/constants.js';
import type {
  FurnitureAsset,
  FurnitureManifest,
  InheritedProps,
  ManifestGroup,
} from '../../shared/assets/manifestUtils.js';
import { flattenManifest } from '../../shared/assets/manifestUtils.js';
import {
  decodeCharacterPng,
  decodeFloorPng,
  parseWallPng,
  pngToSpriteData,
} from '../../shared/assets/pngDecoder.js';
import type { CharacterDirectionSprites } from '../../shared/assets/types.js';
import { LAYOUT_REVISION_KEY } from './constants.js';

export type { CharacterDirectionSprites,FurnitureAsset };

export interface LoadedAssets {
  catalog: FurnitureAsset[];
  sprites: Map<string, string[][]>;
}

export function mergeLoadedAssets(a: LoadedAssets, b: LoadedAssets): LoadedAssets {
  const bIds = new Set(b.catalog.map((item) => item.id));
  const dedupedA = a.catalog.filter((item) => !bIds.has(item.id));
  return {
    catalog: [...dedupedA, ...b.catalog],
    sprites: new Map([...a.sprites, ...b.sprites]),
  };
}

export async function loadFurnitureAssets(workspaceRoot: string): Promise<LoadedAssets | null> {
  try {
    const furnitureDir = path.join(workspaceRoot, 'assets', 'furniture');
    if (!fs.existsSync(furnitureDir)) return null;

    const entries = fs.readdirSync(furnitureDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory());
    if (dirs.length === 0) return null;

    const catalog: FurnitureAsset[] = [];
    const sprites = new Map<string, string[][]>();

    for (const dir of dirs) {
      const itemDir = path.join(furnitureDir, dir.name);
      const manifestPath = path.join(itemDir, 'manifest.json');
      if (!fs.existsSync(manifestPath)) continue;

      try {
        const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
        const manifest = JSON.parse(manifestContent) as FurnitureManifest;

        const inherited: InheritedProps = {
          groupId: manifest.id,
          name: manifest.name,
          category: manifest.category,
          canPlaceOnWalls: manifest.canPlaceOnWalls,
          canPlaceOnSurfaces: manifest.canPlaceOnSurfaces,
          backgroundTiles: manifest.backgroundTiles,
        };

        let assets: FurnitureAsset[];
        if (manifest.type === 'asset') {
          assets = [
            {
              id: manifest.id,
              name: manifest.name,
              label: manifest.name,
              category: manifest.category,
              file: manifest.file ?? `${manifest.id}.png`,
              width: manifest.width!,
              height: manifest.height!,
              footprintW: manifest.footprintW!,
              footprintH: manifest.footprintH!,
              isDesk: manifest.category === 'desks',
              canPlaceOnWalls: manifest.canPlaceOnWalls,
              canPlaceOnSurfaces: manifest.canPlaceOnSurfaces,
              backgroundTiles: manifest.backgroundTiles,
              groupId: manifest.id,
            },
          ];
        } else {
          if (manifest.rotationScheme) {
            inherited.rotationScheme = manifest.rotationScheme;
          }
          const rootGroup: ManifestGroup = {
            type: 'group',
            groupType: manifest.groupType as 'rotation' | 'state' | 'animation',
            rotationScheme: manifest.rotationScheme,
            members: manifest.members!,
          };
          assets = flattenManifest(rootGroup, inherited);
        }

        for (const asset of assets) {
          try {
            const assetPath = path.join(itemDir, asset.file);
            const resolvedAsset = path.resolve(assetPath);
            const resolvedDir = path.resolve(itemDir);
            // Ensure the asset is within the expected directory (prevent path traversal)
            const relative = path.relative(resolvedDir, resolvedAsset);
            if (relative.startsWith('..') || path.isAbsolute(relative)) {
              continue;
            }
            if (!fs.existsSync(assetPath)) continue;
            const pngBuffer = fs.readFileSync(assetPath);
            const spriteData = pngToSpriteData(pngBuffer, asset.width, asset.height);
            sprites.set(asset.id, spriteData);
          } catch {
            // Ignore per-asset errors
          }
        }
        catalog.push(...assets);
      } catch {
        // Ignore per-folder errors
      }
    }

    return { catalog, sprites };
  } catch {
    return null;
  }
}

// ── Default layout ───────────────────────────────────────────

export function loadDefaultLayout(assetsRoot: string): Record<string, unknown> | null {
  const assetsDir = path.join(assetsRoot, 'assets');
  try {
    let bestRevision = 0;
    let bestPath: string | null = null;

    if (fs.existsSync(assetsDir)) {
      for (const file of fs.readdirSync(assetsDir)) {
        const match = /^default-layout-(\d+)\.json$/.exec(file);
        if (match) {
          const rev = parseInt(match[1], 10);
          if (rev > bestRevision) {
            bestRevision = rev;
            bestPath = path.join(assetsDir, file);
          }
        }
      }
    }

    if (!bestPath) {
      const fallback = path.join(assetsDir, 'default-layout.json');
      if (fs.existsSync(fallback)) bestPath = fallback;
    }

    if (!bestPath) return null;

    const layout = JSON.parse(fs.readFileSync(bestPath, 'utf-8')) as Record<string, unknown>;
    if (bestRevision > 0 && !layout[LAYOUT_REVISION_KEY]) {
      layout[LAYOUT_REVISION_KEY] = bestRevision;
    }
    return layout;
  } catch {
    return null;
  }
}

// ── Wall tiles ───────────────────────────────────────────────

export interface LoadedWallTiles {
  sets: string[][][][];
}

export async function loadWallTiles(assetsRoot: string): Promise<LoadedWallTiles | null> {
  try {
    const wallsDir = path.join(assetsRoot, 'assets', 'walls');
    if (!fs.existsSync(wallsDir)) return null;

    const entries = fs.readdirSync(wallsDir);
    const wallFiles: { index: number; filename: string }[] = [];
    for (const entry of entries) {
      const match = /^wall_(\d+)\.png$/i.exec(entry);
      if (match) wallFiles.push({ index: parseInt(match[1], 10), filename: entry });
    }

    if (wallFiles.length === 0) return null;
    wallFiles.sort((a, b) => a.index - b.index);

    const sets: string[][][][] = [];
    for (const { filename } of wallFiles) {
      const pngBuffer = fs.readFileSync(path.join(wallsDir, filename));
      sets.push(parseWallPng(pngBuffer));
    }

    console.log(`[AssetLoader] Loaded ${sets.length} wall tile sets (${sets.length * WALL_BITMASK_COUNT} pieces)`);
    return { sets };
  } catch {
    return null;
  }
}

// ── Floor tiles ──────────────────────────────────────────────

export interface LoadedFloorTiles {
  sprites: string[][][];
}

export async function loadFloorTiles(assetsRoot: string): Promise<LoadedFloorTiles | null> {
  try {
    const floorsDir = path.join(assetsRoot, 'assets', 'floors');
    if (!fs.existsSync(floorsDir)) return null;

    const entries = fs.readdirSync(floorsDir);
    const floorFiles: { index: number; filename: string }[] = [];
    for (const entry of entries) {
      const match = /^floor_(\d+)\.png$/i.exec(entry);
      if (match) floorFiles.push({ index: parseInt(match[1], 10), filename: entry });
    }

    if (floorFiles.length === 0) return null;
    floorFiles.sort((a, b) => a.index - b.index);

    const sprites: string[][][] = [];
    for (const { filename } of floorFiles) {
      sprites.push(decodeFloorPng(fs.readFileSync(path.join(floorsDir, filename))));
    }

    console.log(`[AssetLoader] Loaded ${sprites.length} floor tile patterns`);
    return { sprites };
  } catch {
    return null;
  }
}

// ── Character sprites ────────────────────────────────────────

export interface LoadedCharacterSprites {
  characters: CharacterDirectionSprites[];
}

export async function loadCharacterSprites(assetsRoot: string): Promise<LoadedCharacterSprites | null> {
  try {
    const charDir = path.join(assetsRoot, 'assets', 'characters');
    const characters: CharacterDirectionSprites[] = [];

    for (let ci = 0; ci < CHAR_COUNT; ci++) {
      const filePath = path.join(charDir, `char_${ci}.png`);
      if (!fs.existsSync(filePath)) return null;
      characters.push(decodeCharacterPng(fs.readFileSync(filePath)));
    }

    console.log(`[AssetLoader] Loaded ${characters.length} character sprites (${CHAR_FRAMES_PER_ROW} frames × 3 directions)`);
    return { characters };
  } catch {
    return null;
  }
}
