import { describe, it, expect } from 'vitest';
import { checkCanvas } from '@open-artifact/shared';
import { edgeSides, facingSides, flowNodes } from '../src/canvas/to-flow.js';

const doc = checkCanvas({
  nodes: [
    { id: 'a', type: 'text', x: 40, y: 100, width: 100, height: 50, text: 'A' },
    { id: 'h', type: 'group', x: 20, y: 60, width: 300, height: 300 },
    { id: 'g', type: 'group', x: 0, y: 0, width: 500, height: 500 },
    { id: 'b', type: 'text', x: 600, y: 0, width: 100, height: 50, text: 'B' },
  ],
  edges: [
    { id: 'e', fromNode: 'a', toNode: 'b' },
    { id: 'f', fromNode: 'a', toNode: 'b', fromSide: 'top', toSide: 'top' },
  ],
});

describe('groups as React Flow parents', () => {
  it('parents each node to its smallest group, parents first, positions relative', () => {
    const shapes = flowNodes(doc);
    expect(shapes.map((s) => s.id)).toEqual(['g', 'b', 'h', 'a']);
    const a = shapes.find((s) => s.id === 'a')!;
    expect(a.parentId).toBe('h');
    expect(a.position).toEqual({ x: 20, y: 40 });
    expect(a.parentOrigin).toEqual({ x: 20, y: 60 });
    expect(shapes.find((s) => s.id === 'h')!.parentId).toBe('g');
    expect(shapes.find((s) => s.id === 'b')!.parentId).toBeUndefined();
  });
});

describe('edge sides', () => {
  it('faces the other node when the edge names no side', () => {
    const byId = new Map(doc.nodes.map((n) => [n.id, n]));
    expect(edgeSides(doc.edges[0]!, byId)).toEqual({ fromSide: 'right', toSide: 'left' });
    expect(edgeSides(doc.edges[1]!, byId)).toEqual({ fromSide: 'top', toSide: 'top' });
    const up = { id: 'u', type: 'text' as const, x: 0, y: -500, width: 10, height: 10, text: '' };
    expect(facingSides(doc.nodes[0]!, up)).toEqual({ fromSide: 'top', toSide: 'bottom' });
  });
});

import { linkHref } from '../src/canvas/to-flow.js';

describe('links on a canvas follow the Markdown rule', () => {
  const origin = 'https://kite.example';
  it('opens directly on a canvas that is not public', () => {
    expect(linkHref('https://elsewhere.example/x', false, origin)).toBe('https://elsewhere.example/x');
  });
  it('goes through /leaving for an off-site link on a public canvas', () => {
    expect(linkHref('https://elsewhere.example/x', true, origin)).toBe('/leaving?to=https%3A%2F%2Felsewhere.example%2Fx');
  });
  it('never wraps a link to this instance, even on a public canvas', () => {
    expect(linkHref('https://kite.example/a/abc', true, origin)).toBe('https://kite.example/a/abc');
  });
});
