/**
 * fileWatcher.ts — Port of src/fileWatcher.ts without VS Code dependencies.
 *
 * Key changes from original:
 * - Removed vscode.window.activeTerminal / vscode.window.terminals
 * - Removed /clear detection heuristic (relies on terminal focus — not applicable in TUI)
 * - Replaced webview.postMessage with dispatch callback
 * - External session scanning preserved (watchAllSessions mode)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  CLEAR_IDLE_THRESHOLD_MS,
  DISMISSED_COOLDOWN_MS,
  EXTERNAL_ACTIVE_THRESHOLD_MS,
  EXTERNAL_SCAN_INTERVAL_MS,
  EXTERNAL_STALE_CHECK_INTERVAL_MS,
  FILE_WATCHER_POLL_INTERVAL_MS,
  GLOBAL_SCAN_ACTIVE_MAX_AGE_MS,
  GLOBAL_SCAN_ACTIVE_MIN_SIZE,
  PROJECT_SCAN_INTERVAL_MS,
} from '../../server/src/constants.js';
import type { DispatchFn } from './dispatch.js';
import { cancelPermissionTimer, cancelWaitingTimer } from './timerManager.js';
import { processTranscriptLine } from './transcriptParser.js';
import type { AgentState } from './types.js';

/** Files explicitly dismissed by the user (closed via X). Temporarily blocked from re-adoption. */
export const dismissedJsonlFiles = new Map<string, number>(); // path → dismissal timestamp

/** Files permanently dismissed by /clear reassignment. Never re-adopted in this session. */
const clearDismissedFiles = new Set<string>();

/** Mtime at seeding time. If mtime changes later, file was resumed. */
const seededMtimes = new Map<string, number>();

/** /clear files waiting for second tick. */
const pendingClearFiles = new Map<string, number>();

export function startFileWatching(
  agentId: number,
  _filePath: string,
  agents: Map<number, AgentState>,
  _fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  dispatch: DispatchFn,
): void {
  const interval = setInterval(() => {
    if (!agents.has(agentId)) {
      clearInterval(interval);
      return;
    }
    readNewLines(agentId, agents, waitingTimers, permissionTimers, dispatch);
  }, FILE_WATCHER_POLL_INTERVAL_MS);
  pollingTimers.set(agentId, interval);
}

export function readNewLines(
  agentId: number,
  agents: Map<number, AgentState>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  dispatch: DispatchFn,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;
  try {
    const stat = fs.statSync(agent.jsonlFile);
    if (stat.size <= agent.fileOffset) return;

    const MAX_READ_BYTES = 65536;
    const bytesToRead = Math.min(stat.size - agent.fileOffset, MAX_READ_BYTES);
    const buf = Buffer.alloc(bytesToRead);
    const fd = fs.openSync(agent.jsonlFile, 'r');
    fs.readSync(fd, buf, 0, buf.length, agent.fileOffset);
    fs.closeSync(fd);
    agent.fileOffset += bytesToRead;

    const text = agent.lineBuffer + buf.toString('utf-8');
    const lines = text.split('\n');
    agent.lineBuffer = lines.pop() || '';

    const hasLines = lines.some((l) => l.trim());
    if (hasLines) {
      cancelWaitingTimer(agentId, waitingTimers);
      cancelPermissionTimer(agentId, permissionTimers);
      if (agent.permissionSent && !agent.hookDelivered) {
        agent.permissionSent = false;
        dispatch({ type: 'agentToolPermissionClear', id: agentId });
      }
    }

    for (const line of lines) {
      if (!line.trim()) continue;
      processTranscriptLine(agentId, line, agents, waitingTimers, permissionTimers, dispatch);
    }
  } catch {
    // File may have been rotated or not yet available
  }
}

// Track all project directories to scan (supports multi-root workspaces)
const trackedProjectDirs = new Set<string>();

export function isProjectDirTracked(projectDir: string): boolean {
  return trackedProjectDirs.has(projectDir);
}

type RemoveAgentFn = (
  agentId: number,
  agents: Map<number, AgentState>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
  persistAgents: () => void,
) => void;

function reassignAgentToFile(
  agentId: number,
  newFile: string,
  agents: Map<number, AgentState>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  dispatch: DispatchFn,
  persistAgents: () => void,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;

  // Stop watching old file
  fileWatchers.get(agentId)?.close();
  fileWatchers.delete(agentId);
  const pt = pollingTimers.get(agentId);
  if (pt) {
    clearInterval(pt);
    pollingTimers.delete(agentId);
  }

  const oldFile = agent.jsonlFile;
  clearDismissedFiles.add(oldFile);

  // Reset agent state for new file
  agent.jsonlFile = newFile;
  agent.fileOffset = 0;
  agent.lineBuffer = '';
  agent.activeToolIds.clear();
  agent.activeToolStatuses.clear();
  agent.activeToolNames.clear();
  agent.activeSubagentToolIds.clear();
  agent.activeSubagentToolNames.clear();
  agent.backgroundAgentToolIds.clear();
  agent.isWaiting = false;
  agent.permissionSent = false;
  agent.hadToolsInTurn = false;
  agent.linesProcessed = 0;
  agent.seenUnknownRecordTypes.clear();
  agent.hookDelivered = false;
  agent.sessionId = path.basename(newFile, '.jsonl');

  cancelWaitingTimer(agentId, waitingTimers);
  cancelPermissionTimer(agentId, permissionTimers);

  dispatch({ type: 'agentToolsClear', id: agentId });
  dispatch({ type: 'agentStatus', id: agentId, status: 'active' });

  persistAgents();

  // Start watching the new file
  startFileWatching(
    agentId,
    newFile,
    agents,
    fileWatchers,
    pollingTimers,
    waitingTimers,
    permissionTimers,
    dispatch,
  );
  readNewLines(agentId, agents, waitingTimers, permissionTimers, dispatch);
}

export function ensureProjectScan(
  projectDir: string,
  knownJsonlFiles: Set<string>,
  projectScanTimerRef: { current: ReturnType<typeof setInterval> | null },
  activeAgentIdRef: { current: number | null },
  nextAgentIdRef: { current: number },
  agents: Map<number, AgentState>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  dispatch: DispatchFn,
  persistAgents: () => void,
): void {
  trackedProjectDirs.add(projectDir);

  if (projectScanTimerRef.current) return;

  projectScanTimerRef.current = setInterval(() => {
    try {
      if (!fs.existsSync(projectDir)) return;
      const files = fs
        .readdirSync(projectDir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => path.join(projectDir, f));

      for (const file of files) {
        if (knownJsonlFiles.has(file)) continue;
        if (clearDismissedFiles.has(file)) continue;

        const dismissed = dismissedJsonlFiles.get(file);
        if (dismissed !== undefined) {
          if (Date.now() - dismissed < DISMISSED_COOLDOWN_MS) continue;
          dismissedJsonlFiles.delete(file);
        }

        const seededMtime = seededMtimes.get(file);
        if (seededMtime !== undefined) {
          try {
            const currentMtime = fs.statSync(file).mtimeMs;
            if (currentMtime <= seededMtime) continue;
            seededMtimes.delete(file);
          } catch {
            continue;
          }
        }

        // Determine if this looks like a /clear file (has the clear command record)
        let isClearFile = false;
        try {
          const buf = Buffer.alloc(8192);
          const fd = fs.openSync(file, 'r');
          const bytesRead = fs.readSync(fd, buf, 0, 8192, 0);
          fs.closeSync(fd);
          if (buf.toString('utf-8', 0, bytesRead).includes('/clear</command-name>')) {
            isClearFile = true;
          }
        } catch {
          continue;
        }

        if (!isClearFile) continue;

        // Check pending status (two-tick to give per-agent check time to claim)
        const firstSeen = pendingClearFiles.get(file);
        if (firstSeen === undefined) {
          pendingClearFiles.set(file, Date.now());
          continue;
        }
        if (Date.now() - firstSeen < CLEAR_IDLE_THRESHOLD_MS) continue;
        pendingClearFiles.delete(file);

        // Find the active agent (most recently used)
        if (activeAgentIdRef.current === null) continue;
        const targetAgent = agents.get(activeAgentIdRef.current);
        if (!targetAgent || targetAgent.isExternal) continue;

        knownJsonlFiles.add(file);
        console.log(
          `[Pixel Agents] /clear detected: reassigning agent ${activeAgentIdRef.current} to ${path.basename(file)}`,
        );
        reassignAgentToFile(
          activeAgentIdRef.current,
          file,
          agents,
          fileWatchers,
          pollingTimers,
          waitingTimers,
          permissionTimers,
          dispatch,
          persistAgents,
        );
        break;
      }
    } catch {
      // Ignore scan errors
    }
  }, PROJECT_SCAN_INTERVAL_MS);
}

export function startExternalSessionScanning(
  projectDir: string,
  knownJsonlFiles: Set<string>,
  nextAgentIdRef: { current: number },
  agents: Map<number, AgentState>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
  dispatch: DispatchFn,
  persistAgents: () => void,
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    try {
      if (!fs.existsSync(projectDir)) return;
      const now = Date.now();
      const files = fs
        .readdirSync(projectDir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => path.join(projectDir, f));

      for (const file of files) {
        if (knownJsonlFiles.has(file)) continue;
        if (clearDismissedFiles.has(file)) continue;

        const dismissed = dismissedJsonlFiles.get(file);
        if (dismissed !== undefined) {
          if (now - dismissed < DISMISSED_COOLDOWN_MS) continue;
          dismissedJsonlFiles.delete(file);
        }

        let stat: fs.Stats;
        try {
          stat = fs.statSync(file);
        } catch {
          continue;
        }

        // Only adopt recently modified files
        if (now - stat.mtimeMs > EXTERNAL_ACTIVE_THRESHOLD_MS) continue;

        knownJsonlFiles.add(file);
        const id = nextAgentIdRef.current++;
        const sessionId = path.basename(file, '.jsonl');

        const agent: AgentState = {
          id,
          sessionId,
          isExternal: true,
          projectDir,
          jsonlFile: file,
          fileOffset: 0,
          lineBuffer: '',
          activeToolIds: new Set(),
          activeToolStatuses: new Map(),
          activeToolNames: new Map(),
          activeSubagentToolIds: new Map(),
          activeSubagentToolNames: new Map(),
          backgroundAgentToolIds: new Set(),
          isWaiting: false,
          permissionSent: false,
          hadToolsInTurn: false,
          lastDataAt: 0,
          linesProcessed: 0,
          seenUnknownRecordTypes: new Set(),
          hookDelivered: false,
        };

        agents.set(id, agent);
        persistAgents();
        dispatch({ type: 'agentCreated', id, isExternal: true });

        // Seed to end of file to avoid replaying history
        try {
          const s = fs.statSync(file);
          agent.fileOffset = s.size;
          seededMtimes.set(file, s.mtimeMs);
        } catch {
          /* ignore */
        }

        startFileWatching(
          id,
          file,
          agents,
          fileWatchers,
          pollingTimers,
          waitingTimers,
          permissionTimers,
          dispatch,
        );

        console.log(
          `[Pixel Agents] Adopted external session: ${sessionId} → agent ${id}`,
        );
      }
    } catch {
      // Ignore scan errors
    }
  }, EXTERNAL_SCAN_INTERVAL_MS);
}

export function startStaleExternalAgentCheck(
  agents: Map<number, AgentState>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
  removeAgentFn: RemoveAgentFn,
  dispatch: DispatchFn,
  persistAgents: () => void,
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    const now = Date.now();
    for (const [id, agent] of agents) {
      if (!agent.isExternal) continue;
      try {
        if (!fs.existsSync(agent.jsonlFile)) {
          console.log(`[Pixel Agents] Removing stale external agent ${id}: file gone`);
          removeAgentFn(
            id,
            agents,
            fileWatchers,
            pollingTimers,
            waitingTimers,
            permissionTimers,
            jsonlPollTimers,
            persistAgents,
          );
          dispatch({ type: 'agentClosed', id });
          continue;
        }
        const stat = fs.statSync(agent.jsonlFile);
        if (now - stat.mtimeMs > EXTERNAL_ACTIVE_THRESHOLD_MS * 5) {
          console.log(`[Pixel Agents] Removing stale external agent ${id}: file inactive`);
          removeAgentFn(
            id,
            agents,
            fileWatchers,
            pollingTimers,
            waitingTimers,
            permissionTimers,
            jsonlPollTimers,
            persistAgents,
          );
          dispatch({ type: 'agentClosed', id });
        }
      } catch {
        // ignore
      }
    }
  }, EXTERNAL_STALE_CHECK_INTERVAL_MS);
}

export function startGlobalSessionScanning(
  globalDismissedFiles: Set<string>,
  knownJsonlFiles: Set<string>,
  nextAgentIdRef: { current: number },
  agents: Map<number, AgentState>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
  dispatch: DispatchFn,
  persistAgents: () => void,
): ReturnType<typeof setInterval> {
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');

  return setInterval(() => {
    try {
      if (!fs.existsSync(projectsRoot)) return;
      const now = Date.now();
      const projectDirs = fs
        .readdirSync(projectsRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(projectsRoot, e.name));

      for (const projectDir of projectDirs) {
        if (!trackedProjectDirs.has(projectDir)) {
          try {
            const files = fs
              .readdirSync(projectDir)
              .filter((f) => f.endsWith('.jsonl'))
              .map((f) => path.join(projectDir, f));

            for (const file of files) {
              if (knownJsonlFiles.has(file)) continue;
              if (globalDismissedFiles.has(file)) continue;
              if (clearDismissedFiles.has(file)) continue;

              const dismissed = dismissedJsonlFiles.get(file);
              if (dismissed !== undefined) {
                if (now - dismissed < DISMISSED_COOLDOWN_MS) continue;
                dismissedJsonlFiles.delete(file);
              }

              let stat: fs.Stats;
              try {
                stat = fs.statSync(file);
              } catch {
                continue;
              }

              // Only adopt large, recently modified files
              if (stat.size < GLOBAL_SCAN_ACTIVE_MIN_SIZE) continue;
              if (now - stat.mtimeMs > GLOBAL_SCAN_ACTIVE_MAX_AGE_MS) continue;

              knownJsonlFiles.add(file);
              const id = nextAgentIdRef.current++;
              const sessionId = path.basename(file, '.jsonl');

              const agent: AgentState = {
                id,
                sessionId,
                isExternal: true,
                projectDir,
                jsonlFile: file,
                fileOffset: 0,
                lineBuffer: '',
                activeToolIds: new Set(),
                activeToolStatuses: new Map(),
                activeToolNames: new Map(),
                activeSubagentToolIds: new Map(),
                activeSubagentToolNames: new Map(),
                backgroundAgentToolIds: new Set(),
                isWaiting: false,
                permissionSent: false,
                hadToolsInTurn: false,
                lastDataAt: 0,
                linesProcessed: 0,
                seenUnknownRecordTypes: new Set(),
                hookDelivered: false,
              };

              agents.set(id, agent);
              persistAgents();
              dispatch({ type: 'agentCreated', id, isExternal: true });

              // Seed to current end to avoid replaying history
              try {
                const s = fs.statSync(file);
                agent.fileOffset = s.size;
                seededMtimes.set(file, s.mtimeMs);
              } catch {
                /* ignore */
              }

              startFileWatching(
                id,
                file,
                agents,
                fileWatchers,
                pollingTimers,
                waitingTimers,
                permissionTimers,
                dispatch,
              );

              console.log(
                `[Pixel Agents] Global scan adopted: ${sessionId} → agent ${id}`,
              );
            }
          } catch {
            // Ignore per-dir errors
          }
        }
      }
    } catch {
      // Ignore scan errors
    }
  }, EXTERNAL_SCAN_INTERVAL_MS * 2);
}
