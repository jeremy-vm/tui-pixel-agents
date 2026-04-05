// TUI-specific agent state — mirrors src/types.ts but without VS Code Terminal reference.

export interface AgentState {
  id: number;
  sessionId: string;
  /** PID of the spawned Claude process, if we launched it */
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
  activeSubagentToolIds: Map<string, Set<string>>;
  activeSubagentToolNames: Map<string, Map<string, string>>;
  backgroundAgentToolIds: Set<string>;
  isWaiting: boolean;
  permissionSent: boolean;
  hadToolsInTurn: boolean;
  folderName?: string;
  lastDataAt: number;
  linesProcessed: number;
  seenUnknownRecordTypes: Set<string>;
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
