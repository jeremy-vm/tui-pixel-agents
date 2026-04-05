/**
 * app.ts — TuiApp: the main orchestrator replacing PixelAgentsViewProvider.
 *
 * Manages:
 *  - Agent lifecycle (spawning, watching, removing)
 *  - OfficeState game world (characters, layout)
 *  - Rendering (pixel buffer → terminal output)
 *  - Keyboard input
 *  - Hook event server (optional)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { HookEventHandler } from '../../server/src/hookEventHandler.js';
import { PixelAgentsServer } from '../../server/src/server.js';
import {
  installHooks,
  copyHookScript,
} from '../../server/src/providers/file/claudeHookInstaller.js';

import {
  launchNewProcess,
  removeAgent,
  restoreAgents,
  persistAgentsToDisk,
  sendCurrentAgentStatuses,
  getProjectDirPath,
} from './agentManager.js';
import {
  loadCharacterSprites,
  loadDefaultLayout,
  loadFloorTiles,
  loadFurnitureAssets,
  loadWallTiles,
} from './assetLoader.js';
import {
  dismissedJsonlFiles,
  startExternalSessionScanning,
  startStaleExternalAgentCheck,
  startGlobalSessionScanning,
} from './fileWatcher.js';
import { startGameLoop } from './gameLoop.js';
import { loadLayout, watchLayoutFile } from './layoutPersistence.js';
import type { DispatchFn, MessagePayload } from './dispatch.js';
import { renderFrame } from './renderer/officeRenderer.js';
import { PixelBuffer } from './renderer/pixelBuffer.js';
import {
  pixelBufferToAnsi,
  renderStatusBar,
  moveTo,
  HIDE_CURSOR,
  SHOW_CURSOR,
  ENTER_ALT_SCREEN,
  EXIT_ALT_SCREEN,
  CLEAR_SCREEN,
} from './renderer/terminalOutput.js';
import { getTerminalSize, onResize, write } from './terminal/screen.js';
import { enableRawMode, onKey, type KeyEvent } from './terminal/input.js';
import type { AgentState } from './types.js';

import { OfficeState } from '../../webview-ui/src/office/engine/officeState.js';
import { buildDynamicCatalog } from '../../webview-ui/src/office/layout/furnitureCatalog.js';
import { setFloorSprites } from '../../webview-ui/src/office/floorTiles.js';
import { setWallSprites } from '../../webview-ui/src/office/wallTiles.js';
import { setCharacterTemplates } from '../../webview-ui/src/office/sprites/spriteData.js';
import { migrateLayoutColors } from '../../webview-ui/src/office/layout/layoutSerializer.js';
import type { OfficeLayout } from '../../webview-ui/src/office/types.js';
import { extractToolName } from '../../webview-ui/src/office/toolUtils.js';

export interface TuiAppOptions {
  /** Working directory for the Claude session */
  workspacePath?: string;
  /** Whether to adopt all active sessions from ~/.claude/projects/ */
  watchAll?: boolean;
  /** Whether to start the hook event server */
  hooksEnabled?: boolean;
  /** Directory containing bundled assets (furniture, characters, walls, floors) */
  assetsRoot?: string;
}

const PAN_STEP = 16; // pixels per arrow key press
const ZOOM_MIN = 1;
const ZOOM_MAX = 4;

export class TuiApp {
  // ── Agent state ──────────────────────────────────────────────
  agents = new Map<number, AgentState>();
  nextAgentId = { current: 1 };
  activeAgentId = { current: null as number | null };
  knownJsonlFiles = new Set<string>();
  projectScanTimer = { current: null as ReturnType<typeof setInterval> | null };

  fileWatchers = new Map<number, fs.FSWatcher>();
  pollingTimers = new Map<number, ReturnType<typeof setInterval>>();
  waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();
  jsonlPollTimers = new Map<number, ReturnType<typeof setInterval>>();

  externalScanTimer: ReturnType<typeof setInterval> | null = null;
  staleCheckTimer: ReturnType<typeof setInterval> | null = null;
  globalDismissedFiles = new Set<string>();

  // ── Game world ───────────────────────────────────────────────
  officeState: OfficeState;
  layoutReady = false;

  // ── View state ───────────────────────────────────────────────
  zoom: number = 2;
  panX: number = 0;
  panY: number = 0;
  selectedAgentId: number | null = null;
  termCols: number = 80;
  termRows: number = 24;

  // ── Status display ───────────────────────────────────────────
  statusMessage = '';
  statusMessageTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Server ───────────────────────────────────────────────────
  private server: PixelAgentsServer | null = null;
  private hookHandler: HookEventHandler | null = null;

  // ── Cleanup fns ──────────────────────────────────────────────
  private stopLoop?: () => void;
  private stopResize?: () => void;
  private stopKeys?: () => void;
  private layoutWatcher?: ReturnType<typeof watchLayoutFile>;

  private readonly opts: TuiAppOptions;
  private pixelBuffer: PixelBuffer;

  constructor(opts: TuiAppOptions = {}) {
    this.opts = opts;
    this.officeState = new OfficeState();
    const size = getTerminalSize();
    this.termCols = size.cols;
    this.termRows = size.rows;
    // Buffer height is (rows-1)*2 to leave one row for the status bar
    this.pixelBuffer = new PixelBuffer(size.cols, Math.max(1, (size.rows - 1)) * 2);
  }

  // ── Dispatch bridge ─────────────────────────────────────────
  private dispatch: DispatchFn = (msg: MessagePayload) => {
    this.handleMessage(msg);
  };

  private handleMessage(msg: MessagePayload): void {
    const os = this.officeState;
    switch (msg.type) {
      case 'agentCreated': {
        const id = msg.id as number;
        const skipEffect = msg.skipSpawnEffect as boolean | undefined;
        os.addAgent(id, undefined, undefined, undefined, !skipEffect, msg.folderName as string | undefined);
        this.selectedAgentId = id;
        this.activeAgentId.current = id;
        this.setStatus(`Agent ${id} spawned`);
        break;
      }
      case 'agentClosed': {
        const id = msg.id as number;
        os.removeAllSubagents(id);
        os.removeAgent(id);
        if (this.selectedAgentId === id) {
          this.selectedAgentId = null;
        }
        this.setStatus(`Agent ${id} closed`);
        break;
      }
      case 'existingAgents': {
        const ids = msg.agents as number[];
        for (const id of ids) {
          os.addAgent(id, undefined, undefined, undefined, true);
        }
        break;
      }
      case 'agentStatus': {
        const id = msg.id as number;
        const status = msg.status as string;
        if (status === 'active') {
          os.setAgentActive(id, true);
        } else if (status === 'waiting') {
          os.setAgentActive(id, false);
          os.showWaitingBubble(id);
        }
        break;
      }
      case 'agentToolStart': {
        const id = msg.id as number;
        const toolName = (msg.toolName as string | undefined) ?? extractToolName(msg.status as string);
        const permissionActive = msg.permissionActive as boolean | undefined;
        os.setAgentTool(id, toolName);
        os.setAgentActive(id, true);
        if (!permissionActive) os.clearPermissionBubble(id);
        if (toolName === 'Task' || toolName === 'Agent') {
          const toolId = msg.toolId as string;
          const label = (msg.status as string)?.startsWith('Subtask:')
            ? (msg.status as string).slice('Subtask:'.length).trim()
            : '';
          os.addSubagent(id, toolId);
          void label; // label used for display in browser UI, skip in TUI
        }
        break;
      }
      case 'agentToolDone': {
        const id = msg.id as number;
        // Let officeState figure out what to do when all tools are done
        if (this.agents.get(id)?.activeToolIds.size === 0) {
          os.setAgentActive(id, false);
        }
        break;
      }
      case 'agentToolsClear': {
        const id = msg.id as number;
        os.setAgentTool(id, null);
        os.setAgentActive(id, true);
        break;
      }
      case 'agentToolPermission': {
        const id = msg.id as number;
        os.showPermissionBubble(id);
        this.setStatus(`Agent ${id} waiting for permission`);
        break;
      }
      case 'agentToolPermissionClear': {
        const id = msg.id as number;
        os.clearPermissionBubble(id);
        break;
      }
      case 'subagentToolStart':
      case 'subagentToolDone':
      case 'subagentClear':
        // Sub-agent tool tracking is managed in AgentState; no OfficeState update needed
        break;
      default:
        break;
    }
  }

  // ── Status message ───────────────────────────────────────────
  private setStatus(msg: string, durationMs = 5000): void {
    this.statusMessage = msg;
    if (this.statusMessageTimer) clearTimeout(this.statusMessageTimer);
    this.statusMessageTimer = setTimeout(() => {
      this.statusMessage = '';
      this.statusMessageTimer = null;
    }, durationMs);
  }

  // ── Asset loading ────────────────────────────────────────────
  private async loadAssets(): Promise<void> {
    const assetsRoot = this.opts.assetsRoot ?? this.resolveAssetsRoot();
    if (!assetsRoot) {
      console.error('[TUI] Could not find assets directory');
      return;
    }

    // Character sprites
    const charSprites = await loadCharacterSprites(assetsRoot);
    if (charSprites) {
      setCharacterTemplates(
        charSprites.characters.map((c) => ({
          down: c.down,
          up: c.up,
          right: c.right,
        })),
      );
    }

    // Floor tiles
    const floorTiles = await loadFloorTiles(assetsRoot);
    if (floorTiles) {
      setFloorSprites(floorTiles.sprites);
    }

    // Wall tiles
    const wallTiles = await loadWallTiles(assetsRoot);
    if (wallTiles) {
      setWallSprites(wallTiles.sets);
    }

    // Furniture assets
    const furnitureAssets = await loadFurnitureAssets(assetsRoot);
    if (furnitureAssets) {
      const spritesObj: Record<string, string[][]> = {};
      for (const [id, sprite] of furnitureAssets.sprites) {
        spritesObj[id] = sprite;
      }
      buildDynamicCatalog({ catalog: furnitureAssets.catalog, sprites: spritesObj });
    }

    // Layout
    const defaultLayout = loadDefaultLayout(assetsRoot);
    const layoutResult = loadLayout(defaultLayout ?? undefined);
    if (layoutResult) {
      const raw = layoutResult.layout as OfficeLayout | null;
      if (raw && raw.version === 1) {
        const layout = migrateLayoutColors(raw);
        this.officeState.rebuildFromLayout(layout);
      }
    }

    this.layoutReady = true;

    // Restore persisted agents after layout is ready (seats exist)
    restoreAgents(
      this.nextAgentId,
      this.agents,
      this.knownJsonlFiles,
      this.fileWatchers,
      this.pollingTimers,
      this.waitingTimers,
      this.permissionTimers,
      this.jsonlPollTimers,
      this.projectScanTimer,
      this.activeAgentId,
      this.dispatch,
      () => persistAgentsToDisk(this.agents),
    );

    sendCurrentAgentStatuses(this.agents, this.dispatch);
  }

  /** Find the assets directory relative to this script */
  private resolveAssetsRoot(): string | null {
    // Use import.meta.url to reliably resolve the script location in ESM
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.join(scriptDir, '..', 'webview-ui', 'public'),
      path.join(scriptDir, '..', 'dist'),
      path.join(process.cwd(), 'webview-ui', 'public'),
      path.join(process.cwd(), 'dist'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(path.join(c, 'assets'))) return c;
    }
    return null;
  }

  // ── Hook server ──────────────────────────────────────────────
  private async startServer(): Promise<void> {
    try {
      // Create a minimal webview proxy that delegates postMessage to the dispatch callback.
      // HookEventHandler expects a vscode.Webview but only calls .postMessage() at runtime.
      // This object satisfies that contract without depending on VS Code types.
      const fakeWebview: { postMessage: (msg: MessagePayload) => boolean } = {
        postMessage: (msg: MessagePayload) => { this.dispatch(msg); return true; },
      };
      this.hookHandler = new HookEventHandler(
        this.agents,
        this.waitingTimers,
        this.permissionTimers,
        // Cast through unknown: HookEventHandler expects vscode.Webview but only calls
        // postMessage() at runtime. The fakeWebview object satisfies that runtime contract.
        () => fakeWebview as unknown as ReturnType<() => { postMessage: (msg: unknown) => boolean }>,
      );
      this.server = new PixelAgentsServer();
      this.server.onHookEvent((providerId, event) => {
        this.hookHandler?.handleEvent(providerId, event as Parameters<HookEventHandler['handleEvent']>[1]);
      });
      const config = await this.server.start();
      if (this.opts.hooksEnabled !== false) {
        try {
          installHooks();
          // Try to copy hook script from relative dist/ directory
          const scriptDir = path.dirname(fileURLToPath(import.meta.url));
          const hookSrc = path.join(scriptDir, '..', 'dist', 'hooks');
          if (fs.existsSync(hookSrc)) {
            copyHookScript(path.join(scriptDir, '..'));
          }
        } catch {
          // Hooks are optional — don't fail if install fails
        }
      }
      this.setStatus(`Server ready on port ${config.port}`, 3000);
    } catch (e) {
      console.error('[TUI] Failed to start server:', e);
    }
  }

  // ── External session scanning ────────────────────────────────
  private startScannersSync(): void {
    const workspacePath = this.opts.workspacePath ?? os.homedir();
    const projectDir = getProjectDirPath(workspacePath);

    this.externalScanTimer = startExternalSessionScanning(
      projectDir,
      this.knownJsonlFiles,
      this.nextAgentId,
      this.agents,
      this.fileWatchers,
      this.pollingTimers,
      this.waitingTimers,
      this.permissionTimers,
      this.jsonlPollTimers,
      this.dispatch,
      () => persistAgentsToDisk(this.agents),
    );

    this.staleCheckTimer = startStaleExternalAgentCheck(
      this.agents,
      this.fileWatchers,
      this.pollingTimers,
      this.waitingTimers,
      this.permissionTimers,
      this.jsonlPollTimers,
      removeAgent,
      this.dispatch,
      () => persistAgentsToDisk(this.agents),
    );

    if (this.opts.watchAll) {
      startGlobalSessionScanning(
        this.globalDismissedFiles,
        this.knownJsonlFiles,
        this.nextAgentId,
        this.agents,
        this.fileWatchers,
        this.pollingTimers,
        this.waitingTimers,
        this.permissionTimers,
        this.jsonlPollTimers,
        this.dispatch,
        () => persistAgentsToDisk(this.agents),
      );
    }
  }

  private handleKey(key: KeyEvent): void {
    const { name, ctrl, sequence } = key;

    // Quit
    if ((ctrl && name === 'c') || (ctrl && name === 'q') || name === 'q') {
      void this.stop();
      return;
    }

    // Add new agent
    if (name === 'a' || name === 'A') {
      void this.addAgent(false);
      return;
    }

    // Pan view
    if (name === 'up' || sequence === '\x1b[A') { this.panY += PAN_STEP; return; }
    if (name === 'down' || sequence === '\x1b[B') { this.panY -= PAN_STEP; return; }
    if (name === 'right' || sequence === '\x1b[C') { this.panX -= PAN_STEP; return; }
    if (name === 'left' || sequence === '\x1b[D') { this.panX += PAN_STEP; return; }

    // Zoom
    if (name === '+' || name === '=') {
      this.zoom = Math.min(ZOOM_MAX, this.zoom + 1);
      return;
    }
    if (name === '-' || name === '_') {
      this.zoom = Math.max(ZOOM_MIN, this.zoom - 1);
      return;
    }

    // Reset pan/zoom
    if (name === 'r' || name === 'R') {
      this.panX = 0;
      this.panY = 0;
      return;
    }

    // Select next/prev agent
    if (name === 'tab') {
      this.selectNextAgent();
      return;
    }

    // Close selected agent
    if (name === 'd' || name === 'D') {
      if (this.selectedAgentId !== null) {
        this.closeAgent(this.selectedAgentId);
      }
      return;
    }
  }

  private selectNextAgent(): void {
    const ids = [...this.agents.keys()].sort((a, b) => a - b);
    if (ids.length === 0) return;
    const curr = this.selectedAgentId;
    const idx = curr !== null ? ids.indexOf(curr) : -1;
    const next = ids[(idx + 1) % ids.length];
    if (next !== undefined) this.selectedAgentId = next;
  }

  // ── Agent management ─────────────────────────────────────────
  async addAgent(bypassPermissions: boolean): Promise<void> {
    const workspacePath = this.opts.workspacePath ?? os.homedir();
    try {
      const result = await launchNewProcess(
        this.nextAgentId,
        this.agents,
        this.activeAgentId,
        this.knownJsonlFiles,
        this.fileWatchers,
        this.pollingTimers,
        this.waitingTimers,
        this.permissionTimers,
        this.jsonlPollTimers,
        this.projectScanTimer,
        this.dispatch,
        () => persistAgentsToDisk(this.agents),
        workspacePath,
        bypassPermissions,
      );
      this.setStatus(result.hint, 15000);
    } catch (e) {
      this.setStatus(`Failed to launch agent: ${String(e)}`);
    }
  }

  private closeAgent(id: number): void {
    // Mark as dismissed
    const agent = this.agents.get(id);
    if (agent) {
      dismissedJsonlFiles.set(agent.jsonlFile, Date.now());
    }
    removeAgent(
      id,
      this.agents,
      this.fileWatchers,
      this.pollingTimers,
      this.waitingTimers,
      this.permissionTimers,
      this.jsonlPollTimers,
      () => persistAgentsToDisk(this.agents),
    );
    this.dispatch({ type: 'agentClosed', id });
  }

  // ── Rendering ────────────────────────────────────────────────
  private render(): void {
    const os = this.officeState;
    const buf = this.pixelBuffer;

    const { offsetX: _ox, offsetY: _oy } = renderFrame(
      buf,
      os.tileMap,
      os.furniture,
      [...os.characters.values()],
      this.zoom,
      this.panX,
      this.panY,
      this.selectedAgentId,
      os.seats,
      os.layout.tileColors as Array<import('../../webview-ui/src/components/ui/types.js').ColorValue | null> | undefined,
      os.layout.cols,
      os.layout.rows,
    );

    // Build status line
    const agentCount = this.agents.size;
    const keys = '[A]dd  [D]elete  [Tab]select  [←→↑↓]pan  [+/-]zoom  [R]eset  [Q]uit';
    const agentInfo = agentCount > 0
      ? `Agents: ${agentCount}` + (this.selectedAgentId !== null ? ` | Selected: ${this.selectedAgentId}` : '')
      : 'No agents — press A to add one';
    const statusText = this.statusMessage
      ? `${agentInfo}  |  ${this.statusMessage}  |  ${keys}`
      : `${agentInfo}  |  ${keys}`;

    const canvasStr = pixelBufferToAnsi(buf);
    const statusStr = renderStatusBar(statusText, this.termCols);

    write('\x1b[H' + canvasStr + statusStr);
  }

  // ── Lifecycle ────────────────────────────────────────────────
  async start(): Promise<void> {
    // Terminal setup
    write(ENTER_ALT_SCREEN + HIDE_CURSOR + CLEAR_SCREEN);

    // Resize handler
    this.stopResize = onResize((size) => {
      this.termCols = size.cols;
      this.termRows = size.rows;
      this.pixelBuffer = new PixelBuffer(size.cols, Math.max(1, (size.rows - 1)) * 2);
    });

    // Keyboard input
    const cleanup = enableRawMode();
    this.stopKeys = cleanup;
    onKey((key) => this.handleKey(key));

    // Load assets & restore agents
    await this.loadAssets();

    // Start server + scanners
    await this.startServer();
    this.startScannersSync();

    // Layout file watcher
    this.layoutWatcher = watchLayoutFile((newLayout) => {
      try {
        const layout = newLayout as OfficeLayout;
        if (layout.version === 1) {
          this.officeState.rebuildFromLayout(migrateLayoutColors(layout));
        }
      } catch {
        /* ignore */
      }
    });

    // Game loop
    this.stopLoop = startGameLoop(
      {
        update: (dt) => {
          this.officeState.update(dt);
          // Camera follow: center pan on selected agent
          if (this.selectedAgentId !== null) {
            const ch = this.officeState.characters.get(this.selectedAgentId);
            if (ch) {
              const targetX = -(ch.x * this.zoom - this.pixelBuffer.width / 2);
              const targetY = -(ch.y * this.zoom - this.pixelBuffer.height / 2);
              this.panX += (targetX - this.panX) * Math.min(1, dt * 5);
              this.panY += (targetY - this.panY) * Math.min(1, dt * 5);
            }
          }
        },
        render: () => this.render(),
      },
      30,
    );
  }

  async stop(): Promise<void> {
    this.stopLoop?.();
    this.stopResize?.();
    this.stopKeys?.();
    this.layoutWatcher?.dispose();

    if (this.externalScanTimer) clearInterval(this.externalScanTimer);
    if (this.staleCheckTimer) clearInterval(this.staleCheckTimer);
    if (this.projectScanTimer.current) clearInterval(this.projectScanTimer.current);

    for (const t of this.pollingTimers.values()) clearInterval(t);
    for (const t of this.waitingTimers.values()) clearTimeout(t);
    for (const t of this.permissionTimers.values()) clearTimeout(t);
    for (const t of this.jsonlPollTimers.values()) clearInterval(t);
    for (const w of this.fileWatchers.values()) w.close();

    if (this.statusMessageTimer) clearTimeout(this.statusMessageTimer);

    await this.server?.stop?.().catch(() => {});

    write(SHOW_CURSOR + EXIT_ALT_SCREEN);
    process.exit(0);
  }
}
