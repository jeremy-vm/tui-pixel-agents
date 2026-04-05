/**
 * agentManager.ts — Port of src/agentManager.ts without VS Code dependencies.
 *
 * Key changes:
 * - Removed vscode.workspace / vscode.window imports
 * - launchNewProcess() spawns Claude via processManager instead of a VS Code terminal
 * - persistAgents() writes to ~/.pixel-agents/tui-agents.json
 * - restoreAgents() reads from same file (no terminal matching)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { JSONL_POLL_INTERVAL_MS } from '../../server/src/constants.js';
import { LAYOUT_FILE_DIR,TUI_AGENTS_FILE_NAME } from './constants.js';
import type { DispatchFn } from './dispatch.js';
import {
  ensureProjectScan,
  readNewLines,
  startFileWatching,
} from './fileWatcher.js';
import { cancelPermissionTimer, cancelWaitingTimer } from './timerManager.js';
import type { AgentState, PersistedAgent } from './types.js';

// ── Project dir resolution ───────────────────────────────────

export function getProjectDirPath(cwd?: string): string {
  const workspacePath = cwd ?? os.homedir();
  const dirName = workspacePath.replace(/[^a-zA-Z0-9-]/g, '-');
  const projectDir = path.join(os.homedir(), '.claude', 'projects', dirName);

  if (!fs.existsSync(projectDir)) {
    const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
    try {
      if (fs.existsSync(projectsRoot)) {
        const candidates = fs.readdirSync(projectsRoot);
        const lowerDirName = dirName.toLowerCase();
        const match = candidates.find((c) => c.toLowerCase() === lowerDirName);
        if (match && match !== dirName) {
          return path.join(projectsRoot, match);
        }
      }
    } catch {
      // Ignore scan errors
    }
  }
  return projectDir;
}

// ── Agent persistence ────────────────────────────────────────

function getAgentsFilePath(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, TUI_AGENTS_FILE_NAME);
}

export function persistAgentsToDisk(agents: Map<number, AgentState>): void {
  const filePath = getAgentsFilePath();
  const dir = path.dirname(filePath);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const persisted: PersistedAgent[] = [];
    for (const agent of agents.values()) {
      persisted.push({
        id: agent.id,
        sessionId: agent.sessionId,
        jsonlFile: agent.jsonlFile,
        projectDir: agent.projectDir,
        folderName: agent.folderName,
        isExternal: agent.isExternal || undefined,
      });
    }
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(persisted, null, 2), 'utf-8');
    fs.renameSync(tmp, filePath);
  } catch {
    // Ignore persistence errors (non-critical)
  }
}

// ── Launch ───────────────────────────────────────────────────

export async function launchNewProcess(
  nextAgentIdRef: { current: number },
  agents: Map<number, AgentState>,
  activeAgentIdRef: { current: number | null },
  knownJsonlFiles: Set<string>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
  projectScanTimerRef: { current: ReturnType<typeof setInterval> | null },
  dispatch: DispatchFn,
  persistAgents: () => void,
  workspacePath?: string,
  bypassPermissions?: boolean,
): Promise<{ command: string; hint: string }> {
  const { launchClaudeSession } = await import('./processManager.js');

  const cwd = workspacePath ?? os.homedir();
  const sessionId = crypto.randomUUID();
  const projectDir = getProjectDirPath(cwd);
  const expectedFile = path.join(projectDir, `${sessionId}.jsonl`);
  knownJsonlFiles.add(expectedFile);

  const id = nextAgentIdRef.current++;
  const agent: AgentState = {
    id,
    sessionId,
    isExternal: false,
    projectDir,
    jsonlFile: expectedFile,
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
  activeAgentIdRef.current = id;
  persistAgents();
  dispatch({ type: 'agentCreated', id });

  // Attempt to launch Claude in a new terminal window/pane
  const result = await launchClaudeSession(sessionId, cwd, bypassPermissions ?? false);

  ensureProjectScan(
    projectDir,
    knownJsonlFiles,
    projectScanTimerRef,
    activeAgentIdRef,
    nextAgentIdRef,
    agents,
    fileWatchers,
    pollingTimers,
    waitingTimers,
    permissionTimers,
    dispatch,
    persistAgents,
  );

  // Poll for the JSONL file to appear (up to ~60 seconds)
  let pollCount = 0;
  const pollTimer = setInterval(() => {
    pollCount++;
    try {
      if (fs.existsSync(agent.jsonlFile)) {
        clearInterval(pollTimer);
        jsonlPollTimers.delete(id);
        startFileWatching(
          id,
          agent.jsonlFile,
          agents,
          fileWatchers,
          pollingTimers,
          waitingTimers,
          permissionTimers,
          dispatch,
        );
        readNewLines(id, agents, waitingTimers, permissionTimers, dispatch);
      }
    } catch {
      /* ignore */
    }
  }, JSONL_POLL_INTERVAL_MS);
  jsonlPollTimers.set(id, pollTimer);

  return { command: result.command, hint: result.hint };
}

// ── Remove ───────────────────────────────────────────────────

export function removeAgent(
  agentId: number,
  agents: Map<number, AgentState>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
  persistAgents: () => void,
): void {
  if (!agents.get(agentId)) return;

  const jpTimer = jsonlPollTimers.get(agentId);
  if (jpTimer) clearInterval(jpTimer);
  jsonlPollTimers.delete(agentId);

  fileWatchers.get(agentId)?.close();
  fileWatchers.delete(agentId);

  const pt = pollingTimers.get(agentId);
  if (pt) clearInterval(pt);
  pollingTimers.delete(agentId);

  cancelWaitingTimer(agentId, waitingTimers);
  cancelPermissionTimer(agentId, permissionTimers);

  agents.delete(agentId);
  persistAgents();
}

// ── Restore ──────────────────────────────────────────────────

export function restoreAgents(
  nextAgentIdRef: { current: number },
  agents: Map<number, AgentState>,
  knownJsonlFiles: Set<string>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
  projectScanTimerRef: { current: ReturnType<typeof setInterval> | null },
  activeAgentIdRef: { current: number | null },
  dispatch: DispatchFn,
  doPersist: () => void,
): void {
  const filePath = getAgentsFilePath();
  let persisted: PersistedAgent[] = [];
  try {
    if (fs.existsSync(filePath)) {
      persisted = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as PersistedAgent[];
    }
  } catch {
    return;
  }

  if (persisted.length === 0) return;

  let maxId = 0;
  let restoredProjectDir: string | null = null;

  for (const p of persisted) {
    if (agents.has(p.id)) {
      knownJsonlFiles.add(p.jsonlFile);
      continue;
    }

    // Skip if JSONL file no longer exists
    try {
      if (!fs.existsSync(p.jsonlFile)) continue;
    } catch {
      continue;
    }

    const agent: AgentState = {
      id: p.id,
      sessionId: p.sessionId ?? path.basename(p.jsonlFile, '.jsonl'),
      isExternal: p.isExternal ?? false,
      projectDir: p.projectDir,
      jsonlFile: p.jsonlFile,
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
      folderName: p.folderName,
      hookDelivered: false,
    };

    agents.set(p.id, agent);
    knownJsonlFiles.add(p.jsonlFile);
    dispatch({ type: 'agentCreated', id: p.id, skipSpawnEffect: true });

    if (p.id > maxId) maxId = p.id;
    restoredProjectDir = p.projectDir;

    // Start watching (seek to end to avoid replaying history)
    try {
      const stat = fs.statSync(p.jsonlFile);
      agent.fileOffset = stat.size;
      startFileWatching(
        p.id,
        p.jsonlFile,
        agents,
        fileWatchers,
        pollingTimers,
        waitingTimers,
        permissionTimers,
        dispatch,
      );
    } catch {
      /* ignore */
    }
  }

  if (maxId >= nextAgentIdRef.current) {
    nextAgentIdRef.current = maxId + 1;
  }

  doPersist();

  if (restoredProjectDir) {
    ensureProjectScan(
      restoredProjectDir,
      knownJsonlFiles,
      projectScanTimerRef,
      activeAgentIdRef,
      nextAgentIdRef,
      agents,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      dispatch,
      doPersist,
    );
  }
}

// ── Send existing agents to renderer ─────────────────────────

export function sendExistingAgents(
  agents: Map<number, AgentState>,
  dispatch: DispatchFn,
): void {
  const agentIds: number[] = [];
  for (const id of agents.keys()) agentIds.push(id);
  agentIds.sort((a, b) => a - b);
  dispatch({ type: 'existingAgents', agents: agentIds });
}

export function sendCurrentAgentStatuses(
  agents: Map<number, AgentState>,
  dispatch: DispatchFn,
): void {
  for (const [agentId, agent] of agents) {
    for (const [toolId, status] of agent.activeToolStatuses) {
      const toolName = agent.activeToolNames.get(toolId) ?? '';
      dispatch({ type: 'agentToolStart', id: agentId, toolId, status, toolName });
    }
    if (agent.isWaiting) {
      dispatch({ type: 'agentStatus', id: agentId, status: 'waiting' });
    }
  }
}
