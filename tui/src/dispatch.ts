/**
 * dispatch.ts — Simple message bus replacing the VS Code postMessage/onDidReceiveMessage bridge.
 *
 * Since the TUI is a single Node.js process, all communication is direct function calls.
 * A dispatch callback replaces `webview.postMessage()` throughout the ported modules.
 */

export type MessagePayload = Record<string, unknown>;

/** Drop-in replacement for `webview?.postMessage(msg)` */
export type DispatchFn = (msg: MessagePayload) => void;

/** Mutable ref used to pass dispatch through legacy function signatures */
export interface DispatchRef {
  current: DispatchFn | null;
}

/** No-op dispatch (used before the app is initialized) */
export const noop: DispatchFn = () => {};
