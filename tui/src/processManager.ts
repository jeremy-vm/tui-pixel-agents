/**
 * processManager.ts — Spawn Claude Code sessions without VS Code terminals.
 *
 * Strategy:
 *   1. Try to open a new tmux window (if $TMUX is set)
 *   2. Try platform-specific terminal emulators (macOS: osascript, Linux: xterm)
 *   3. Fall back: print the command to the status display for manual copy-paste
 */

import { exec } from 'child_process';
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

function tryExec(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    exec(cmd, (err) => resolve(!err));
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
    ? `--session-id ${sessionId} --dangerously-skip-permissions`
    : `--session-id ${sessionId}`;
  const command = `claude ${claudeArgs}`;

  // 1. Try tmux (works in any terminal if tmux is running)
  if (process.env.TMUX) {
    const tmuxCmd = `tmux new-window -c ${JSON.stringify(cwd)} ${JSON.stringify(command)}`;
    if (await tryExec(tmuxCmd)) {
      return {
        opened: true,
        command,
        hint: `Opened new tmux window running: ${command}`,
      };
    }
  }

  const platform = os.platform();

  if (platform === 'darwin') {
    // macOS: AppleScript to open Terminal.app with the command
    const script = `tell application "Terminal" to do script "cd ${cwd.replace(/"/g, '\\"')} && ${command.replace(/"/g, '\\"')}"`;
    const appleScriptCmd = `osascript -e ${JSON.stringify(script)}`;
    if (await tryExec(appleScriptCmd)) {
      return {
        opened: true,
        command,
        hint: 'Opened Terminal.app with Claude Code session',
      };
    }
    // Try iTerm2
    const iTermScript = `tell application "iTerm2" to create window with default profile command "bash -c 'cd ${cwd.replace(/"/g, '\\"')} && ${command.replace(/"/g, '\\"')}'"`;
    if (await tryExec(`osascript -e ${JSON.stringify(iTermScript)}`)) {
      return { opened: true, command, hint: 'Opened iTerm2 with Claude Code session' };
    }
  } else if (platform === 'linux') {
    // Linux: try common terminal emulators
    const cdCmd = `bash -c 'cd ${JSON.stringify(cwd)} && ${command}'`;
    for (const term of [
      `gnome-terminal -- ${cdCmd}`,
      `xterm -e ${JSON.stringify(`bash -c 'cd ${cwd} && ${command}'`)}`,
      `konsole -e bash -c ${JSON.stringify(`cd ${cwd} && ${command}`)}`,
    ]) {
      if (await tryExec(term)) {
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
