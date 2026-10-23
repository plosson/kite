import { describe, it, expect, vi } from 'vitest';
import { createOpsQueue, type QueuedOp } from '../src/canvas/ops-queue.js';
import { ApiError } from '../src/api.js';

function harness(failFirstWith409 = false) {
  let version = 1;
  const sent: { baseVersion: number; ops: QueuedOp[] }[] = [];
  let conflicts = failFirstWith409 ? 1 : 0;
  const queue = createOpsQueue({
    delayMs: 5,
    getVersion: () => version,
    reload: async () => version,
    send: async (baseVersion, ops) => {
      sent.push({ baseVersion, ops });
      if (conflicts > 0) {
        conflicts -= 1;
        version += 1; // somebody else wrote
        throw new ApiError(409, { code: 'version_conflict', message: 'changed' });
      }
      version += 1;
      return { version };
    },
  });
  return { queue, sent, version: () => version };
}

describe('the canvas save queue', () => {
  it('coalesces a drag into one move per node, in one batch', async () => {
    const { queue, sent } = harness();
    queue.push({ op: 'move', id: 'a', x: 1, y: 1 });
    queue.push({ op: 'move', id: 'a', x: 5, y: 5 });
    queue.push({ op: 'move', id: 'b', x: 2, y: 2 });
    await queue.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.ops).toEqual([
      { op: 'move', id: 'a', x: 5, y: 5 },
      { op: 'move', id: 'b', x: 2, y: 2 },
    ]);
  });

  it('re-reads and retries once on a version conflict', async () => {
    const { queue, sent, version } = harness(true);
    queue.push({ op: 'update', id: 'a', set: { text: 'hi' } });
    await queue.flush();
    expect(sent.map((s) => s.baseVersion)).toEqual([1, 2]);
    expect(version()).toBe(3);
  });

  it('reports a second conflict instead of looping', async () => {
    const onError = vi.fn();
    const queue = createOpsQueue({
      delayMs: 5,
      getVersion: () => 1,
      reload: async () => 1,
      send: async () => {
        throw new ApiError(409, { code: 'version_conflict', message: 'changed' });
      },
      onError,
    });
    queue.push({ op: 'move', id: 'a', x: 0, y: 0 });
    await queue.flush();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('sends on its own after the delay', async () => {
    const { queue, sent } = harness();
    queue.push({ op: 'move', id: 'a', x: 1, y: 1 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sent).toHaveLength(1);
  });
});
