/**
 * gameLoop.ts — Node.js setInterval-based game loop replacing requestAnimationFrame.
 */

import { MAX_DELTA_TIME_SEC } from '../../webview-ui/src/constants.js';

export interface GameLoopCallbacks {
  /** Called with delta time in seconds each tick */
  update: (dt: number) => void;
  /** Called after update to render the current state */
  render: () => void;
}

/**
 * Start the game loop at the given FPS (default 30).
 * Returns a stop function.
 */
export function startGameLoop(callbacks: GameLoopCallbacks, fps = 30): () => void {
  let lastTime = Date.now();
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    const now = Date.now();
    const dt = Math.min((now - lastTime) / 1000, MAX_DELTA_TIME_SEC);
    lastTime = now;
    callbacks.update(dt);
    callbacks.render();
  };

  const interval = setInterval(tick, Math.round(1000 / fps));

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}
