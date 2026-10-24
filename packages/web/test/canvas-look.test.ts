import { describe, expect, it } from 'vitest';
import type { CanvasEdge, CanvasNode } from '@open-artifact/shared';
import { backdropLook, edgeLook, minimapLook, nodeLook, paint } from '../src/canvas/look.js';
import { common, edgeStyleOps, iconOps, nodeStyleOps, resetNodeOps, themeOps } from '../src/canvas/style-ops.js';

const text = (extra: Partial<CanvasNode> = {}): CanvasNode =>
  ({ id: 'a', type: 'text', text: 'Hi', x: 0, y: 0, width: 100, height: 60, ...extra }) as CanvasNode;
const edge = (extra: Partial<CanvasEdge> = {}): CanvasEdge => ({ id: 'e', fromNode: 'a', toNode: 'b', ...extra });

describe('how a node looks', () => {
  it('is Kite’s own card when nothing says otherwise', () => {
    const look = nodeLook(text(), undefined);
    expect(look.box).toMatchObject({ background: 'var(--color-surface)', borderColor: 'var(--color-line)', borderWidth: 1, borderRadius: 6 });
    expect(look.text).toMatchObject({ fontFamily: 'var(--font-sans)', fontSize: 14, color: 'var(--color-ink)' });
  });

  it('layers theme, then the JSON Canvas colour, then its own style', () => {
    const theme = { node: { fill: '#fafafa', radius: 12, font: 'serif' as const } };
    expect(nodeLook(text(), theme).box).toMatchObject({ background: '#fafafa', borderRadius: 12 });
    const coloured = nodeLook(text({ color: '5' }), theme);
    expect(coloured.box.borderColor).toBe('#0090ff');
    expect(String(coloured.box.background)).toContain('#0090ff');
    expect(coloured.box.borderRadius).toBe(12);
    const own = nodeLook(text({ color: '5', kite: { style: { fill: '#000000', borderColor: '#ff0000', font: 'mono' } } }), theme);
    expect(own.box).toMatchObject({ background: '#000000', borderColor: '#ff0000' });
    expect(own.text.fontFamily).toContain('JetBrains Mono Variable');
  });

  it('draws a group dashed and see-through, with its own name style', () => {
    const group = { id: 'g', type: 'group', x: 0, y: 0, width: 10, height: 10, kite: { style: { labelFont: 'grotesk', labelSize: 20 } } } as CanvasNode;
    const look = nodeLook(group, { group: { borderColor: '6' } });
    expect(look.box).toMatchObject({ background: 'transparent', borderStyle: 'dashed', borderColor: '#8e4ec6' });
    expect(look.label).toMatchObject({ fontSize: 20, fontWeight: 600 });
    expect(look.label.fontFamily).toContain('Space Grotesk');
  });

  it('turns a zero-width border off and maps every preset', () => {
    expect(nodeLook(text({ kite: { style: { borderWidth: 0 } } }), undefined).box.borderStyle).toBe('none');
    expect(['1', '2', '3', '4', '5', '6'].map(paint)).toEqual(['#e5484d', '#f76b15', '#ffc53d', '#30a46c', '#0090ff', '#8e4ec6']);
    expect(paint('#123456')).toBe('#123456');
  });
});

describe('how an edge looks', () => {
  it('defaults to a bezier with an arrow at the end only', () => {
    const look = edgeLook(edge(), undefined);
    expect(look).toMatchObject({ type: 'default', start: false, end: true, width: 1, colour: undefined });
  });

  it('takes colour, width, line and curve from the theme and then the edge', () => {
    const theme = { edge: { color: '#71717a', width: 2, curve: 'straight' as const } };
    expect(edgeLook(edge(), theme)).toMatchObject({ type: 'straight', colour: '#71717a', width: 2 });
    const look = edgeLook(edge({ color: '1', fromEnd: 'arrow', toEnd: 'none', kite: { style: { line: 'dotted', curve: 'step', width: 3 } } }), theme);
    expect(look).toMatchObject({ type: 'smoothstep', colour: '#e5484d', start: true, end: false });
    expect(look.style).toMatchObject({ stroke: '#e5484d', strokeWidth: 3, strokeDasharray: '0 7.5', strokeLinecap: 'round' });
    expect(edgeLook(edge({ kite: { style: { line: 'dashed', width: 2 } } }), undefined).style.strokeDasharray).toBe('8 6');
  });
});

describe('the canvas backdrop', () => {
  it('is dots on the page colour by default, and follows the theme', () => {
    expect(backdropLook(undefined)).toEqual({ background: undefined, grid: 'dots', gridColor: undefined });
    expect(backdropLook({ background: '3', grid: 'lines', gridColor: '#eeeeee' })).toEqual({ background: '#ffc53d', grid: 'lines', gridColor: '#eeeeee' });
  });
});

describe('what the style panel sends', () => {
  it('restyles every selected node in one batch', () => {
    const ops = nodeStyleOps([text({ id: 'a' }), text({ id: 'b' })], { fill: '4', radius: null });
    expect(ops).toEqual([
      { op: 'update', id: 'a', set: { kite: { style: { fill: '4', radius: null } } } },
      { op: 'update', id: 'b', set: { kite: { style: { fill: '4', radius: null } } } },
    ]);
    expect(iconOps([text()], null)).toEqual([{ op: 'update', id: 'a', set: { kite: { icon: null } } }]);
  });

  it('resets only what has a style or colour of its own', () => {
    expect(resetNodeOps([text({ id: 'a' }), text({ id: 'b', color: '2', kite: { style: { fill: '#ffffff' } } })])).toEqual([
      { op: 'update', id: 'b', set: { kite: { style: null } }, unset: ['color'] },
    ]);
  });

  it('puts an edge’s colour and ends in the JSON Canvas fields, the rest in its style', () => {
    expect(edgeStyleOps([edge()], { color: '#0090ff', toEnd: 'none', curve: 'step' })).toEqual([
      { op: 'update', id: 'e', set: { color: '#0090ff', toEnd: 'none', kite: { style: { curve: 'step' } } } },
    ]);
    expect(edgeStyleOps([edge()], { color: null })).toEqual([{ op: 'update', id: 'e', unset: ['color'] }]);
    expect(themeOps({ grid: 'none' })).toEqual([{ op: 'theme', set: { grid: 'none' } }]);
  });

  it('shows a value only when the whole selection agrees', () => {
    expect(common(['4', '4'])).toEqual({ value: '4', mixed: false });
    expect(common(['4', undefined])).toEqual({ value: undefined, mixed: true });
  });
});

describe('the minimap', () => {
  it('shows a node in its fill, and a see-through group as a wash of its border', () => {
    expect(minimapLook(text({ kite: { style: { fill: '#fff7e8', borderColor: '#efb54f' } } }), undefined)).toEqual({ fill: '#fff7e8', stroke: '#efb54f' });
    const group = { id: 'g', type: 'group', x: 0, y: 0, width: 10, height: 10, kite: { style: { borderColor: '4' } } } as CanvasNode;
    const look = minimapLook(group, undefined);
    expect(look.stroke).toBe(paint('4'));
    expect(look.fill).toBe(`color-mix(in srgb, ${paint('4')} 18%, transparent)`);
  });
});
