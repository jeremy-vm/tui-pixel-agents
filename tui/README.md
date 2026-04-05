# Pixel Agents TUI

A terminal UI version of Pixel Agents — a pixel art office that visualizes your Claude Code agents as animated characters, running entirely in your terminal without VS Code.

## Requirements

- Node.js 18+
- A terminal emulator with:
  - **True color (24-bit) ANSI support** — iTerm2, Kitty, WezTerm, GNOME Terminal, Windows Terminal, etc.
  - **Unicode support** — for half-block characters (▀▄)
- Claude Code CLI (`claude` command available in `$PATH`)

## Building

From the repository root:

```sh
# Install dependencies
npm install
cd webview-ui && npm install && cd ..

# Build the webview assets (sprites, layout, etc.)
npm run build:webview

# Build the TUI
cd tui && npm install && node esbuild.js
```

## Running

```sh
# From the tui/ directory after building:
node dist/index.js

# Or if installed globally:
pixel-agents
```

### Options

```
--workspace <path>   Working directory for Claude sessions (default: cwd)
--watch-all          Adopt all active Claude sessions from ~/.claude/projects/
--no-hooks           Disable the hook event server
--help               Show help
```

## Controls

| Key | Action |
|-----|--------|
| `A` | Spawn a new Claude Code agent |
| `Tab` | Cycle selected agent |
| `D` | Close selected agent |
| `←→↑↓` | Pan the view |
| `+` / `-` | Zoom in / out |
| `R` | Reset pan and zoom to default |
| `Q` / `Ctrl+C` | Quit |

## How It Works

### Architecture

The TUI replaces three VS Code-specific layers from the original extension:

| Original (VS Code) | TUI |
|---|---|
| `PixelAgentsViewProvider` (WebviewViewProvider) | `TuiApp` class |
| React webview with Canvas 2D renderer | `PixelBuffer` + half-block ANSI renderer |
| `vscode.window.createTerminal` | `child_process` + platform terminal launch |
| `webview.postMessage` / `onDidReceiveMessage` | Direct function calls via `DispatchFn` callback |
| VS Code workspace state | `~/.pixel-agents/tui-agents.json` |

### Reused modules (no changes needed)

- `server/` — Hook event server, Claude hook installer
- `webview-ui/src/office/engine/officeState.ts` — Game state
- `webview-ui/src/office/engine/characters.ts` — Character FSM
- `webview-ui/src/office/layout/` — Tile map, furniture catalog, layout serializer
- `webview-ui/src/office/sprites/spriteData.ts` — Sprite pixel data
- `webview-ui/src/office/colorize.ts` — Colorization module
- `webview-ui/src/office/floorTiles.ts` / `wallTiles.ts` — Tile rendering data
- `src/transcriptParser.ts`, `src/timerManager.ts`, `src/fileWatcher.ts` — Ported with `vscode` references removed

### Rendering

Sprites are stored as `string[][]` (2D arrays of hex color strings). The TUI renderer:

1. Draws sprites, floor tiles, furniture, and characters into a `PixelBuffer` (a `Int32Array` of packed RGBA pixels)
2. Converts the pixel buffer to ANSI terminal output using **Unicode half-block characters** (`▀`):
   - Each terminal cell represents 2 vertical pixels
   - FG color = top pixel, BG color = bottom pixel
   - Uses true color ANSI escapes: `\x1b[38;2;R;G;Bm` (foreground) and `\x1b[48;2;R;G;Bm` (background)

### Spawning Agents

When you press `A`:

1. A session UUID is generated
2. The TUI tries to open a new terminal window with `claude --session-id <uuid>`:
   - **tmux**: opens a new tmux window (if `$TMUX` is set)
   - **macOS**: uses AppleScript to open Terminal.app or iTerm2
   - **Linux**: tries gnome-terminal, xterm, konsole
   - **Fallback**: shows the command in the status bar for you to copy
3. The TUI polls `~/.claude/projects/<workspace-hash>/<uuid>.jsonl` for Claude's output
4. Once detected, a new character spawns in the office

### Configuration

All state is stored in `~/.pixel-agents/`:
- `layout.json` — Office layout (shared with the VS Code extension)
- `tui-agents.json` — Persisted agent sessions (TUI-specific)
- `config.json` — External asset directories (shared with extension)

## Limitations

- **Terminal resolution**: Limited by terminal cell size. At zoom=2 (default), the 20×11 tile office is 640×352 pixels = 640 columns × 176 terminal rows. Most terminals are narrower, so the camera follows the selected agent.
- **Editor mode**: The layout editor is not implemented in the TUI. Edit `~/.pixel-agents/layout.json` directly, or use the VS Code extension.
- **Sound notifications**: Terminal bell (`\x07`) is used instead of the Web Audio API chime.
- **Mouse support**: Click-to-select and drag-to-pan are not yet implemented. Use keyboard controls.

## Development

```sh
# Watch mode (rebuilds on changes)
cd tui && node esbuild.js --watch

# Type check
cd tui && npx tsc --noEmit
```
