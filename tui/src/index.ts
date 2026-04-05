#!/usr/bin/env node
/**
 * index.ts — CLI entry point for Pixel Agents TUI.
 *
 * Usage:
 *   pixel-agents [options]
 *
 * Options:
 *   --workspace <path>   Working directory for Claude sessions (default: cwd)
 *   --watch-all          Adopt all active Claude sessions from ~/.claude/projects/
 *   --no-hooks           Disable hook event server
 *   --help               Show this help
 */

import * as path from 'path';
import * as fs from 'fs';
import { TuiApp } from './app.js';

const VERSION = process.env.TUI_VERSION ?? '0.1.0';

function printHelp(): void {
  console.log(`
Pixel Agents TUI v${VERSION}
Pixel art office that visualizes your Claude Code agents in the terminal.

Usage:
  pixel-agents [options]

Options:
  --workspace <path>   Working directory (default: current directory)
  --watch-all          Adopt all active Claude sessions from ~/.claude/projects/
  --no-hooks           Disable the hook event server
  --help               Show this help message
  --version            Show version

Controls (while running):
  A            Add a new Claude Code agent
  Tab          Cycle selected agent
  D            Close selected agent
  Arrow keys   Pan the view
  + / -        Zoom in / out
  R            Reset pan and zoom
  Q / Ctrl+C   Quit
`);
}

function parseArgs(argv: string[]): {
  workspace?: string;
  watchAll: boolean;
  hooks: boolean;
  help: boolean;
  version: boolean;
} {
  const result = { workspace: undefined as string | undefined, watchAll: false, hooks: true, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { result.help = true; }
    else if (arg === '--version' || arg === '-v') { result.version = true; }
    else if (arg === '--watch-all') { result.watchAll = true; }
    else if (arg === '--no-hooks') { result.hooks = false; }
    else if (arg === '--workspace' && argv[i + 1]) {
      result.workspace = path.resolve(argv[++i]!);
    }
  }
  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (args.version) {
    console.log(VERSION);
    process.exit(0);
  }

  // Verify we're running in a TTY
  if (!process.stdout.isTTY) {
    console.error('pixel-agents requires a TTY terminal. Pipe output is not supported.');
    process.exit(1);
  }

  // Resolve assets root: look for webview-ui/public/assets relative to this script
  const scriptDir = path.dirname(process.argv[1] ?? '');
  const candidates = [
    path.join(scriptDir, '..', 'webview-ui', 'public'),  // dev mode: tui/dist/index.js
    path.join(scriptDir, '..', '..', 'webview-ui', 'public'), // nested dist
    path.join(process.cwd(), 'webview-ui', 'public'),
  ];
  let assetsRoot: string | undefined;
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'assets'))) {
      assetsRoot = c;
      break;
    }
  }

  const app = new TuiApp({
    workspacePath: args.workspace ?? process.cwd(),
    watchAll: args.watchAll,
    hooksEnabled: args.hooks,
    assetsRoot,
  });

  // Handle signals gracefully
  process.on('SIGINT', () => { void app.stop(); });
  process.on('SIGTERM', () => { void app.stop(); });
  process.on('uncaughtException', (err) => {
    // Restore terminal before crashing
    process.stdout.write('\x1b[?25h\x1b[?1049l');
    console.error('Uncaught exception:', err);
    process.exit(1);
  });

  await app.start();
}

main().catch((err: unknown) => {
  process.stdout.write('\x1b[?25h\x1b[?1049l');
  console.error('Fatal error:', err);
  process.exit(1);
});
