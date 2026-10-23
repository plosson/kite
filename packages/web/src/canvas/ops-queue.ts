/**
 * Sends canvas operations, coalesced, and retries once on a version conflict.
 *
 * Kept apart from the React Flow view so it can be tested without a DOM: the
 * view only says "this node moved" or "this text changed", and this decides
 * when to send and what to do when somebody else (usually the owner's own
 * agent) wrote in between.
 */
import { ApiError } from '../api.js';

export type QueuedOp =
  | { op: 'move'; id: string; x: number; y: number }
  | { op: 'update'; id: string; set: { text?: string; label?: string } };

export interface OpsResult {
  version: number;
}

export interface OpsQueueOptions {
  /** POST /api/artifacts/:id/canvas/ops. */
  send: (baseVersion: number, ops: QueuedOp[]) => Promise<OpsResult>;
  /** Re-reads the canvas; returns its version. Called after a 409 and after every save. */
  reload: () => Promise<number>;
  getVersion: () => number;
  onSaved?: (version: number) => void;
  onError?: (error: unknown) => void;
  delayMs?: number;
}

/** Later edits to the same node replace earlier ones: a drag is one move, not fifty. */
function keyOf(op: QueuedOp): string {
  return `${op.op}:${op.id}`;
}

export function createOpsQueue(options: OpsQueueOptions) {
  const delay = options.delayMs ?? 400;
  let pending = new Map<string, QueuedOp>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;

  async function sendOnce(ops: QueuedOp[]): Promise<void> {
    try {
      const result = await options.send(options.getVersion(), ops);
      options.onSaved?.(result.version);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 409) throw error;
      // Somebody wrote in between. The ops are absolute (move to x,y; set text),
      // so replaying them on the newer version is what the owner meant.
      await options.reload();
      const result = await options.send(options.getVersion(), ops);
      options.onSaved?.(result.version);
    }
    await options.reload();
  }

  async function flush(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = null;
    if (inFlight) await inFlight;
    if (pending.size === 0) return;
    const ops = [...pending.values()];
    pending = new Map();
    inFlight = sendOnce(ops)
      .catch((error: unknown) => options.onError?.(error))
      .finally(() => {
        inFlight = null;
      });
    await inFlight;
  }

  return {
    push(op: QueuedOp) {
      pending.set(keyOf(op), op);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void flush(), delay);
    },
    flush,
    get size() {
      return pending.size;
    },
  };
}
