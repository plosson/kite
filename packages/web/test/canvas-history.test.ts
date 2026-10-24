import { describe, expect, it } from 'vitest';
import { applyCanvasOps, type CanvasDocument } from '@open-artifact/shared';
import { canvasChangesView, parseCanvasContent, restoreOps } from '../src/canvas/history.js';

const v1: CanvasDocument = {
  nodes: [
    { id: 'a', type: 'text', x: 0, y: 0, width: 200, height: 80, text: 'Stays' },
    { id: 'b', type: 'text', x: 300, y: 0, width: 200, height: 80, text: 'Goes away' },
    { id: 'c', type: 'text', x: 0, y: 200, width: 200, height: 80, text: 'Before' },
  ],
  edges: [{ id: 'e1', fromNode: 'a', toNode: 'b' }],
};
const v2: CanvasDocument = {
  nodes: [
    { id: 'a', type: 'text', x: 40, y: 0, width: 200, height: 80, text: 'Stays' },
    { id: 'c', type: 'text', x: 0, y: 200, width: 200, height: 80, text: 'After' },
    { id: 'd', type: 'link', x: 600, y: 0, width: 200, height: 80, url: 'https://example.com/' },
  ],
  edges: [{ id: 'e2', fromNode: 'a', toNode: 'd', label: 'see' }],
};

describe('canvas history', () => {
  it('reads stored content, and an unreadable one as empty', () => {
    expect(parseCanvasContent(JSON.stringify(v1)).nodes).toHaveLength(3);
    expect(parseCanvasContent('not json')).toEqual({ nodes: [], edges: [] });
    expect(parseCanvasContent('{"nodes":5}')).toEqual({ nodes: [], edges: [] });
  });

  it('keeps a version’s theme and custom icons, and nothing else of its kite block', () => {
    const stored = JSON.stringify({
      ...v1,
      kite: { format: 'kite-canvas', formatVersion: 1, docId: 'art_x', version: 4, theme: { grid: 'lines' }, assets: { a_1: { type: 'svg', svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' } } },
    });
    expect(parseCanvasContent(stored).kite).toEqual({
      format: 'kite-canvas',
      formatVersion: 1,
      theme: { grid: 'lines' },
      assets: { a_1: { type: 'svg', svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' } },
    });
  });

  it('lists a restyle, a theme change and a new icon, and keeps a ghost’s icon drawable', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>';
    const before: CanvasDocument = {
      ...v1,
      nodes: v1.nodes.map((n) => (n.id === 'b' ? { ...n, kite: { icon: { name: 'asset:old' } } } : n)),
      kite: { format: 'kite-canvas', formatVersion: 1, assets: { old: { type: 'svg', svg } } },
    };
    const after: CanvasDocument = {
      nodes: v1.nodes.filter((n) => n.id !== 'b').map((n) => (n.id === 'a' ? { ...n, kite: { style: { fill: '4' }, icon: { name: 'asset:new' } } } : n)),
      edges: [],
      kite: { format: 'kite-canvas', formatVersion: 1, theme: { grid: 'none' }, assets: { new: { type: 'svg', svg, name: 'Logo' } } },
    };
    const view = canvasChangesView(before, after);
    expect(view.counts.restyled).toBe(1);
    expect(view.rows.find((r) => r.id === 'a')).toMatchObject({ kind: 'changed', details: ['restyled'] });
    expect(view.rows.find((r) => r.what === 'theme')).toMatchObject({ kind: 'changed', summary: 'Canvas theme' });
    expect(view.rows.filter((r) => r.what === 'icon').map((r) => [r.kind, r.summary])).toEqual([
      ['added', 'Logo'],
      ['removed', 'old'],
    ]);
    expect(Object.keys(view.doc.kite?.assets ?? {}).sort()).toEqual(['new', 'old']);
    // And restoring the old version brings its icon back before the node that wears it.
    const restored = applyCanvasOps(after, restoreOps(after, before), { now: '2026-01-01T00:00:00.000Z', newId: (p) => `${p}_x` }).doc;
    expect(restored.kite?.assets).toEqual(before.kite?.assets);
    expect(restored.kite?.theme).toBeUndefined();
    expect(restored.nodes.find((n) => n.id === 'a')?.kite?.style).toBeUndefined();
  });

  it('lays out what changed, with removed things drawn back as ghosts', () => {
    const view = canvasChangesView(v1, v2);
    expect(view.marks).toEqual({ a: 'changed', b: 'removed', c: 'changed', d: 'added', e1: 'removed', e2: 'added' });
    expect(view.counts).toMatchObject({ added: 1, removed: 1, moved: 1, edited: 1, edgesAdded: 1, edgesRemoved: 1 });
    expect(view.doc.nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'c', 'd']);
    // The removed edge comes back too, since both its ends are drawn.
    expect(view.doc.edges.map((e) => e.id).sort()).toEqual(['e1', 'e2']);
    expect(view.rows.find((r) => r.id === 'a')).toMatchObject({ kind: 'changed', details: ['moved'] });
    expect(view.rows.find((r) => r.id === 'c')).toMatchObject({ kind: 'changed', details: ['edited'], summary: 'After' });
    expect(view.rows.find((r) => r.id === 'e2')).toMatchObject({ what: 'edge', summary: '“see”' });
  });

  it('says a node whose type changed changed, once', () => {
    const before: CanvasDocument = { nodes: [{ id: 'x', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 't' }], edges: [] };
    const after: CanvasDocument = { nodes: [{ id: 'x', type: 'link', x: 0, y: 0, width: 10, height: 10, url: 'https://a.b/' }], edges: [] };
    const view = canvasChangesView(before, after);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({ kind: 'changed', details: ['type changed'] });
    expect(view.doc.nodes).toHaveLength(1);
  });

  it('restores an old version through ops', () => {
    let n = 0;
    const restored = applyCanvasOps(v2, restoreOps(v2, v1), { now: '2026-10-23T16:00:00.000Z', newId: (p) => `${p}_${(n += 1)}` }).doc;
    const shape = (d: CanvasDocument) => ({
      nodes: d.nodes.map(({ kite: _k, ...n }) => n).sort((p, q) => p.id.localeCompare(q.id)),
      edges: d.edges.map(({ kite: _k, ...e }) => e).sort((p, q) => p.id.localeCompare(q.id)),
    });
    expect(shape(restored)).toEqual(shape(v1));
  });
});
