import { describe, it, expect } from 'vitest';
import {
  applyCanvasOps,
  canvasChanges,
  canvasDiffOps,
  checkCanvas,
  findFreeSlot,
  parentGroupOf,
  type CanvasDocument,
  type CanvasOp,
} from '../src/canvas.js';

let counter = 0;
const ctx = { now: '2026-10-23T12:00:00.000Z', newId: (p: string) => `${p}_${++counter}` };
const apply = (doc: CanvasDocument, ops: CanvasOp[]) => applyCanvasOps(doc, ops, ctx).doc;

const board = (): CanvasDocument =>
  checkCanvas({
    nodes: [
      { id: 'g', type: 'group', x: 0, y: 0, width: 500, height: 500, label: 'Outer' },
      { id: 'h', type: 'group', x: 20, y: 60, width: 300, height: 300, label: 'Inner' },
      { id: 'a', type: 'text', x: 40, y: 100, width: 100, height: 50, text: 'A', color: '1' },
      { id: 'b', type: 'text', x: 600, y: 0, width: 100, height: 50, text: 'B' },
      { id: 'k', type: 'link', x: 600, y: 200, width: 100, height: 50, url: 'https://kite.local/a/x', kite: { kind: 'kite', ref: 'art_abcdef', view: 'card' } },
    ],
    edges: [{ id: 'e', fromNode: 'a', toNode: 'b', label: 'goes' }],
  });

/** Positions, sizes and content, without timestamps. */
const shape = (doc: CanvasDocument) =>
  JSON.stringify({
    nodes: doc.nodes
      .map(({ kite, ...n }) => {
        const { createdAt: _c, updatedAt: _u, ...k } = kite ?? {};
        return { ...n, kite: Object.keys(k).length ? k : undefined };
      })
      .sort((x, y) => x.id.localeCompare(y.id)),
    edges: doc.edges.map(({ kite: _k, ...e }) => e).sort((x, y) => x.id.localeCompare(y.id)),
  });

describe('group membership', () => {
  it('picks the smallest enclosing group', () => {
    const doc = board();
    expect(parentGroupOf(doc, doc.nodes.find((n) => n.id === 'a')!)?.id).toBe('h');
    expect(parentGroupOf(doc, doc.nodes.find((n) => n.id === 'h')!)?.id).toBe('g');
    expect(parentGroupOf(doc, doc.nodes.find((n) => n.id === 'g')!)).toBeNull();
    expect(parentGroupOf(doc, doc.nodes.find((n) => n.id === 'b')!)).toBeNull();
  });
});

describe('placement', () => {
  it('puts a node beside the one named in near, on the side asked for, clear of others', () => {
    const doc = apply(board(), [{ op: 'add', id: 'n1', near: 'b', side: 'bottom', node: { text: 'x', width: 100, height: 50 } }]);
    const n = doc.nodes.find((x) => x.id === 'n1')!;
    expect(n).toMatchObject({ x: 600, y: 90 });
    // Again below b: the first spot is taken now, so it steps past it, and past k.
    const doc2 = apply(doc, [{ op: 'add', id: 'n3', near: 'b', side: 'bottom', node: { text: 'y', width: 100, height: 100 } }]);
    expect(doc2.nodes.find((x) => x.id === 'n3')!.y).toBeGreaterThanOrEqual(290);
  });

  it('without a position, lands next to the most recently changed node rather than far right', () => {
    let doc = board();
    doc = apply(doc, [{ op: 'update', id: 'a', set: { text: 'A2' } }]);
    doc = applyCanvasOps(doc, [{ op: 'add', id: 'n2', node: { text: 'new', width: 100, height: 50 } }], {
      ...ctx,
      now: '2026-10-23T13:00:00.000Z',
    }).doc;
    const n = doc.nodes.find((x) => x.id === 'n2')!;
    // Beside a, inside the frames, not beyond b and k.
    expect(n.x).toBeLessThan(600);
    const box = { ...n };
    for (const other of doc.nodes.filter((o) => o.type !== 'group' && o.id !== 'n2')) {
      const overlap = box.x < other.x + other.width && other.x < box.x + box.width && box.y < other.y + other.height && other.y < box.y + box.height;
      expect(overlap).toBe(false);
    }
  });

  it('findFreeSlot steps past whatever is in the way', () => {
    const doc = board();
    expect(findFreeSlot(doc, { x: 600, y: 0 }, { width: 100, height: 50 })).toEqual({ x: 740, y: 0 });
  });

  it('rejects an unknown side', () => {
    expect(() => apply(board(), [{ op: 'add', near: 'b', side: 'up' as never, node: { text: 'x' } }])).toThrow(/side/);
  });
});

describe('edge updates', () => {
  it('changes and clears a label and sides', () => {
    let doc = apply(board(), [{ op: 'update', id: 'e', set: { label: 'next', fromSide: 'bottom', toSide: 'top' } }]);
    expect(doc.edges[0]).toMatchObject({ label: 'next', fromSide: 'bottom', toSide: 'top' });
    doc = apply(doc, [{ op: 'update', id: 'e', unset: ['label', 'toSide'] }]);
    expect(doc.edges[0]!.label).toBeUndefined();
    expect(doc.edges[0]!.toSide).toBeUndefined();
  });

  it('refuses to change what an edge connects', () => {
    expect(() => apply(board(), [{ op: 'update', id: 'e', set: { fromNode: 'b' } as never }])).toThrow(/Disconnect/);
  });
});

describe('canvasChanges', () => {
  it('lists added, removed, moved, resized and edited nodes and edges', () => {
    const before = board();
    const after = apply(before, [
      { op: 'move', id: 'b', x: 700, y: 10 },
      { op: 'resize', id: 'k', width: 200, height: 80 },
      { op: 'update', id: 'a', set: { text: 'A!' } },
      { op: 'delete', id: 'h' },
      { op: 'add', id: 'c', node: { text: 'C', x: 900, y: 900 } },
      { op: 'connect', id: 'e2', from: 'b', to: 'c' },
    ]);
    const c = canvasChanges(before, after);
    const by = (id: string) => c.nodes.find((n) => n.id === id);
    expect(by('b')).toMatchObject({ kind: 'changed', moved: true, resized: false, edited: false });
    expect(by('k')).toMatchObject({ kind: 'changed', resized: true, moved: false });
    expect(by('a')).toMatchObject({ kind: 'changed', edited: true, moved: false });
    expect(by('h')?.kind).toBe('removed');
    expect(by('c')?.kind).toBe('added');
    expect(by('g')).toBeUndefined();
    expect(c.edges).toEqual([expect.objectContaining({ id: 'e2', kind: 'added' })]);
  });
});

describe('canvasDiffOps', () => {
  const cases: Array<[string, CanvasOp[]]> = [
    ['a move', [{ op: 'move', id: 'b', x: 900, y: 40 }]],
    ['a group move that carries members', [{ op: 'move', id: 'g', x: 1000, y: 1000 }]],
    ['an inner group move', [{ op: 'move', id: 'h', x: 150, y: 150 }]],
    ['a resize', [{ op: 'resize', id: 'g', width: 800, height: 700 }]],
    ['a delete that takes edges', [{ op: 'delete', id: 'a' }]],
    ['a group delete', [{ op: 'delete', id: 'g' }]],
    ['an edit that clears the colour', [{ op: 'update', id: 'a', set: { text: 'changed' }, unset: ['color'] }]],
    ['a kite view switch', [{ op: 'update', id: 'k', set: { kite: { view: 'preview' } } }]],
    ['an add and connect', [{ op: 'add', id: 'z', node: { text: 'Z', x: 2000, y: 0 } }, { op: 'connect', id: 'ez', from: 'z', to: 'a', fromSide: 'left', toSide: 'top' }]],
    ['an edge edit', [{ op: 'update', id: 'e', set: { label: 'x', fromSide: 'top' } }]],
    ['a disconnect', [{ op: 'disconnect', id: 'e' }]],
    ['a node moved out of its group', [{ op: 'move', id: 'a', x: 1500, y: 1500 }]],
  ];

  it.each(cases)('round-trips %s (forward and back)', (_name, ops) => {
    const before = board();
    const after = apply(before, ops);
    const forward = canvasDiffOps(before, after);
    expect(shape(apply(before, forward))).toBe(shape(after));
    const back = canvasDiffOps(after, before);
    expect(shape(apply(after, back))).toBe(shape(before));
  });

  it('undoes only what the action touched, keeping a concurrent change', () => {
    const before = board();
    const after = apply(before, [{ op: 'move', id: 'b', x: 900, y: 40 }]);
    const live = apply(after, [{ op: 'update', id: 'a', set: { text: 'agent wrote this' } }]);
    const undone = apply(live, canvasDiffOps(after, before));
    expect(undone.nodes.find((n) => n.id === 'b')).toMatchObject({ x: 600, y: 0 });
    expect(undone.nodes.find((n) => n.id === 'a')).toMatchObject({ text: 'agent wrote this' });
  });

  it('returns nothing for identical documents', () => {
    expect(canvasDiffOps(board(), board())).toEqual([]);
  });
});

import { canvasOutline } from '../src/canvas.js';

describe('canvasOutline', () => {
  it('nests groups as a tree with one line per node', () => {
    const o = canvasOutline(board());
    expect(o.counts).toEqual({ nodes: 5, edges: 1, groups: 2 });
    expect(o.tree.map((n) => n.id)).toEqual(['g', 'b', 'k']);
    const g = o.tree[0]!;
    expect(g.children!.map((n) => n.id)).toEqual(['h']);
    expect(g.children![0]!.children!.map((n) => n.summary)).toEqual(['A']);
    expect(o.tree[2]!.summary).toBe('kite art_abcdef');
    expect(o.freeSlot.x).toBeGreaterThanOrEqual(740);
  });

  it('limits to one frame and a depth', () => {
    const o = canvasOutline(board(), { frame: 'g', depth: 1 });
    expect(o.tree).toHaveLength(1);
    expect(o.tree[0]!.children).toEqual([]);
    expect(o.tree[0]!.summary).toBe('Outer (1 inside)');
    expect(() => canvasOutline(board(), { frame: 'a' })).toThrow(/no group/);
  });
});
