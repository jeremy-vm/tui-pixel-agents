# TUI Pixel Agents — Compressed Reference

Terminal UI: pixel art office where AI agents (Claude Code sessions) are animated characters.

## Architecture

```
tui/                          — TUI application (Node.js, terminal rendering)
  src/
    index.ts                  — Entry: CLI args, TuiApp init, graceful shutdown
    app.ts                    — TuiApp orchestrator: agents, game state, render, keyboard, hooks
    agentManager.ts           — Agent lifecycle: launch, remove, restore, persist
    fileWatcher.ts            — JSONL file watching: fs.watch + polling, readNewLines, /clear detection
    transcriptParser.ts       — JSONL parsing: tool_use/tool_result → dispatch messages
    timerManager.ts           — Waiting/permission timer logic (uses DispatchFn)
    assetLoader.ts            — PNG→SpriteData loading for characters, furniture, floors, walls
    layoutPersistence.ts      — Layout file I/O (~/.pixel-agents/layout.json)
    processManager.ts         — Spawns terminal windows for Claude sessions
    gameLoop.ts               — Fixed-timestep update + render loop
    dispatch.ts               — Message bus (DispatchFn replaces postMessage)
    constants.ts              — TUI-specific constants
    types.ts                  — TUI agent types (AgentState without vscode.Terminal)
    renderer/
      pixelBuffer.ts          — In-memory pixel buffer (Int32Array)
      officeRenderer.ts       — Renders game world to pixel buffer
      terminalOutput.ts       — Pixel buffer → ANSI half-block output
    terminal/
      screen.ts               — Terminal setup/cleanup, resize
      input.ts                — Raw keyboard input

server/                       — Hook event HTTP server (standalone Node.js)
  src/
    server.ts                 — HTTP server: hook endpoint, health, server.json discovery
    hookEventHandler.ts       — Routes hook events to agents, buffers pre-registration
    types.ts                  — AgentState, PersistedAgent, MessageSender interface
    timerManager.ts           — Timer functions for permission/waiting detection
    constants.ts              — Timing/scanning constants
    providers/file/
      claudeHookInstaller.ts  — Install/uninstall hooks in ~/.claude/settings.json
      hooks/claude-hook.ts    — Hook script: reads stdin, POSTs to server
  __tests__/                  — Vitest test suite

webview-ui/src/               — Shared game engine (pure TypeScript, no UI framework)
  constants.ts                — All game magic numbers/strings
  office/
    types.ts                  — Interfaces: Character, OfficeLayout, Seat, ColorValue, etc.
    engine/officeState.ts     — Game world: layout, characters, seats, sub-agents
    engine/characters.ts      — Character FSM: idle/walk/type + wander AI
    engine/matrixEffect.ts    — Matrix-style spawn/despawn animation
    layout/tileMap.ts         — Walkability, BFS pathfinding
    layout/layoutSerializer.ts — OfficeLayout ↔ runtime
    layout/furnitureCatalog.ts — Dynamic catalog, rotation/state groups
    sprites/spriteData.ts     — Character sprite pixel data, bubble sprites
    floorTiles.ts             — Floor sprite storage + colorized cache
    wallTiles.ts              — Wall auto-tile: 16 bitmask sprites
    colorize.ts               — Dual-mode: Colorize (grayscale→HSL) + Adjust (HSL shift)
    toolUtils.ts              — Tool name → animation state mapping

shared/                       — Asset loading utilities
  assets/
    pngDecoder.ts             — PNG → RGBA pixel data
    manifestUtils.ts          — Furniture manifest parsing
    loader.ts                 — Asset index loading
    build.ts                  — Asset catalog building
    constants.ts              — Asset constants
    types.ts                  — Asset type definitions
```

## Core Concepts

**Vocabulary**: Session = JSONL conversation file. Agent = character bound 1:1 to a Claude process.

**Agent lifecycle**: `n` key → spawn new terminal (`claude --session-id <uuid>`) → poll for `<uuid>.jsonl` → file watching starts.

**JSONL transcripts** at `~/.claude/projects/<project-hash>/<session-id>.jsonl`. Project hash = workspace path with `:`/`\`/`/` → `-`.

**Hook-based detection**: HTTP server receives events from Claude Code via hook scripts. Events: `Stop`, `PermissionRequest`, `Notification`. Server discovery via `~/.pixel-agents/server.json`.

**Layout**: Persisted to `~/.pixel-agents/layout.json`. Default layout bundled in `webview-ui/public/assets/default-layout.json`.

## Build & Dev

```sh
npm install && cd tui && npm install && cd ../server && npm install && cd ..
cd tui && npm run build
```

Or use `./run.sh` to build and run in one step.

Testing:
- `npm run test:server` — server tests (Vitest)
- `cd tui && npm run build` — verify TUI builds

## TypeScript Constraints

- No `enum` (`erasableSyntaxOnly`) — use `as const` objects
- `import type` required for type-only imports (`verbatimModuleSyntax`)
- `noUnusedLocals` / `noUnusedParameters`

## Constants

All magic numbers centralized:
- **Server**: `server/src/constants.ts` — timing intervals, poll intervals, delays
- **Game engine**: `webview-ui/src/constants.ts` — tile sizes, animation speeds, colors, timings
- **TUI**: `tui/src/constants.ts` — TUI-specific rendering constants
