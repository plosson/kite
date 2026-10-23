/**
 * A line diff between two versions of a document's source.
 *
 * Longest common subsequence over lines, after the common head and tail are
 * set aside, which is all an edit to a document usually touches. The table is
 * capped: two versions too different to compare cheaply come back as one
 * block removed and one block added, flagged `approximate`, rather than
 * freezing the tab.
 */

export type DiffLine =
  | { kind: 'same'; text: string; oldLine: number; newLine: number }
  | { kind: 'removed'; text: string; oldLine: number }
  | { kind: 'added'; text: string; newLine: number };

export interface LineDiff {
  lines: DiffLine[];
  added: number;
  removed: number;
  /** True when the versions were too far apart to align line by line. */
  approximate: boolean;
}

/** Cells in the comparison table past which the diff gives up on aligning. */
export const MAX_DIFF_CELLS = 4_000_000;

export function diffLines(before: string, after: string, maxCells = MAX_DIFF_CELLS): LineDiff {
  const a = splitLines(before);
  const b = splitLines(after);

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }

  const lines: DiffLine[] = [];
  for (let i = 0; i < head; i++) lines.push({ kind: 'same', text: a[i] as string, oldLine: i + 1, newLine: i + 1 });

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const n = midA.length;
  const m = midB.length;
  let approximate = false;

  if ((n + 1) * (m + 1) > maxCells) {
    approximate = true;
    midA.forEach((text, i) => lines.push({ kind: 'removed', text, oldLine: head + i + 1 }));
    midB.forEach((text, j) => lines.push({ kind: 'added', text, newLine: head + j + 1 }));
  } else {
    // lcs[i][j]: the longest common run of midA[i..] and midB[j..].
    const width = m + 1;
    const lcs = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * width + j] =
          midA[i] === midB[j]
            ? (lcs[(i + 1) * width + j + 1] as number) + 1
            : Math.max(lcs[(i + 1) * width + j] as number, lcs[i * width + j + 1] as number);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        lines.push({ kind: 'same', text: midA[i] as string, oldLine: head + i + 1, newLine: head + j + 1 });
        i++;
        j++;
      } else if (j < m && (i === n || (lcs[i * width + j + 1] as number) >= (lcs[(i + 1) * width + j] as number))) {
        lines.push({ kind: 'added', text: midB[j] as string, newLine: head + j + 1 });
        j++;
      } else {
        lines.push({ kind: 'removed', text: midA[i] as string, oldLine: head + i + 1 });
        i++;
      }
    }
  }

  for (let k = 0; k < tail; k++) {
    const oldIndex = a.length - tail + k;
    const newIndex = b.length - tail + k;
    lines.push({ kind: 'same', text: a[oldIndex] as string, oldLine: oldIndex + 1, newLine: newIndex + 1 });
  }

  // Removals first within a changed block reads as "this became that".
  const ordered = removalsFirst(lines);
  return {
    lines: ordered,
    added: ordered.filter((line) => line.kind === 'added').length,
    removed: ordered.filter((line) => line.kind === 'removed').length,
    approximate,
  };
}

/** A run of unchanged lines folded away, or a line to show. */
export type DiffRow = DiffLine | { kind: 'fold'; count: number };

/** Keeps `context` unchanged lines around each change and folds the rest. */
export function foldUnchanged(lines: DiffLine[], context = 3): DiffRow[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.kind === 'same') return;
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) keep[k] = true;
  });
  const rows: DiffRow[] = [];
  let folded = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (folded > 0) rows.push({ kind: 'fold', count: folded });
      folded = 0;
      rows.push(line);
    } else {
      folded++;
    }
  });
  if (folded > 0) rows.push({ kind: 'fold', count: folded });
  return rows;
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  // A final newline ends the last line; it does not start an empty one.
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function removalsFirst(lines: DiffLine[]): DiffLine[] {
  const out: DiffLine[] = [];
  let removed: DiffLine[] = [];
  let added: DiffLine[] = [];
  const flush = () => {
    out.push(...removed, ...added);
    removed = [];
    added = [];
  };
  for (const line of lines) {
    if (line.kind === 'removed') removed.push(line);
    else if (line.kind === 'added') added.push(line);
    else {
      flush();
      out.push(line);
    }
  }
  flush();
  return out;
}
