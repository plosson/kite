/**
 * The owner's editing session, without React: the canvas as the owner sees it
 * right now, and undo and redo.
 *
 * An action is applied here at once (so the screen never waits on the network)
 * and its operations go to the save queue. Every id is made here, so the
 * server, given the same operations, ends up with exactly this document.
 *
 * Undo keeps the canvas before and after each action. Undoing sends the
 * operations that turn "after" back into "before", which name only what that
 * action touched: anything an agent wrote in the meantime stays. If what the
 * action touched is gone (an agent deleted the node), undo says so and does
 * nothing rather than guess.
 */
import {
  applyCanvasOps,
  canvasDiffOps,
  CanvasError,
  type CanvasDocument,
  type CanvasOp,
} from '@open-artifact/shared';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** n_…, e_… or a_… (node, edge, asset) with 12 random characters, the same shape the server makes. */
export function localId(prefix: 'n' | 'e' | 'a'): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let id = `${prefix}_`;
  for (const b of bytes) id += ALPHABET[b % ALPHABET.length];
  return id;
}

const context = () => ({ now: new Date().toISOString(), newId: localId });

/** Applies what still applies, one op at a time. For replaying unsaved work over a fresh read. */
export function applyBestEffort(doc: CanvasDocument, ops: CanvasOp[]): CanvasDocument {
  let current = doc;
  for (const op of ops) {
    try {
      current = applyCanvasOps(current, [op], context()).doc;
    } catch {
      // Gone or changed underneath; the server will refuse it too and say so.
    }
  }
  return current;
}

interface Entry {
  before: CanvasDocument;
  after: CanvasDocument;
}

export type ActResult = { ok: true; doc: CanvasDocument; ops: CanvasOp[] } | { ok: false; message: string };

export function createEditorState(limit = 100) {
  let undo: Entry[] = [];
  let redo: Entry[] = [];

  function apply(doc: CanvasDocument, ops: CanvasOp[]): ActResult {
    if (ops.length === 0) return { ok: false, message: 'Nothing to change.' };
    try {
      return { ok: true, doc: applyCanvasOps(doc, ops, context()).doc, ops };
    } catch (error) {
      return { ok: false, message: error instanceof CanvasError ? error.message : 'That change could not be made.' };
    }
  }

  return {
    /** A new action by the owner. Clears redo. */
    act(doc: CanvasDocument, ops: CanvasOp[]): ActResult {
      const result = apply(doc, ops);
      if (!result.ok) return result;
      undo.push({ before: doc, after: result.doc });
      if (undo.length > limit) undo = undo.slice(-limit);
      redo = [];
      return result;
    },
    undo(doc: CanvasDocument): ActResult {
      const entry = undo.pop();
      if (!entry) return { ok: false, message: 'Nothing to undo.' };
      const result = apply(doc, canvasDiffOps(entry.after, entry.before));
      if (!result.ok) return { ok: false, message: `Can’t undo that: the canvas changed since. (${result.message})` };
      redo.push({ before: entry.before, after: entry.after });
      return result;
    },
    redo(doc: CanvasDocument): ActResult {
      const entry = redo.pop();
      if (!entry) return { ok: false, message: 'Nothing to redo.' };
      const result = apply(doc, canvasDiffOps(entry.before, entry.after));
      if (!result.ok) return { ok: false, message: `Can’t redo that: the canvas changed since. (${result.message})` };
      undo.push(entry);
      return result;
    },
    get canUndo() {
      return undo.length > 0;
    },
    get canRedo() {
      return redo.length > 0;
    },
    clear() {
      undo = [];
      redo = [];
    },
  };
}
