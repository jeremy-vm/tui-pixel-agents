# TUI Pixel Agents

A terminal UI that renders your Claude Code agents as animated pixel art characters in a virtual office — directly in your terminal, no VS Code required.

## Quick Start

```bash
# Clone and run
git clone https://github.com/jeremy-vm/tui-pixel-agents.git
cd tui-pixel-agents
./run.sh
```

Or build and run manually:

```bash
npm install
cd tui && npm install && npm run build && cd ..
node tui/dist/index.js
```

### CLI Options

```
--workspace <path>   Working directory (default: current directory)
--watch-all          Adopt all active Claude sessions from ~/.claude/projects/
--no-hooks           Disable the hook event server
--help               Show help
--version            Show version
```

### Keyboard Controls

- **`n`** — Launch a new Claude Code agent
- **`q`** — Quit
- **`1-9`** — Focus agent by number
- **Arrow keys** — Pan the camera

## Architecture

```
tui-pixel-agents/
├── tui/                    ← TUI application (entry point)
├── server/                 ← Hook event HTTP server
├── webview-ui/src/         ← Shared game engine (sprites, layout, state)
├── shared/                 ← Shared asset loading utilities
├── scripts/                ← Asset pipeline tools
└── run.sh                  ← Build & run script
```

### `tui/` — Terminal UI Application

The main entry point. A standalone Node.js application that renders the pixel art office in your terminal using ANSI half-block characters (▀▄).

| File | Purpose |
|------|---------|
| `src/index.ts` | CLI entry point — parses arguments, initializes `TuiApp` |
| `src/app.ts` | Main orchestrator — manages agents, game state, rendering, keyboard input, and the hook server |
| `src/agentManager.ts` | Agent lifecycle — launches Claude processes, restores/persists agents, tracks sessions |
| `src/fileWatcher.ts` | Watches `~/.claude/projects/<hash>/<session>.jsonl` files for agent activity changes |
| `src/transcriptParser.ts` | Parses JSONL transcript lines into tool start/done/status events |
| `src/timerManager.ts` | Manages waiting/permission detection timers for agents |
| `src/assetLoader.ts` | Loads PNG sprites (characters, furniture, floors, walls) from `webview-ui/public/assets/` |
| `src/layoutPersistence.ts` | Reads/writes office layout from `~/.pixel-agents/layout.json` |
| `src/gameLoop.ts` | Fixed-timestep update loop (calls `OfficeState.update()` + renders) |
| `src/processManager.ts` | Spawns new terminal windows for Claude sessions |
| `src/dispatch.ts` | Simple message bus replacing VS Code's `postMessage` bridge |
| `src/renderer/pixelBuffer.ts` | In-memory pixel buffer (`Int32Array`) for compositing sprites |
| `src/renderer/officeRenderer.ts` | Renders the game world (floor, walls, furniture, characters, bubbles) to the pixel buffer |
| `src/renderer/terminalOutput.ts` | Converts pixel buffer → ANSI escape codes using Unicode half-block characters |
| `src/terminal/screen.ts` | Raw terminal setup/cleanup, resize handling |
| `src/terminal/input.ts` | Keyboard event capture in raw mode |

### `server/` — Hook Event Server

A standalone HTTP server that receives webhook events from Claude Code's hook system. This enables real-time agent status detection (waiting, permission requests, turn completion) without relying on slower JSONL file polling heuristics.

| File | Purpose |
|------|---------|
| `src/server.ts` | HTTP server — listens on an ephemeral port, writes `~/.pixel-agents/server.json` for discovery |
| `src/hookEventHandler.ts` | Routes hook events (`Stop`, `PermissionRequest`, `Notification`) to the correct agent |
| `src/types.ts` | Shared types — `AgentState`, `PersistedAgent`, `MessageSender` interface |
| `src/timerManager.ts` | Timer functions for permission/waiting detection (shared with TUI) |
| `src/constants.ts` | Timing constants (poll intervals, buffer durations, timer delays) |
| `src/providers/file/claudeHookInstaller.ts` | Installs/uninstalls hook scripts in `~/.claude/settings.json` |
| `src/providers/file/hooks/claude-hook.ts` | The hook script itself — reads stdin events and POSTs them to the server |

### `webview-ui/src/` — Shared Game Engine

Pure TypeScript game logic with no UI framework dependencies. Used by the TUI for character state machines, pathfinding, sprite data, and layout management.

| File/Directory | Purpose |
|----------------|---------|
| `constants.ts` | All game constants — tile sizes, animation speeds, colors, timings |
| `office/types.ts` | Core interfaces — `Character`, `OfficeLayout`, `Seat`, `FurnitureInstance`, etc. |
| `office/engine/officeState.ts` | Game world state machine — manages characters, seats, layout, and per-frame updates |
| `office/engine/characters.ts` | Character FSM — idle/walk/type states, wander AI, pathfinding movement |
| `office/engine/matrixEffect.ts` | Matrix-style spawn/despawn digital rain animation |
| `office/layout/tileMap.ts` | Walkability grid, BFS pathfinding |
| `office/layout/layoutSerializer.ts` | Serializes/deserializes `OfficeLayout` (tiles, furniture, colors) |
| `office/layout/furnitureCatalog.ts` | Dynamic furniture catalog from loaded assets, rotation/state groups |
| `office/sprites/spriteData.ts` | Character sprite pixel data (6 palette variations), bubble sprites |
| `office/floorTiles.ts` | Floor tile sprite storage and colorization cache |
| `office/wallTiles.ts` | Wall auto-tile bitmask sprites (16 variants) |
| `office/colorize.ts` | Dual-mode color module — Colorize (grayscale→HSL) and Adjust (HSL shift) |
| `office/toolUtils.ts` | Maps tool names to animation states (typing vs reading) |

### `shared/` — Asset Loading Utilities

PNG decoding and asset manifest parsing, shared between the TUI and server.

| File | Purpose |
|------|---------|
| `assets/pngDecoder.ts` | Decodes PNG files to RGBA pixel data |
| `assets/manifestUtils.ts` | Parses furniture manifest JSON files |
| `assets/loader.ts` | Loads asset index and tilesets |
| `assets/build.ts` | Builds asset catalog from manifest |
| `assets/constants.ts` | Asset-related constants (character count, frame counts) |
| `assets/types.ts` | Asset type definitions |

## How It Works

### Agent Detection

When you launch a new agent (press `n`), the TUI:
1. Spawns a new terminal running `claude --session-id <uuid>`
2. Polls `~/.claude/projects/<project-hash>/` for the `<uuid>.jsonl` file
3. Once found, starts watching the JSONL file for activity

The **project hash** is derived from the workspace path: `/` and `\` and `:` are replaced with `-`.

With `--watch-all`, the TUI also scans `~/.claude/projects/` for any active sessions from other terminals.

### Hook System

For real-time status detection, the TUI optionally runs a hook event server:

1. **Server starts** on an ephemeral port, writes `~/.pixel-agents/server.json` (port + auth token + PID)
2. **Hook script installed** at `~/.pixel-agents/hooks/claude-hook.js` and registered in `~/.claude/settings.json`
3. Claude Code invokes the hook on events (`Stop`, `PermissionRequest`, `Notification`)
4. Hook script reads the event from stdin and POSTs it to the local server
5. Server routes the event to the matching agent by `session_id`

When hooks are active (`agent.hookDelivered = true`), heuristic timers for permission/waiting detection are suppressed.

### Data Storage

| Path | Purpose |
|------|---------|
| `~/.pixel-agents/layout.json` | Office layout (tiles, furniture, colors) |
| `~/.pixel-agents/config.json` | User configuration (external asset directories) |
| `~/.pixel-agents/server.json` | Running server discovery (port, PID, auth token) |
| `~/.pixel-agents/hooks/claude-hook.js` | Installed hook script |
| `~/.claude/settings.json` | Claude Code settings (hook registration) |
| `~/.claude/projects/<hash>/<session>.jsonl` | Claude Code session transcripts (read-only) |

### Rendering Pipeline

1. **Game loop** runs at a fixed timestep, calling `OfficeState.update(dt)` to advance character animations and AI
2. **OfficeRenderer** composites floor tiles, walls, furniture, characters, and speech bubbles into a `PixelBuffer`
3. **TerminalOutput** converts the pixel buffer into ANSI escape codes using Unicode half-block characters (`▀`), where each terminal cell represents a 1×2 pixel pair
4. Output is written to stdout, producing the pixel art display

## Development

```bash
# Install all dependencies
npm install && cd tui && npm install && cd ../server && npm install && cd ..

# Build the TUI
cd tui && npm run build

# Development mode (auto-rebuild on changes)
cd tui && npm run dev

# Run server tests
npm run test:server

# Type-check
npm run check-types

# Lint
npm run lint
```

## License

MIT
