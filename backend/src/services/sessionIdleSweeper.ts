import * as db from '../utils/db';

export interface SessionWorkflowCloser {
  closeSessionIfRunning(sessionId: string, cutoffMs: number): Promise<boolean>;
}

export interface SweepIdleSessionsOptions {
  idleTimeoutMs: number;
  batchSize?: number;
  nowMs?: number;
}

export interface SessionIdleSweeperOptions {
  idleTimeoutMs: number;
  sweepIntervalMs: number;
  batchSize?: number;
}

const DEFAULT_BATCH_SIZE = 100;

export async function sweepIdleSessions(
  workflowClient: SessionWorkflowCloser,
  options: SweepIdleSessionsOptions
): Promise<number> {
  const nowMs = options.nowMs ?? Date.now();
  const cutoffMs = nowMs - options.idleTimeoutMs;
  const sessions = db.listIdleOpenSessions(cutoffMs, options.batchSize ?? DEFAULT_BATCH_SIZE);
  let closedCount = 0;

  for (const session of sessions) {
    try {
      await workflowClient.closeSessionIfRunning(session.session_id, cutoffMs);
      if (db.markSessionClosed(session.session_id, nowMs, cutoffMs)) {
        closedCount += 1;
      }
    } catch (error) {
      console.error(`[sessionIdleSweeper] Failed to close idle session ${session.session_id}:`, error);
    }
  }

  return closedCount;
}

export function startSessionIdleSweeper(
  workflowClient: SessionWorkflowCloser,
  options: SessionIdleSweeperOptions
): NodeJS.Timeout {
  let running = false;

  const run = () => {
    if (running) return;
    running = true;

    sweepIdleSessions(workflowClient, options)
      .then((closedCount) => {
        if (closedCount > 0) {
          console.log(`[sessionIdleSweeper] Closed ${closedCount} idle session(s)`);
        }
      })
      .catch((error) => {
        console.error('[sessionIdleSweeper] Sweep failed:', error);
      })
      .finally(() => {
        running = false;
      });
  };

  const timer = setInterval(run, options.sweepIntervalMs);
  timer.unref();
  run();
  return timer;
}
