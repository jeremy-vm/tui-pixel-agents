/** Minimal interface for sending messages to a UI layer (replaces vscode.Webview). */
export interface MessageSender {
  postMessage(msg: Record<string, unknown>): void;
}

export interface AgentState {
  id: number;
  sessionId: string;
  /** PID of the spawned process, if applicable */
  childPid?: number;
  /** Whether this agent was auto-detected from an external JSONL file */
  isExternal: boolean;
  projectDir: string;
  jsonlFile: string;
  fileOffset: number;
  lineBuffer: string;
  activeToolIds: Set<string>;
  activeToolStatuses: Map<string, string>;
  activeToolNames: Map<string, string>;
  activeSubagentToolIds: Map<string, Set<string>>; // parentToolId → active sub-tool IDs
  activeSubagentToolNames: Map<string, Map<string, string>>; // parentToolId → (subToolId → toolName)
  backgroundAgentToolIds: Set<string>; // tool IDs for run_in_background Agent calls
  isWaiting: boolean;
  permissionSent: boolean;
  hadToolsInTurn: boolean;
  /** Workspace folder name (only set for multi-root workspaces) */
  folderName?: string;
  /** Timestamp of last JSONL data received (ms since epoch) */
  lastDataAt: number;
  /** Total JSONL lines processed for this agent */
  linesProcessed: number;
  /** Set of record.type values we've already warned about (prevents log spam) */
  seenUnknownRecordTypes: Set<string>;
  /** Whether a hook event has been delivered for this agent (suppresses heuristic timers) */
  hookDelivered: boolean;
}

export interface PersistedAgent {
  id: number;
  sessionId?: string;
  jsonlFile: string;
  projectDir: string;
  folderName?: string;
  isExternal?: boolean;
}
