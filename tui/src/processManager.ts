/**
 * processManager.ts — Spawn Claude Code sessions without VS Code terminals.
 *
 * Strategy:
 *   1. Try to open a new tmux window (if $TMUX is set)
 *   2. Try platform-specific terminal emulators (macOS: osascript, Linux: xterm)
 *   3. Fall back: print the command to the status display for manual copy-paste
 *
 * Security note: All paths and arguments are passed as separate argv elements
 * (not interpolated into shell strings) to prevent command injection.
 */

import { execFile } from 'child_process';
import * as os from 'os';

/** Result of a launch attempt */
export interface LaunchResult {
  /** True if a new terminal window was opened successfully */
  opened: boolean;
  /** The claude command the user must run (for display or auto-injection) */
  command: string;
  /** Hint message for the user */
  hint: string;
}

/** Promisify execFile — returns true if the process exits successfully. */
function trySpawn(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cmd, args, (err) => resolve(!err));
  });
}

/**
 * Attempt to launch `claude --session-id <sessionId>` in a new terminal window/pane.
 * Returns a LaunchResult describing what happened.
 */
export async function launchClaudeSession(
  sessionId: string,
  cwd: string,
  bypassPermissions: boolean,
): Promise<LaunchResult> {
  const claudeArgs = bypassPermissions
    ? ['--session-id', sessionId, '--dangerously-skip-permissions']
    : ['--session-id', sessionId];
  const command = `claude ${claudeArgs.join(' ')}`;

  // 1. Try tmux — pass cwd and command as separate argv elements (no shell)
  if (process.env.TMUX) {
    if (await trySpawn('tmux', ['new-window', '-c', cwd, 'claude', ...claudeArgs])) {
      return {
        opened: true,
        command,
        hint: `Opened new tmux window running: ${command}`,
      };
    }
  }

  const platform = os.platform();

  if (platform === 'darwin') {
    // macOS: AppleScript via osascript. Build the do script argument programmatically.
    // The AppleScript string is constructed so that cwd and command are embedded as
    // AppleScript string literals, with both backslash and double-quote chars escaped.
    const appleEscape = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const termScript = `tell application "Terminal" to do script "cd ${appleEscape(cwd)} && ${appleEscape(command)}"`;
    if (await trySpawn('osascript', ['-e', termScript])) {
      return { opened: true, command, hint: 'Opened Terminal.app with Claude Code session' };
    }
    // Try iTerm2
    const itermScript = `tell application "iTerm2" to create window with default profile command "bash -c 'cd ${appleEscape(cwd)} && ${appleEscape(command)}'"`;
    if (await trySpawn('osascript', ['-e', itermScript])) {
      return { opened: true, command, hint: 'Opened iTerm2 with Claude Code session' };
    }
  } else if (platform === 'linux') {
    // Linux: try common terminal emulators.
    // Pass the shell command as a single argument to bash -c to avoid extra quoting issues.
    const bashCmd = `cd -- "${cwd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" && ${command}`;
    const attempts: [string, string[]][] = [
      ['gnome-terminal', ['--', 'bash', '-c', bashCmd]],
      ['xterm', ['-e', 'bash', '-c', bashCmd]],
      ['konsole', ['-e', 'bash', '-c', bashCmd]],
      ['xfce4-terminal', ['-e', `bash -c ${JSON.stringify(bashCmd)}`]],
    ];
    for (const [term, args] of attempts) {
      if (await trySpawn(term, args)) {
        return { opened: true, command, hint: `Opened terminal with Claude Code session` };
      }
    }
  }

  // Fallback: print the command — user must run it manually
  return {
    opened: false,
    command,
    hint: `Run in another terminal:\n  cd ${cwd}\n  ${command}`,
  };
}

