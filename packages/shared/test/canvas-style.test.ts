import { describe, it, expect } from 'vitest';
import {
  applyCanvasOps,
  canvasDiffOps,
  canvasOutline,
  checkCanvas,
  parseCanvas,
  serialiseCanvas,
  strictCanvas,
  CanvasError,
  type CanvasDocument,
  type CanvasOp,
} from '../src/canvas.js';
import { isCanvasPaint, STYLE_LIMITS } from '../src/canvas-style.js';

let counter = 0;
const ctx = { now: '2026-10-24T09:00:00.000Z', newId: (p: string) => `${p}_${++counter}` };
const apply = (doc: CanvasDocument, ops: CanvasOp[]) => applyCanvasOps(doc, ops, ctx);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" onclick="x()"/><script>alert(1)</script></svg>';
const CLEAN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>';

const board = (): CanvasDocument =>
  checkCanvas({
    nodes: [
      { id: 'g', type: 'group', x: 0, y: 0, width: 600, height: 400, label: 'Box' },
      { id: 'a', type: 'text', x: 20, y: 60, width: 200, height: 80, text: 'A', color: '4' },
      { id: 'b', type: 'text', x: 300, y: 60, width: 200, height: 80, text: 'B' },
    ],
    edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }],
  });

describe('styles in a document', () => {
  it('accepts node, group, edge styles, icons, theme and assets, and keeps them through a round trip', () => {
    const doc = checkCanvas({
      nodes: [
        { id: 'g', type: 'group', x: 0, y: 0, width: 500, height: 300, kite: { style: { fill: '#0090ff14', labelColor: '#0b5cad', labelFont: 'grotesk', labelSize: 18 } } },
        {
          id: 'a', type: 'text', x: 20, y: 60, width: 200, height: 80, text: 'A', color: '5',
          kite: { style: { fill: '#ffffff', borderColor: '5', borderWidth: 2, borderStyle: 'dashed', radius: 12, textColor: '#111', font: 'inter', fontSize: 16, fontWeight: 600, textAlign: 'center', verticalAlign: 'middle', shadow: 'md' }, icon: { name: 'lucide:server', position: 'top', size: 40, color: '#0090ff' } },
        },
        { id: 'b', type: 'text', x: 300, y: 60, width: 100, height: 80, text: 'B', kite: { icon: { name: 'asset:logo' } } },
      ],
      edges: [{ id: 'e', fromNode: 'a', toNode: 'b', toEnd: 'arrow', fromEnd: 'arrow', color: '#ff0000', kite: { style: { width: 3, line: 'dotted', curve: 'step', labelColor: '#333', labelBackground: 'transparent' } } }],
      kite: {
        format: 'kite-canvas', formatVersion: 1, docId: 'art_x', version: 3,
        theme: { background: '#fafaf7', grid: 'lines', gridColor: '#e4e4e7', node: { font: 'inter', radius: 8 }, group: { borderStyle: 'solid' }, edge: { color: '#71717a', curve: 'straight' } },
        assets: { logo: { type: 'svg', svg: SVG, name: 'Logo' } },
      },
    });
    expect(doc.kite).toEqual({
      format: 'kite-canvas', formatVersion: 1,
      theme: { background: '#fafaf7', grid: 'lines', gridColor: '#e4e4e7', node: { font: 'inter', radius: 8 }, group: { borderStyle: 'solid' }, edge: { color: '#71717a', curve: 'straight' } },
      assets: { logo: { type: 'svg', svg: CLEAN, name: 'Logo' } },
    });
    expect(parseCanvas(serialiseCanvas(doc))).toEqual(doc);
  });

  it('the strict export drops styles, icons, theme and assets but keeps spec colour and ends', () => {
    const doc = apply(board(), [
      { op: 'addAsset', tempId: 'svg', svg: SVG },
      { op: 'update', id: 'a', set: { kite: { style: { fill: '#fff' }, icon: { name: 'asset:svg' } } } },
      { op: 'update', id: 'e', set: { toEnd: 'arrow', fromEnd: 'arrow', color: '2', kite: { style: { width: 4 } } } },
      { op: 'theme', set: { background: '#000000' } },
    ]).doc;
    const strict = strictCanvas(doc);
    expect(JSON.stringify(strict)).not.toContain('kite');
    expect(JSON.stringify(strict)).not.toContain('svg');
    expect(strict).toEqual({
      nodes: [
        { id: 'g', type: 'group', x: 0, y: 0, width: 600, height: 400, label: 'Box' },
        { id: 'a', type: 'text', x: 20, y: 60, width: 200, height: 80, text: 'A', color: '4' },
        { id: 'b', type: 'text', x: 300, y: 60, width: 200, height: 80, text: 'B' },
      ],
      edges: [{ id: 'e', fromNode: 'a', toNode: 'b', fromEnd: 'arrow', toEnd: 'arrow', color: '2' }],
    });
    expect(Object.keys(strict)).toEqual(['nodes', 'edges']);
  });

  it('refuses bad values with a message that says what is allowed', () => {
    const bad: Array<[unknown, RegExp]> = [
      [{ nodes: [{ id: 'a', type: 'text', text: '', x: 0, y: 0, width: 1, height: 1, kite: { style: { fill: 'red' } } }] }, /fill must be a preset/],
      [{ nodes: [{ id: 'a', type: 'text', text: '', x: 0, y: 0, width: 1, height: 1, kite: { style: { fontSize: 200 } } }] }, /fontSize must be a whole number from 8 to 96/],
      [{ nodes: [{ id: 'a', type: 'text', text: '', x: 0, y: 0, width: 1, height: 1, kite: { style: { font: 'Comic Sans' } } }] }, /font must be one of "sans", "inter"/],
      [{ nodes: [{ id: 'a', type: 'text', text: '', x: 0, y: 0, width: 1, height: 1, kite: { style: { labelColor: '#fff' } } }] }, /unknown key "labelColor"/],
      [{ nodes: [{ id: 'a', type: 'text', text: '', x: 0, y: 0, width: 1, height: 1, kite: { style: { background: '#fff' } } }] }, /unknown key "background"/],
      [{ nodes: [{ id: 'a', type: 'text', text: '', x: 0, y: 0, width: 1, height: 1, kite: { icon: { name: 'fa:server' } } }] }, /"lucide:<icon>" or "asset:<id>"/],
      [{ nodes: [{ id: 'a', type: 'text', text: '', x: 0, y: 0, width: 1, height: 1, kite: { icon: { name: 'lucide:Server' } } }] }, /not a Lucide icon name/],
      [{ nodes: [{ id: 'a', type: 'text', text: '', x: 0, y: 0, width: 1, height: 1, kite: { icon: { name: 'lucide:server', size: 400 } } }] }, /size must be a whole number from 12 to 160/],
      [{ nodes: [{ id: 'a', type: 'text', text: '', x: 0, y: 0, width: 1, height: 1, kite: { icon: { name: 'asset:x', color: '#fff' } } }] }, /only applies to Lucide icons/],
      [{ nodes: [{ id: 'a', type: 'text', text: '', x: 0, y: 0, width: 1, height: 1, kite: { icon: { name: 'asset:missing' } } }] }, /does not have/],
      [{ nodes: [], kite: { theme: { grid: 'hex' } } }, /grid must be one of/],
      [{ nodes: [], kite: { theme: { edge: { color: 'blue' } } } }, /color must be a preset/],
      [{ nodes: [], kite: { theme: { fonts: [] } } }, /unknown key "fonts"/],
      [{ nodes: [], kite: { other: 1 } }, /Unknown key "kite.other"/],
      [{ nodes: [], kite: { assets: { x: { type: 'svg', svg: '<html/>' } } } }, /must be <svg>/],
      [{ nodes: [], kite: { assets: { x: { type: 'png', svg: '' } } } }, /type must be "svg"/],
      [{ nodes: [{ id: 'a', type: 'text', text: '', x: 0, y: 0, width: 1, height: 1 }, { id: 'b', type: 'text', text: '', x: 0, y: 0, width: 1, height: 1 }], edges: [{ id: 'e', fromNode: 'a', toNode: 'b', kite: { style: { color: '#fff' } } }] }, /Its colour is the edge's own "color"/],
    ];
    for (const [raw, message] of bad) expect(() => checkCanvas(raw), message.source).toThrow(message);
  });

  it('knows its colours', () => {
    for (const ok of ['1', '6', '#abc', '#aabbcc', '#aabbcc80', 'transparent']) expect(isCanvasPaint(ok)).toBe(true);
    for (const no of ['0', '7', 'red', '#ab', '#aabbccd', 'url(x)', 'rgb(0,0,0)']) expect(isCanvasPaint(no)).toBe(false);
  });
});

describe('style operations', () => {
  it('merges a node style key by key, and null removes a key or the whole style', () => {
    let doc = apply(board(), [{ op: 'update', id: 'a', set: { kite: { style: { fill: '#fff', radius: 8 } } } }]).doc;
    doc = apply(doc, [{ op: 'update', id: 'a', set: { kite: { style: { radius: null, font: 'serif' } } } }]).doc;
    expect(doc.nodes[1]!.kite?.style).toEqual({ fill: '#fff', font: 'serif' });
    doc = apply(doc, [{ op: 'update', id: 'a', set: { kite: { style: null } } }]).doc;
    expect(doc.nodes[1]!.kite?.style).toBeUndefined();
    expect(doc.nodes[1]!.color).toBe('4');
  });

  it('applies one style to several nodes in one batch, all or nothing', () => {
    const ops: CanvasOp[] = ['a', 'b'].map((id) => ({ op: 'update', id, set: { kite: { style: { textColor: '#222222' } } } }));
    const doc = apply(board(), ops).doc;
    expect(doc.nodes.filter((n) => n.kite?.style?.textColor === '#222222')).toHaveLength(2);
    expect(() => apply(board(), [...ops, { op: 'update', id: 'b', set: { kite: { style: { textColor: 'nope' } } } }])).toThrow(/ops\[2\]|textColor/);
  });

  it('sets and removes icons; an icon may name an asset added earlier in the batch by tempId', () => {
    const result = apply(board(), [
      { op: 'addAsset', tempId: 'logo', svg: SVG, name: 'Logo' },
      { op: 'add', tempId: 'n', node: { type: 'text', text: 'With icon', kite: { icon: { name: 'asset:logo', position: 'top' } } } },
      { op: 'update', id: 'a', set: { kite: { icon: { name: 'lucide:database' } } } },
    ]);
    const assetId = result.ids.logo!;
    expect(result.doc.kite?.assets?.[assetId]).toEqual({ type: 'svg', svg: CLEAN, name: 'Logo' });
    expect(result.doc.nodes.find((n) => n.id === result.ids.n)!.kite?.icon).toEqual({ name: `asset:${assetId}`, position: 'top' });
    const cleared = apply(result.doc, [{ op: 'update', id: 'a', set: { kite: { icon: null } } }]).doc;
    expect(cleared.nodes[1]!.kite?.icon).toBeUndefined();
  });

  it('sanitises an uploaded SVG, refuses an unusable one, and caps the count', () => {
    expect(() => apply(board(), [{ op: 'addAsset', svg: '<svg><script>alert(1)</script></svg>' }])).toThrow(/Nothing is left to draw/);
    expect(() => apply(board(), [{ op: 'addAsset', svg: `<svg><!--${'x'.repeat(70000)}--><rect/></svg>` }])).toThrow(/KB/);
    let doc = board();
    doc = apply(doc, Array.from({ length: STYLE_LIMITS.maxAssets }, () => ({ op: 'addAsset', svg: CLEAN }) as CanvasOp)).doc;
    expect(() => apply(doc, [{ op: 'addAsset', svg: CLEAN }])).toThrow(/up to 100/);
  });

  it('will not delete an asset a node still shows', () => {
    const { doc, ids } = apply(board(), [
      { op: 'addAsset', tempId: 's', svg: SVG },
      { op: 'update', id: 'a', set: { kite: { icon: { name: 'asset:s' } } } },
    ]);
    expect(() => apply(doc, [{ op: 'deleteAsset', id: ids.s! }])).toThrow(/is the icon of node "a"/);
    const after = apply(doc, [
      { op: 'update', id: 'a', set: { kite: { icon: null } } },
      { op: 'deleteAsset', id: ids.s! },
    ]).doc;
    expect(after.kite?.assets).toBeUndefined();
    expect(() => apply(board(), [{ op: 'update', id: 'a', set: { kite: { icon: { name: 'asset:nope' } } } }])).toThrow(CanvasError);
  });

  it('styles edges: ends, colour and kite.style, on connect and on update', () => {
    let doc = apply(board(), [
      { op: 'connect', id: 'e2', from: 'b', to: 'a', fromEnd: 'arrow', toEnd: 'none', color: '#123456', kite: { style: { line: 'dashed', curve: 'straight' } } },
    ]).doc;
    expect(doc.edges[1]).toMatchObject({ fromEnd: 'arrow', toEnd: 'none', color: '#123456', kite: { style: { line: 'dashed', curve: 'straight' } } });
    doc = apply(doc, [{ op: 'update', id: 'e2', set: { kite: { style: { curve: null, width: 2 } } }, unset: ['fromEnd'] }]).doc;
    expect(doc.edges[1]!.kite?.style).toEqual({ line: 'dashed', width: 2 });
    expect(doc.edges[1]!.fromEnd).toBeUndefined();
    expect(() => apply(doc, [{ op: 'update', id: 'e2', set: { kite: { createdAt: 'x' } } as never }])).toThrow(/only change "style"/);
    expect(() => apply(doc, [{ op: 'connect', from: 'a', to: 'b', kite: { style: { curve: 'zigzag' } } as never }])).toThrow(/curve must be one of/);
  });

  it('changes the theme with merge semantics, and null removes it', () => {
    let doc = apply(board(), [{ op: 'theme', set: { background: '#fafafa', node: { font: 'inter', radius: 10 } } }]).doc;
    doc = apply(doc, [{ op: 'theme', set: { grid: 'none', node: { radius: null }, edge: { color: '5' } } }]).doc;
    expect(doc.kite?.theme).toEqual({ background: '#fafafa', node: { font: 'inter' }, grid: 'none', edge: { color: '5' } });
    expect(() => apply(doc, [{ op: 'theme', set: { node: { labelColor: '#fff' } } }])).toThrow(/unknown key "labelColor"/);
    expect(() => apply(doc, [{ op: 'theme' } as never])).toThrow(/needs "set"/);
    doc = apply(doc, [{ op: 'theme', set: null }]).doc;
    expect(doc.kite?.theme).toBeUndefined();
  });

  it('lists icons in the outline', () => {
    const doc = apply(board(), [{ op: 'update', id: 'a', set: { kite: { icon: { name: 'lucide:server' } } } }]).doc;
    expect(canvasOutline(doc).tree[0]!.children![0]).toMatchObject({ id: 'a', icon: 'lucide:server' });
  });
});

describe('undo and restore of styles', () => {
  const strip = (doc: CanvasDocument) =>
    JSON.stringify({
      nodes: doc.nodes.map(({ kite, ...n }) => ({ ...n, style: kite?.style, icon: kite?.icon })),
      edges: doc.edges.map(({ kite, ...e }) => ({ ...e, style: kite?.style })),
      theme: doc.kite?.theme,
      assets: doc.kite?.assets,
    });

  it('diff ops turn either version into the other, styles, icons, theme and assets included', () => {
    const before = apply(board(), [
      { op: 'update', id: 'a', set: { kite: { style: { fill: '#fff', radius: 4 }, icon: { name: 'lucide:server' } } } },
      { op: 'update', id: 'e', set: { kite: { style: { width: 3 } } } },
      { op: 'theme', set: { background: '#eee', edge: { curve: 'step' } } },
    ]).doc;
    const after = apply(before, [
      { op: 'addAsset', id: 'logo', svg: SVG },
      { op: 'update', id: 'a', set: { kite: { style: { radius: null, font: 'mono' }, icon: { name: 'asset:logo' } } } },
      { op: 'update', id: 'b', set: { kite: { style: { shadow: 'lg' } } } },
      { op: 'update', id: 'e', set: { toEnd: 'none', kite: { style: null } } },
      { op: 'theme', set: { background: null, grid: 'dots', edge: { curve: null } } },
    ]).doc;
    expect(strip(apply(before, canvasDiffOps(before, after)).doc)).toBe(strip(after));
    expect(strip(apply(after, canvasDiffOps(after, before)).doc)).toBe(strip(before));
    expect(canvasDiffOps(after, before).at(-1)).toEqual({ op: 'deleteAsset', id: 'logo' });
  });
});
