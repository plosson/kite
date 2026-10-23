/**
 * Sends canvas operations in order, coalesced, and retries once on a version
 * conflict.
 *
 * Kept apart from the React Flow view so it can be tested without a DOM: the
 * view applies an action to its own copy at once and hands the operations here;
 * this decides when to send and what to do when somebody else (usually the
 * owner's own agent) wrote in between.
 *
 * Order matters (delete, then an undo's add of the same id, then delete again),
 * so pending operations are a list, not a map. Only a repeat of the same kind
 * on the same thing is folded into the earlier one, and only when nothing else
 * about that thing happened in between: a drag is one move, not fifty.
 */
import type { CanvasOp } from '@open-artifact/shared';
import { ApiError } from '../api.js';

export type QueuedOp = CanvasOp;

export interface OpsResult {
  version: number;
}

export interface OpsQueueOptions {
  /** POST /api/artifacts/:id/canvas/ops. */
  send: (baseVersion: number, ops: QueuedOp[]) => Promise<OpsResult>;
  /**
   * Re-reads the canvas, replaying what is unsaved; returns its version. Called
   * after a 409. Not after a save that went through: that one was applied to
   * exactly the version the owner was looking at, so their copy already is the
   * server's, and anybody else's change arrives over the live stream.
   */
  reload: () => Promise<number>;
  getVersion: () => number;
  onSaved?: (version: number) => void;
  onError?: (error: unknown, ops: QueuedOp[]) => void;
  delayMs?: number;
}

function subjects(op: QueuedOp): string[] {
  switch (op.op) {
    case 'add':
      return [op.id ?? op.tempId ?? '', ...(op.in ? [op.in] : []), ...(op.near ? [op.near] : [])];
    case 'connect':
      return [op.id ?? op.tempId ?? '', op.from, op.to];
    default:
      return [op.id];
  }
}

/** Folds `next` into `previous` when it simply supersedes it, else null. */
function fold(previous: QueuedOp, next: QueuedOp): QueuedOp | null {
  if (previous.op !== next.op) return null;
  if (next.op === 'move' && previous.op === 'move' && previous.id === next.id) return next;
  if (next.op === 'resize' && previous.op === 'resize' && previous.id === next.id) return next;
  if (next.op === 'update' && previous.op === 'update' && previous.id === next.id && !previous.unset && !next.unset) {
    const set = { ...(previous.set ?? {}), ...(next.set ?? {}) };
    return { op: 'update', id: next.id, set } as QueuedOp;
  }
  return null;
}

export function createOpsQueue(options: OpsQueueOptions) {
  const delay = options.delayMs ?? 400;
  let pending: QueuedOp[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let sending: QueuedOp[] = [];

  async function sendOnce(ops: QueuedOp[]): Promise<void> {
    try {
      const result = await options.send(options.getVersion(), ops);
      options.onSaved?.(result.version);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 409) throw error;
      // Somebody wrote in between. The ops name ids and absolute positions,
      // so replaying them on the newer version is what the owner meant.
      await options.reload();
      const result = await options.send(options.getVersion(), ops);
      options.onSaved?.(result.version);
    }
  }

  function push(op: QueuedOp) {
    const ids = subjects(op);
    for (let i = pending.length - 1; i >= 0; i--) {
      const earlier = pending[i]!;
      const folded = fold(earlier, op);
      if (folded) {
        pending[i] = folded;
        schedule();
        return;
      }
      // Something else happened to the same thing: keep both, in order.
      if (subjects(earlier).some((s) => ids.includes(s))) break;
    }
    pending.push(op);
    schedule();
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void flush(), delay);
  }

  async function flush(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = null;
    while (inFlight) await inFlight;
    if (pending.length === 0) return;
    const ops = pending;
    pending = [];
    sending = ops;
    inFlight = sendOnce(ops)
      .catch((error: unknown) => options.onError?.(error, ops))
      .finally(() => {
        inFlight = null;
        sending = [];
      });
    await inFlight;
  }

  return {
    push,
    pushAll(ops: QueuedOp[]) {
      for (const op of ops) push(op);
    },
    flush,
    /** What the server has not confirmed yet, oldest first: in flight, then waiting. */
    unsaved(): QueuedOp[] {
      return [...sending, ...pending];
    },
    get size() {
      return pending.length;
    },
    get busy() {
      return inFlight !== null || pending.length > 0;
    },
  };
}
