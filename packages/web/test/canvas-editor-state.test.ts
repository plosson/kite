import { describe, it, expect } from 'vitest';
import { applyCanvasOps, checkCanvas, type CanvasDocument } from '@open-artifact/shared';
import { applyBestEffort, createEditorState, localId } from '../src/canvas/editor-state.js';

const board = (): CanvasDocument =>
  checkCanvas({
    nodes: [
      { id: 'g', type: 'group', x: 0, y: 0, width: 400, height: 300, label: 'G' },
      { id: 'a', type: 'text', x: 20, y: 40, width: 100, height: 50, text: 'A' },
      { id: 'b', type: 'text', x: 600, y: 0, width: 100, height: 50, text: 'B' },
    ],
    edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }],
  });

const ctx = { now: '2026-10-23T12:00:00.000Z', newId: localId };
const pos = (doc: CanvasDocument, id: string) => {
  const n = doc.nodes.find((x) => x.id === id);
  return n ? { x: n.x, y: n.y } : null;
};

describe('the editing session', () => {
  it('undoes and redoes a move', () => {
    const s = createEditorState();
    const moved = s.act(board(), [{ op: 'move', id: 'b', x: 900, y: 90 }]);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    const back = s.undo(moved.doc);
    expect(back.ok && pos(back.doc, 'b')).toEqual({ x: 600, y: 0 });
    const again = back.ok ? s.redo(back.doc) : back;
    expect(again.ok && pos(again.doc, 'b')).toEqual({ x: 900, y: 90 });
  });

  it('undoes a delete, bringing back the node and its edge with the same ids', () => {
    const s = createEditorState();
    const gone = s.act(board(), [{ op: 'delete', id: 'a' }]);
    if (!gone.ok) throw new Error('delete failed');
    expect(gone.doc.edges).toHaveLength(0);
    const back = s.undo(gone.doc);
    if (!back.ok) throw new Error(back.message);
    expect(back.doc.nodes.find((n) => n.id === 'a')).toMatchObject({ text: 'A', x: 20, y: 40 });
    expect(back.doc.edges.map((e) => e.id)).toEqual(['e']);
    // What undo sends, the server would accept too.
    expect(() => applyCanvasOps(gone.doc, back.ops, ctx)).not.toThrow();
  });

  it('undoes a group move without leaving members behind', () => {
    const s = createEditorState();
    const moved = s.act(board(), [{ op: 'move', id: 'g', x: 1000, y: 1000 }]);
    if (!moved.ok) throw new Error('move failed');
    expect(pos(moved.doc, 'a')).toEqual({ x: 1020, y: 1040 });
    const back = s.undo(moved.doc);
    if (!back.ok) throw new Error(back.message);
    expect(pos(back.doc, 'g')).toEqual({ x: 0, y: 0 });
    expect(pos(back.doc, 'a')).toEqual({ x: 20, y: 40 });
  });

  it('keeps what an agent changed in the meantime', () => {
    const s = createEditorState();
    const moved = s.act(board(), [{ op: 'move', id: 'b', x: 900, y: 90 }]);
    if (!moved.ok) throw new Error();
    const live = applyCanvasOps(moved.doc, [{ op: 'update', id: 'a', set: { text: 'agent' } }], ctx).doc;
    const back = s.undo(live);
    if (!back.ok) throw new Error(back.message);
    expect(back.doc.nodes.find((n) => n.id === 'a')).toMatchObject({ text: 'agent' });
  });

  it('says so instead of guessing when the node it touched is gone', () => {
    const s = createEditorState();
    const edited = s.act(board(), [{ op: 'update', id: 'b', set: { text: 'B2' } }]);
    if (!edited.ok) throw new Error();
    const live = applyCanvasOps(edited.doc, [{ op: 'delete', id: 'b' }], ctx).doc;
    const back = s.undo(live);
    expect(back.ok).toBe(false);
    expect(!back.ok && back.message).toMatch(/changed since/);
  });

  it('clears redo after a new action', () => {
    const s = createEditorState();
    const a = s.act(board(), [{ op: 'move', id: 'b', x: 1, y: 1 }]);
    if (!a.ok) throw new Error();
    const u = s.undo(a.doc);
    if (!u.ok) throw new Error();
    expect(s.canRedo).toBe(true);
    s.act(u.doc, [{ op: 'move', id: 'a', x: 5, y: 5 }]);
    expect(s.canRedo).toBe(false);
  });

  it('refuses a bad action without recording it', () => {
    const s = createEditorState();
    const r = s.act(board(), [{ op: 'move', id: 'ghost', x: 0, y: 0 }]);
    expect(r.ok).toBe(false);
    expect(s.canUndo).toBe(false);
  });
});

describe('replaying unsaved work over a fresh read', () => {
  it('skips what no longer applies and keeps the rest', () => {
    const doc = applyBestEffort(board(), [
      { op: 'move', id: 'ghost', x: 0, y: 0 },
      { op: 'move', id: 'b', x: 7, y: 7 },
    ]);
    expect(pos(doc, 'b')).toEqual({ x: 7, y: 7 });
  });

  it('makes ids the server accepts', () => {
    expect(localId('n')).toMatch(/^n_[A-Za-z0-9]{12}$/);
  });
});
