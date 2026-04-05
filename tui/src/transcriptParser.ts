/**
 * transcriptParser.ts — Port of src/transcriptParser.ts without VS Code dependency.
 * Replaces `webview: vscode.Webview | undefined` with `dispatch: DispatchFn`.
 */

import * as path from 'path';

import {
  BASH_COMMAND_DISPLAY_MAX_LENGTH,
  TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
  TEXT_IDLE_DELAY_MS,
  TOOL_DONE_DELAY_MS,
} from '../../server/src/constants.js';
import type { DispatchFn } from './dispatch.js';
import {
  cancelPermissionTimer,
  cancelWaitingTimer,
  clearAgentActivity,
  startPermissionTimer,
  startWaitingTimer,
} from './timerManager.js';
import type { AgentState } from './types.js';

export const PERMISSION_EXEMPT_TOOLS = new Set(['Task', 'Agent', 'AskUserQuestion']);

export function formatToolStatus(toolName: string, input: Record<string, unknown>): string {
  const base = (p: unknown) => (typeof p === 'string' ? path.basename(p) : '');
  switch (toolName) {
    case 'Read':
      return `Reading ${base(input.file_path)}`;
    case 'Edit':
      return `Editing ${base(input.file_path)}`;
    case 'Write':
      return `Writing ${base(input.file_path)}`;
    case 'Bash': {
      const cmd = (input.command as string) || '';
      return `Running: ${cmd.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH) + '\u2026' : cmd}`;
    }
    case 'Glob':
      return 'Searching files';
    case 'Grep':
      return 'Searching code';
    case 'WebFetch':
      return 'Fetching web content';
    case 'WebSearch':
      return 'Searching the web';
    case 'Task':
    case 'Agent': {
      const desc = typeof input.description === 'string' ? input.description : '';
      return desc
        ? `Subtask: ${desc.length > TASK_DESCRIPTION_DISPLAY_MAX_LENGTH ? desc.slice(0, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH) + '\u2026' : desc}`
        : 'Running subtask';
    }
    case 'AskUserQuestion':
      return 'Waiting for your answer';
    case 'EnterPlanMode':
      return 'Planning';
    case 'NotebookEdit':
      return `Editing notebook`;
    default:
      return `Using ${toolName}`;
  }
}

export function processTranscriptLine(
  agentId: number,
  line: string,
  agents: Map<number, AgentState>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  dispatch: DispatchFn,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;
  agent.lastDataAt = Date.now();
  agent.linesProcessed++;
  try {
    const record = JSON.parse(line) as Record<string, unknown>;

    const assistantContent =
      (record.message as Record<string, unknown> | undefined)?.content ?? record.content;

    if (record.type === 'assistant' && Array.isArray(assistantContent)) {
      const blocks = assistantContent as Array<{
        type: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      }>;
      const hasToolUse = blocks.some((b) => b.type === 'tool_use');

      if (hasToolUse) {
        cancelWaitingTimer(agentId, waitingTimers);
        agent.isWaiting = false;
        agent.hadToolsInTurn = true;
        dispatch({ type: 'agentStatus', id: agentId, status: 'active' });
        let hasNonExemptTool = false;
        for (const block of blocks) {
          if (block.type === 'tool_use' && block.id) {
            const toolName = block.name || '';
            const status = formatToolStatus(toolName, block.input || {});
            agent.activeToolIds.add(block.id);
            agent.activeToolStatuses.set(block.id, status);
            agent.activeToolNames.set(block.id, toolName);
            if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
              hasNonExemptTool = true;
            }
            dispatch({
              type: 'agentToolStart',
              id: agentId,
              toolId: block.id,
              status,
              toolName,
              permissionActive: agent.permissionSent,
            });
          }
        }
        if (hasNonExemptTool && !agent.hookDelivered) {
          startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, dispatch);
        }
      } else if (blocks.some((b) => b.type === 'text') && !agent.hadToolsInTurn) {
        if (!agent.hookDelivered) {
          startWaitingTimer(agentId, TEXT_IDLE_DELAY_MS, agents, waitingTimers, dispatch);
        }
      }
    } else if (record.type === 'assistant' && typeof assistantContent === 'string') {
      if (!agent.hadToolsInTurn && !agent.hookDelivered) {
        startWaitingTimer(agentId, TEXT_IDLE_DELAY_MS, agents, waitingTimers, dispatch);
      }
    } else if (record.type === 'progress') {
      processProgressRecord(agentId, record, agents, permissionTimers, dispatch);
    } else if (record.type === 'user') {
      const content =
        (record.message as Record<string, unknown> | undefined)?.content ?? record.content;
      if (Array.isArray(content)) {
        const blocks = content as Array<{ type: string; tool_use_id?: string }>;
        const hasToolResult = blocks.some((b) => b.type === 'tool_result');
        if (hasToolResult) {
          for (const block of blocks) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              const completedToolId = block.tool_use_id;
              const completedToolName = agent.activeToolNames.get(completedToolId);

              if (
                (completedToolName === 'Task' || completedToolName === 'Agent') &&
                isAsyncAgentResult(block as Record<string, unknown>)
              ) {
                agent.backgroundAgentToolIds.add(completedToolId);
                continue;
              }

              if (completedToolName === 'Task' || completedToolName === 'Agent') {
                agent.activeSubagentToolIds.delete(completedToolId);
                agent.activeSubagentToolNames.delete(completedToolId);
                dispatch({ type: 'subagentClear', id: agentId, parentToolId: completedToolId });
              }
              agent.activeToolIds.delete(completedToolId);
              agent.activeToolStatuses.delete(completedToolId);
              agent.activeToolNames.delete(completedToolId);
              const toolId = completedToolId;
              setTimeout(() => {
                dispatch({ type: 'agentToolDone', id: agentId, toolId });
              }, TOOL_DONE_DELAY_MS);
            }
          }
          if (agent.activeToolIds.size === 0) {
            agent.hadToolsInTurn = false;
          }
        } else {
          cancelWaitingTimer(agentId, waitingTimers);
          clearAgentActivity(agent, agentId, permissionTimers, dispatch);
          agent.hadToolsInTurn = false;
        }
      } else if (typeof content === 'string' && content.trim()) {
        cancelWaitingTimer(agentId, waitingTimers);
        clearAgentActivity(agent, agentId, permissionTimers, dispatch);
        agent.hadToolsInTurn = false;
      }
    } else if (record.type === 'queue-operation' && record.operation === 'enqueue') {
      const content = record.content as string | undefined;
      if (content) {
        const toolIdMatch = content.match(/<tool-use-id>(.*?)<\/tool-use-id>/);
        if (toolIdMatch) {
          const completedToolId = toolIdMatch[1];
          if (agent.backgroundAgentToolIds.has(completedToolId)) {
            agent.backgroundAgentToolIds.delete(completedToolId);
            agent.activeSubagentToolIds.delete(completedToolId);
            agent.activeSubagentToolNames.delete(completedToolId);
            dispatch({ type: 'subagentClear', id: agentId, parentToolId: completedToolId });
            agent.activeToolIds.delete(completedToolId);
            agent.activeToolStatuses.delete(completedToolId);
            agent.activeToolNames.delete(completedToolId);
            const toolId = completedToolId;
            setTimeout(() => {
              dispatch({ type: 'agentToolDone', id: agentId, toolId });
            }, TOOL_DONE_DELAY_MS);
          }
        }
      }
    } else if (record.type === 'system' && record.subtype === 'turn_duration') {
      cancelWaitingTimer(agentId, waitingTimers);
      cancelPermissionTimer(agentId, permissionTimers);

      const hasForegroundTools = agent.activeToolIds.size > agent.backgroundAgentToolIds.size;
      if (hasForegroundTools) {
        for (const toolId of agent.activeToolIds) {
          if (agent.backgroundAgentToolIds.has(toolId)) continue;
          agent.activeToolIds.delete(toolId);
          agent.activeToolStatuses.delete(toolId);
          const toolName = agent.activeToolNames.get(toolId);
          agent.activeToolNames.delete(toolId);
          if (toolName === 'Task' || toolName === 'Agent') {
            agent.activeSubagentToolIds.delete(toolId);
            agent.activeSubagentToolNames.delete(toolId);
          }
        }
        if (!agent.hookDelivered) {
          dispatch({ type: 'agentToolsClear', id: agentId });
        }
        for (const toolId of agent.backgroundAgentToolIds) {
          const status = agent.activeToolStatuses.get(toolId);
          if (status) {
            dispatch({ type: 'agentToolStart', id: agentId, toolId, status });
          }
        }
      } else if (agent.activeToolIds.size > 0 && agent.backgroundAgentToolIds.size === 0) {
        agent.activeToolIds.clear();
        agent.activeToolStatuses.clear();
        agent.activeToolNames.clear();
        agent.activeSubagentToolIds.clear();
        agent.activeSubagentToolNames.clear();
        if (!agent.hookDelivered) {
          dispatch({ type: 'agentToolsClear', id: agentId });
        }
      }

      agent.isWaiting = true;
      agent.permissionSent = false;
      agent.hadToolsInTurn = false;
      if (!agent.hookDelivered) {
        dispatch({ type: 'agentStatus', id: agentId, status: 'waiting' });
      }
    } else if (record.type && !agent.seenUnknownRecordTypes.has(record.type as string)) {
      const knownSkippableTypes = new Set([
        'file-history-snapshot',
        'system',
        'queue-operation',
      ]);
      if (!knownSkippableTypes.has(record.type as string)) {
        agent.seenUnknownRecordTypes.add(record.type as string);
        console.log(
          `[Pixel Agents] Agent ${agentId}: unrecognized record type '${record.type as string}'.`,
        );
      }
    }
  } catch {
    // Ignore malformed lines
  }
}

function processProgressRecord(
  agentId: number,
  record: Record<string, unknown>,
  agents: Map<number, AgentState>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  dispatch: DispatchFn,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;

  const parentToolId = record.parentToolUseID as string | undefined;
  if (!parentToolId) return;

  const data = record.data as Record<string, unknown> | undefined;
  if (!data) return;

  const dataType = data.type as string | undefined;
  if (dataType === 'bash_progress' || dataType === 'mcp_progress') {
    if (agent.activeToolIds.has(parentToolId) && !agent.hookDelivered) {
      startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, dispatch);
    }
    return;
  }

  const parentToolName = agent.activeToolNames.get(parentToolId);
  if (parentToolName !== 'Task' && parentToolName !== 'Agent') return;

  const msg = data.message as Record<string, unknown> | undefined;
  if (!msg) return;

  const msgType = msg.type as string;
  const innerMsg = msg.message as Record<string, unknown> | undefined;
  const content = innerMsg?.content;
  if (!Array.isArray(content)) return;

  if (msgType === 'assistant') {
    let hasNonExemptSubTool = false;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'tool_use' && block.id) {
        const toolName = (block.name as string) || '';
        const status = formatToolStatus(toolName, (block.input as Record<string, unknown>) || {});

        let subTools = agent.activeSubagentToolIds.get(parentToolId);
        if (!subTools) {
          subTools = new Set();
          agent.activeSubagentToolIds.set(parentToolId, subTools);
        }
        subTools.add(block.id as string);

        let subNames = agent.activeSubagentToolNames.get(parentToolId);
        if (!subNames) {
          subNames = new Map();
          agent.activeSubagentToolNames.set(parentToolId, subNames);
        }
        subNames.set(block.id as string, toolName);

        if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
          hasNonExemptSubTool = true;
        }

        dispatch({
          type: 'subagentToolStart',
          id: agentId,
          parentToolId,
          toolId: block.id as string,
          status,
        });
      }
    }
    if (hasNonExemptSubTool && !agent.hookDelivered) {
      startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, dispatch);
    }
  } else if (msgType === 'user') {
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        const subTools = agent.activeSubagentToolIds.get(parentToolId);
        if (subTools) subTools.delete(block.tool_use_id as string);
        const subNames = agent.activeSubagentToolNames.get(parentToolId);
        if (subNames) subNames.delete(block.tool_use_id as string);

        const toolId = block.tool_use_id as string;
        setTimeout(() => {
          dispatch({ type: 'subagentToolDone', id: agentId, parentToolId, toolId });
        }, 300);
      }
    }
    let stillHasNonExempt = false;
    for (const [, subNames] of agent.activeSubagentToolNames) {
      for (const [, toolName] of subNames) {
        if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
          stillHasNonExempt = true;
          break;
        }
      }
      if (stillHasNonExempt) break;
    }
    if (stillHasNonExempt && !agent.hookDelivered) {
      startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, dispatch);
    }
  }
}

function isAsyncAgentResult(block: Record<string, unknown>): boolean {
  const content = block.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Record<string, unknown>).text === 'string' &&
        ((item as Record<string, unknown>).text as string).startsWith(
          'Async agent launched successfully.',
        )
      ) {
        return true;
      }
    }
  } else if (typeof content === 'string') {
    return content.startsWith('Async agent launched successfully.');
  }
  return false;
}
