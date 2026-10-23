import { describe, it, expect } from 'vitest';
import {
  applyCanvasOps,
  canvasTitle,
  CanvasError,
  checkCanvas,
  isSafeCanvasUrl,
  parseCanvas,
  serialiseCanvas,
  strictCanvas,
  type CanvasDocument,
} from '../src/canvas.js';

const board = (): CanvasDocument =>
  checkCanvas({
    nodes: [
      { id: 'g', type: 'group', x: 0, y: 0, width: 500, height: 500, label: 'Group' },
      { id: 'a', type: 'text', x: 10, y: 10, width: 100, height: 50, text: 'A' },
      { id: 'b', type: 'text', x: 600, y: 0, width: 100, height: 50, text: 'B' },
    ],
    edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }],
  });

let counter = 0;
const ctx = { now: '2026-10-23T12:00:00.000Z', newId: (p: string) => `${p}_${++counter}` };

describe('checking a canvas', () => {
  it('accepts the JSON Canvas 1.0 shapes Kite supports', () => {
    expect(board().nodes).toHaveLength(3);
  });

  it.each([
    ['a file node', { nodes: [{ id: 'f', type: 'file', x: 0, y: 0, width: 1, height: 1, file: 'x' }] }],
    ['a duplicate id', { nodes: [
      { id: 'a', type: 'text', x: 0, y: 0, width: 1, height: 1, text: '' },
      { id: 'a', type: 'text', x: 0, y: 0, width: 1, height: 1, text: '' },
    ] }],
    ['a dangling edge', { nodes: [], edges: [{ id: 'e', fromNode: 'x', toNode: 'y' }] }],
    ['a javascript: link', { nodes: [{ id: 'l', type: 'link', x: 0, y: 0, width: 1, height: 1, url: 'javascript:alert(1)' }] }],
    ['a bad colour', { nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 1, height: 1, text: '', color: 'red' }] }],
    ['an unknown top-level key', { nodes: [], edges: [], extra: 1 }],
  ])('refuses %s', (_name, raw) => {
    expect(() => checkCanvas(raw)).toThrow(CanvasError);
  });

  it('only allows http and https links', () => {
    expect(isSafeCanvasUrl('https://example.com')).toBe(true);
    expect(isSafeCanvasUrl('data:text/html,hi')).toBe(false);
  });

  it('round-trips through its one-item-per-line form', () => {
    const text = serialiseCanvas(board());
    expect(text.split('\n').filter((l) => l.includes('"id"'))).toHaveLength(4);
    expect(parseCanvas(text)).toEqual(board());
  });

  it('drops every kite key in strict form', () => {
    const { doc } = applyCanvasOps(board(), [{ op: 'add', node: { type: 'text', text: 'x' } }], ctx);
    expect(JSON.stringify(strictCanvas(doc))).not.toContain('kite');
  });

  it('takes its title from the first group, else the first text line', () => {
    expect(canvasTitle(board())).toBe('Group');
    expect(canvasTitle(checkCanvas({ nodes: [{ id: 't', type: 'text', x: 0, y: 0, width: 1, height: 1, text: '# Hi\nthere' }] }))).toBe('Hi');
  });
});

describe('applying operations', () => {
  it('resolves temporary ids for later operations in the same batch', () => {
    const { doc, ids } = applyCanvasOps(
      board(),
      [
        { op: 'add', tempId: 't', node: { type: 'text', text: 'new' } },
        { op: 'connect', from: 'a', to: 't', tempId: 'te' },
      ],
      ctx,
    );
    expect(ids.t).toBeDefined();
    expect(doc.edges.find((e) => e.id === ids.te)?.toNode).toBe(ids.t);
  });

  it('places a node added into a group inside it', () => {
    const { doc, ids } = applyCanvasOps(board(), [{ op: 'add', tempId: 't', in: 'g', node: { type: 'text', text: 'in' } }], ctx);
    const node = doc.nodes.find((n) => n.id === ids.t)!;
    expect(node.x).toBeGreaterThanOrEqual(0);
    expect(node.x + node.width).toBeLessThanOrEqual(500);
  });

  it('moves a group together with the nodes inside it', () => {
    const { doc } = applyCanvasOps(board(), [{ op: 'move', id: 'g', x: 100, y: 100 }], ctx);
    expect(doc.nodes.find((n) => n.id === 'a')).toMatchObject({ x: 110, y: 110 });
    expect(doc.nodes.find((n) => n.id === 'b')).toMatchObject({ x: 600, y: 0 });
  });

  it('removes a deleted node’s edges', () => {
    const { doc } = applyCanvasOps(board(), [{ op: 'delete', id: 'a' }], ctx);
    expect(doc.edges).toHaveLength(0);
  });

  it('will not change a node’s id or type', () => {
    expect(() => applyCanvasOps(board(), [{ op: 'update', id: 'a', set: { type: 'link' } }], ctx)).toThrow(CanvasError);
  });

  it('is all or nothing, and says which operation failed', () => {
    const before = board();
    try {
      applyCanvasOps(before, [{ op: 'move', id: 'a', x: 1, y: 1 }, { op: 'resize', id: 'zz', width: 1, height: 1 }], ctx);
      expect.unreachable();
    } catch (error) {
      expect((error as CanvasError).opIndex).toBe(1);
    }
    expect(before.nodes.find((n) => n.id === 'a')).toMatchObject({ x: 10, y: 10 });
  });

  it('stamps kite timestamps and ignores ones the client sends', () => {
    const { doc, ids } = applyCanvasOps(
      board(),
      [{ op: 'add', tempId: 't', node: { type: 'text', text: 'x', kite: { createdAt: '1999-01-01T00:00:00Z' } } }],
      ctx,
    );
    expect(doc.nodes.find((n) => n.id === ids.t)?.kite?.createdAt).toBe(ctx.now);
  });

  it('refuses an empty batch', () => {
    expect(() => applyCanvasOps(board(), [], ctx)).toThrow(CanvasError);
  });
});
