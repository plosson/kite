/**
 * The line diff the history view shows between two versions. The cases are
 * the ones a naive diff gets wrong: nothing changed, everything changed, a
 * change at either end, and two versions too far apart to align.
 */

import { describe, expect, it } from 'vitest';
import { diffLines, foldUnchanged } from '../src/diff.js';

const kinds = (before: string, after: string) => diffLines(before, after).lines.map((l) => `${l.kind[0]}:${l.text}`);

describe('diffLines', () => {
  it('finds nothing to show between identical versions', () => {
    const diff = diffLines('a\nb\nc\n', 'a\nb\nc\n');
    expect(diff).toMatchObject({ added: 0, removed: 0, approximate: false });
    expect(diff.lines.every((line) => line.kind === 'same')).toBe(true);
  });

  it('shows one changed line as removed then added', () => {
    expect(kinds('a\nb\nc', 'a\nB\nc')).toEqual(['s:a', 'r:b', 'a:B', 's:c']);
  });

  it('handles additions at the start and the end', () => {
    expect(kinds('b', 'a\nb\nc')).toEqual(['a:a', 's:b', 'a:c']);
  });

  it('handles an empty side', () => {
    expect(diffLines('', 'x\ny')).toMatchObject({ added: 2, removed: 0 });
    expect(diffLines('x\ny', '')).toMatchObject({ added: 0, removed: 2 });
  });

  it('aligns moved-around lines on what they share', () => {
    const diff = diffLines('# T\none\ntwo\nthree', '# T\ntwo\nthree\nfour');
    expect(diff).toMatchObject({ added: 1, removed: 1 });
  });

  it('numbers lines on each side', () => {
    const diff = diffLines('a\nb', 'z\na\nb');
    expect(diff.lines[1]).toEqual({ kind: 'same', text: 'a', oldLine: 1, newLine: 2 });
  });

  it('ignores the difference between CRLF and LF', () => {
    expect(diffLines('a\r\nb\r\n', 'a\nb\n')).toMatchObject({ added: 0, removed: 0 });
  });

  it('falls back to whole blocks when the versions are too far apart', () => {
    const diff = diffLines('a\nb\nc', 'x\ny\nz', 4);
    expect(diff).toMatchObject({ approximate: true, added: 3, removed: 3 });
  });
});

describe('foldUnchanged', () => {
  it('keeps context around a change and folds the rest', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 10', 'LINE 10');
    const rows = foldUnchanged(diffLines(before, after).lines, 2);
    expect(rows[0]).toEqual({ kind: 'fold', count: 8 });
    expect(rows.filter((row) => row.kind !== 'fold')).toHaveLength(6);
    expect(rows[rows.length - 1]).toEqual({ kind: 'fold', count: 7 });
  });

  it('folds nothing when everything changed', () => {
    const rows = foldUnchanged(diffLines('a', 'b').lines);
    expect(rows.some((row) => row.kind === 'fold')).toBe(false);
  });
});
