/**
 * timerManager.ts — Port of src/timerManager.ts without VS Code dependency.
 * Replaces `webview: vscode.Webview | undefined` with `dispatch: DispatchFn`.
 */

import { PERMISSION_TIMER_DELAY_MS } from '../../server/src/constants.js';
import type { DispatchFn } from './dispatch.js';
import type { AgentState } from './types.js';

export function clearAgentActivity(
  agent: AgentState | undefined,
  agentId: number,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  dispatch: DispatchFn,
): void {
  if (!agent) return;

  if (agent.backgroundAgentToolIds.size > 0) {
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
  } else {
    agent.activeToolIds.clear();
    agent.activeToolStatuses.clear();
    agent.activeToolNames.clear();
    agent.activeSubagentToolIds.clear();
    agent.activeSubagentToolNames.clear();
  }

  agent.isWaiting = false;
  agent.permissionSent = false;
  cancelPermissionTimer(agentId, permissionTimers);
  dispatch({ type: 'agentToolsClear', id: agentId });

  for (const toolId of agent.backgroundAgentToolIds) {
    const status = agent.activeToolStatuses.get(toolId);
    if (status) {
      dispatch({ type: 'agentToolStart', id: agentId, toolId, status });
    }
  }
  dispatch({ type: 'agentStatus', id: agentId, status: 'active' });
}

export function cancelWaitingTimer(
  agentId: number,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
): void {
  const timer = waitingTimers.get(agentId);
  if (timer) {
    clearTimeout(timer);
    waitingTimers.delete(agentId);
  }
}

export function startWaitingTimer(
  agentId: number,
  delayMs: number,
  agents: Map<number, AgentState>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  dispatch: DispatchFn,
): void {
  cancelWaitingTimer(agentId, waitingTimers);
  const timer = setTimeout(() => {
    waitingTimers.delete(agentId);
    const agent = agents.get(agentId);
    if (agent) {
      agent.isWaiting = true;
    }
    dispatch({ type: 'agentStatus', id: agentId, status: 'waiting' });
  }, delayMs);
  waitingTimers.set(agentId, timer);
}

export function cancelPermissionTimer(
  agentId: number,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
): void {
  const timer = permissionTimers.get(agentId);
  if (timer) {
    clearTimeout(timer);
    permissionTimers.delete(agentId);
  }
}

export function startPermissionTimer(
  agentId: number,
  agents: Map<number, AgentState>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionExemptTools: Set<string>,
  dispatch: DispatchFn,
): void {
  cancelPermissionTimer(agentId, permissionTimers);
  const timer = setTimeout(() => {
    permissionTimers.delete(agentId);
    const agent = agents.get(agentId);
    if (!agent) return;

    let hasNonExempt = false;
    for (const toolId of agent.activeToolIds) {
      const toolName = agent.activeToolNames.get(toolId);
      if (!permissionExemptTools.has(toolName || '')) {
        hasNonExempt = true;
        break;
      }
    }

    const stuckSubagentParentToolIds: string[] = [];
    for (const [parentToolId, subToolNames] of agent.activeSubagentToolNames) {
      for (const [, toolName] of subToolNames) {
        if (!permissionExemptTools.has(toolName)) {
          stuckSubagentParentToolIds.push(parentToolId);
          hasNonExempt = true;
          break;
        }
      }
    }

    if (hasNonExempt) {
      agent.permissionSent = true;
      console.log(`[Pixel Agents] Agent ${agentId}: possible permission wait detected`);
      dispatch({ type: 'agentToolPermission', id: agentId });
      for (const parentToolId of stuckSubagentParentToolIds) {
        dispatch({ type: 'subagentToolPermission', id: agentId, parentToolId });
      }
    }
  }, PERMISSION_TIMER_DELAY_MS);
  permissionTimers.set(agentId, timer);
}
