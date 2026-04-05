/**
 * layoutPersistence.ts — Port of src/layoutPersistence.ts without ExtensionContext.
 *
 * The TUI never has VS Code workspace state to migrate, so migrateAndLoadLayout
 * is simplified: read from file → use defaultLayout → return null.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  LAYOUT_FILE_DIR,
  LAYOUT_FILE_NAME,
  LAYOUT_FILE_POLL_INTERVAL_MS,
  LAYOUT_REVISION_KEY,
} from './constants.js';

export interface LayoutWatcher {
  markOwnWrite(): void;
  dispose(): void;
}

function getLayoutFilePath(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, LAYOUT_FILE_NAME);
}

export function readLayoutFromFile(): Record<string, unknown> | null {
  const filePath = getLayoutFilePath();
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function writeLayoutToFile(layout: Record<string, unknown>): void {
  const filePath = getLayoutFilePath();
  const dir = path.dirname(filePath);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(layout, null, 2), 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch {
    // Ignore write errors
  }
}

export interface LayoutLoadResult {
  layout: Record<string, unknown>;
  wasReset: boolean;
}

/**
 * Load layout with simple fallback chain (no VS Code workspace state migration):
 * 1. File exists → return it (reset if bundled default has a newer revision)
 * 2. defaultLayout provided → write to file, return it
 * 3. null
 */
export function loadLayout(defaultLayout?: Record<string, unknown> | null): LayoutLoadResult | null {
  const fromFile = readLayoutFromFile();
  if (fromFile) {
    const fileRevision = (fromFile[LAYOUT_REVISION_KEY] as number) ?? 0;
    const defaultRevision = (defaultLayout?.[LAYOUT_REVISION_KEY] as number) ?? 0;
    if (defaultRevision > fileRevision && defaultLayout) {
      writeLayoutToFile(defaultLayout);
      return { layout: defaultLayout, wasReset: true };
    }
    return { layout: fromFile, wasReset: false };
  }

  if (defaultLayout) {
    writeLayoutToFile(defaultLayout);
    return { layout: defaultLayout, wasReset: false };
  }

  return null;
}

/**
 * Watch ~/.pixel-agents/layout.json for external changes.
 */
export function watchLayoutFile(
  onExternalChange: (layout: Record<string, unknown>) => void,
): LayoutWatcher {
  const filePath = getLayoutFilePath();
  let skipNextChange = false;
  let lastMtime = 0;
  let fsWatcher: fs.FSWatcher | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  try {
    if (fs.existsSync(filePath)) lastMtime = fs.statSync(filePath).mtimeMs;
  } catch {
    /* ignore */
  }

  function checkForChange(): void {
    if (disposed) return;
    try {
      if (!fs.existsSync(filePath)) return;
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs <= lastMtime) return;
      lastMtime = stat.mtimeMs;
      if (skipNextChange) { skipNextChange = false; return; }
      const layout = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
      onExternalChange(layout);
    } catch {
      /* ignore */
    }
  }

  function startFsWatch(): void {
    if (disposed || fsWatcher) return;
    try {
      if (!fs.existsSync(filePath)) return;
      fsWatcher = fs.watch(filePath, () => checkForChange());
      fsWatcher.on('error', () => { fsWatcher?.close(); fsWatcher = null; });
    } catch {
      /* ignore */
    }
  }

  startFsWatch();
  pollTimer = setInterval(() => {
    if (disposed) return;
    if (!fsWatcher) startFsWatch();
    checkForChange();
  }, LAYOUT_FILE_POLL_INTERVAL_MS);

  return {
    markOwnWrite(): void {
      skipNextChange = true;
      try {
        if (fs.existsSync(filePath)) lastMtime = fs.statSync(filePath).mtimeMs;
      } catch { /* ignore */ }
    },
    dispose(): void {
      disposed = true;
      fsWatcher?.close();
      fsWatcher = null;
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    },
  };
}
