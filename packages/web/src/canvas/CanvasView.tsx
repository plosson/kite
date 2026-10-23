/**
 * A canvas document, drawn with React Flow.
 *
 * Readers pan and zoom, and anybody who may comment can select a node and
 * comment on it. The owner also edits: add text, links, Kite documents and
 * groups, connect sides, resize, delete, undo and redo. Every edit is applied
 * to the owner's copy at once and sent as canvas operations
 * (POST /api/artifacts/:id/canvas/ops), coalesced so a drag is one version.
 * The server stays the source of truth: when the page's live stream says
 * somebody else changed the canvas (usually the owner's own agent), or after
 * a save that collided with them, it is read again and any unsaved work
 * replayed over it. Nodes that arrived that way are offered in a pill.
 *
 * Default export so Artifact.tsx can lazy-load it: React Flow is a separate
 * chunk that Markdown and HTML readers never download.
 */
import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  ConnectionMode,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  NodeResizer,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
  type OnBeforeDelete,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './canvas.css';
import {
  canvasDiffOps,
  findFreeSlot,
  isSafeCanvasUrl,
  type ArtifactSummary,
  type CanvasDocument,
  type CanvasNode,
  type CanvasOp,
  type CanvasSide,
  type CommentThread,
} from '@open-artifact/shared';
import { api, ApiError, endpoints } from '../api.js';
import { Button, Dialog, TextInput } from '../components/primitives.js';
import { Composer } from '../components/Comments.js';
import { LiveContext, useLiveEvents } from '../live.js';
import { createOpsQueue } from './ops-queue.js';
import { applyBestEffort, createEditorState, localId } from './editor-state.js';
import { edgeSides, flowNodes, isBigCanvas, linkHref, LOD } from './to-flow.js';
import type { CanvasMark } from './history.js';

type CanvasPayload = CanvasDocument & { kite: { version: number; docId: string } };

interface Marker {
  count: number;
  drifted: boolean;
  threadId: string;
}

interface NodeData extends Record<string, unknown> {
  node: CanvasNode;
  editable: boolean;
  /** Links leave through /leaving only on a public canvas, as Markdown does. */
  isPublic: boolean;
  parentOrigin: { x: number; y: number };
  marker?: Marker;
  autoEdit?: boolean;
  actions: NodeActions;
}

interface NodeActions {
  edit: (id: string, set: { text?: string; label?: string; url?: string }) => void;
  resize: (id: string, box: { x: number; y: number; width: number; height: number }) => void;
  openThread: (threadId: string) => void;
  editLink: (id: string) => void;
}

type KiteNode = Node<NodeData>;

const PRESET: Record<string, string> = {
  '1': '#e5484d',
  '2': '#f76b15',
  '3': '#ffc53d',
  '4': '#30a46c',
  '5': '#0090ff',
  '6': '#8e4ec6',
};

function colourOf(color: string | undefined): string | undefined {
  if (!color) return undefined;
  return PRESET[color] ?? color;
}

const SIDES = [
  ['top', Position.Top],
  ['right', Position.Right],
  ['bottom', Position.Bottom],
  ['left', Position.Left],
] as const;

/**
 * One handle per side, named after the side. The canvas connects in loose
 * mode, so any side can start or end an edge, which is what JSON Canvas means
 * by fromSide and toSide.
 */
function Handles({ editable }: { editable: boolean }) {
  return (
    <>
      {SIDES.map(([side, position]) => (
        <Handle
          key={side}
          id={side}
          type="source"
          position={position}
          isConnectable={editable}
          className="kite-handle"
          data-testid={`handle-${side}`}
        />
      ))}
    </>
  );
}

/**
 * Zoomed far out, a card is a coloured box: text nobody can read is the most
 * expensive thing on screen. The selector is a boolean, so a node re-renders
 * when the threshold is crossed, not on every frame of a zoom.
 */
const useFar = () => useStore((state) => state.transform[2] < LOD.far);

function CommentMarker({ marker, onOpen }: { marker: Marker; onOpen: (id: string) => void }) {
  return (
    <button
      type="button"
      className="nodrag absolute -right-2 -top-2 z-10 flex h-5 min-w-5 items-center justify-center gap-0.5 rounded-full px-1 text-[10px] font-semibold text-white shadow"
      style={{ background: marker.drifted ? '#f76b15' : 'var(--color-accent, #0090ff)' }}
      title={marker.drifted ? 'Commented. The node changed since the comment was written.' : 'Commented'}
      data-testid="canvas-comment-marker"
      data-drifted={marker.drifted ? 'true' : 'false'}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(marker.threadId);
      }}
    >
      <svg width="9" height="9" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M2 2h8v6H5L2 10.5z" fill="currentColor" />
      </svg>
      {marker.count}
    </button>
  );
}

function Frame({
  data,
  selected,
  children,
  minWidth = 60,
  minHeight = 40,
}: {
  data: NodeData;
  selected: boolean;
  children?: React.ReactNode;
  minWidth?: number;
  minHeight?: number;
}) {
  const { node, editable, marker, actions, parentOrigin } = data;
  const colour = colourOf(node.color);
  const far = useFar();
  return (
    <div
      className={far ? 'relative h-full w-full rounded-md border bg-surface' : 'relative h-full w-full rounded-md border bg-surface p-2 text-sm text-ink shadow-sm'}
      style={{ borderColor: colour ?? 'var(--color-line, #d4d4d8)' }}
      data-canvas-node={node.id}
    >
      {editable && (
        <NodeResizer
          isVisible={selected}
          minWidth={minWidth}
          minHeight={minHeight}
          onResizeEnd={(_event, box) =>
            actions.resize(node.id, { x: box.x + parentOrigin.x, y: box.y + parentOrigin.y, width: box.width, height: box.height })
          }
        />
      )}
      <Handles editable={editable} />
      {marker && <CommentMarker marker={marker} onOpen={actions.openThread} />}
      {far ? null : <div className="h-full w-full overflow-hidden">{children}</div>}
    </div>
  );
}

const TextNode = memo(function TextNode({ data, selected }: NodeProps<KiteNode>) {
  const { node, editable, actions, autoEdit } = data;
  const text = node.type === 'text' ? node.text : '';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);
  useEffect(() => {
    if (autoEdit && editable) setEditing(true);
  }, [autoEdit, editable]);

  return (
    <Frame data={data} selected={!!selected}>
      {editing ? (
        <textarea
          className="nodrag nowheel h-full w-full resize-none bg-transparent outline-none"
          autoFocus
          value={draft}
          aria-label="Text"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            setEditing(false);
            if (draft !== text) actions.edit(node.id, { text: draft });
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Escape') {
              setDraft(text);
              setEditing(false);
            }
          }}
        />
      ) : (
        <div
          className="h-full whitespace-pre-wrap break-words"
          onDoubleClick={editable ? () => setEditing(true) : undefined}
          title={editable ? 'Double-click to edit' : undefined}
        >
          {text || (editable ? <span className="text-ink-3 italic">Double-click to write</span> : null)}
        </div>
      )}
    </Frame>
  );
});

const LinkNode = memo(function LinkNode({ data, selected }: NodeProps<KiteNode>) {
  const { node, isPublic, editable, actions } = data;
  if (node.type !== 'link') return null;
  return (
    <Frame data={data} selected={!!selected}>
      <div className="flex h-full flex-col gap-1" onDoubleClick={editable ? () => actions.editLink(node.id) : undefined}>
        <span className="text-[11px] uppercase tracking-wide text-ink-3">Link</span>
        <a
          className="nodrag break-all text-accent underline"
          href={linkHref(node.url, isPublic)}
          target="_blank"
          rel="noopener noreferrer"
        >
          {node.url}
        </a>
      </div>
    </Frame>
  );
});

const GroupNode = memo(function GroupNode({ data, selected }: NodeProps<KiteNode>) {
  const { node, editable, actions, marker, parentOrigin } = data;
  const colour = colourOf(node.color);
  const label = node.type === 'group' ? (node.label ?? '') : '';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);
  useEffect(() => setDraft(label), [label]);
  useEffect(() => {
    if (data.autoEdit && editable) setEditing(true);
  }, [data.autoEdit, editable]);
  const far = useFar();
  return (
    <div
      className="relative h-full w-full rounded-lg border-2 border-dashed"
      style={{ borderColor: colour ?? 'var(--color-line, #d4d4d8)', background: colour ? `${colour}10` : 'transparent' }}
      data-canvas-node={node.id}
    >
      {editable && (
        <NodeResizer
          isVisible={!!selected}
          minWidth={120}
          minHeight={80}
          onResizeEnd={(_event, box) =>
            actions.resize(node.id, { x: box.x + parentOrigin.x, y: box.y + parentOrigin.y, width: box.width, height: box.height })
          }
        />
      )}
      <Handles editable={editable} />
      {marker && <CommentMarker marker={marker} onOpen={actions.openThread} />}
      {editing ? (
        <input
          className="nodrag m-1 rounded border border-line bg-surface px-1 text-xs"
          autoFocus
          value={draft}
          aria-label="Group name"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            setEditing(false);
            if (draft !== label) actions.edit(node.id, { label: draft });
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
            if (event.key === 'Escape') {
              setDraft(label);
              setEditing(false);
            }
          }}
        />
      ) : (
        !far && (
          <div
            className="px-2 py-1 text-xs font-semibold text-muted"
            onDoubleClick={editable ? () => setEditing(true) : undefined}
            title={editable ? 'Double-click to rename' : undefined}
          >
            {label || (editable ? <span className="italic text-ink-3">Group</span> : null)}
          </div>
        )
      )}
    </div>
  );
});

interface KiteCardInfo {
  title: string;
  slug: string;
  type: string;
}

/** The sanitised HTML the server renders for a Markdown document, as the reader page uses. */
function MarkdownPreview({ slug }: { slug: string }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/a/${encodeURIComponent(slug)}/content`, { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.text() : ''))
      .then((body) => live && setHtml(body))
      .catch(() => live && setHtml(''));
    return () => {
      live = false;
    };
  }, [slug]);
  if (html === null) return <div className="text-muted">…</div>;
  return (
    <div
      className="prose kite-prose nodrag nowheel h-[calc(100%-1.75rem)] overflow-y-auto"
      data-testid="canvas-markdown-preview"
      // Same source and same sanitiser as the document page's own rendering.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** A reference to another Kite document, resolved for THIS reader. */
const KitePreviewNode = memo(function KitePreviewNode({ data, selected }: NodeProps<KiteNode>) {
  const { node } = data;
  const ref = node.kite?.ref;
  const far = useFar();
  const [info, setInfo] = useState<KiteCardInfo | null | 'hidden'>(null);
  useEffect(() => {
    // Not fetched while it is a coloured box: a zoomed-out canvas of 2,000
    // cards would otherwise ask for 2,000 documents.
    if (!ref || far || info) return;
    let live = true;
    api<KiteCardInfo>(`/api/artifacts/${ref}`)
      .then((found) => live && setInfo({ title: found.title, slug: found.slug, type: found.type }))
      // 404 is "not yours to open", and the canvas must not say more than that.
      .catch(() => live && setInfo('hidden'));
    return () => {
      live = false;
    };
  }, [ref, far, info]);

  let body: React.ReactNode;
  if (info === 'hidden' || !ref) body = <div className="text-muted italic">A document you can’t open</div>;
  else if (!info) body = <div className="text-muted">…</div>;
  else {
    const preview = node.kite?.view === 'preview';
    body = (
      <>
        <a className="nodrag mb-1 block truncate font-semibold underline" href={`/a/${info.slug}`}>
          {info.title}
        </a>
        {preview && info.type === 'markdown' && <MarkdownPreview slug={info.slug} />}
        {preview && info.type === 'html' && (
          <iframe
            title={info.title}
            src={`/a/${info.slug}/content`}
            sandbox="allow-scripts"
            className="nodrag nowheel h-[calc(100%-1.75rem)] w-full rounded border-0 bg-white"
          />
        )}
        {(!preview || info.type === 'canvas') && (
          <div className="text-xs text-ink-3">{info.type === 'canvas' ? 'Canvas' : info.type === 'html' ? 'HTML page' : 'Document'}</div>
        )}
      </>
    );
  }
  return (
    <Frame data={data} selected={!!selected}>
      {body}
    </Frame>
  );
});

// Not 'group': React Flow styles a node of that type itself.
const NODE_TYPES = { text: TextNode, link: LinkNode, kgroup: GroupNode, kite: KitePreviewNode };

function flowTypeOf(node: CanvasNode): keyof typeof NODE_TYPES {
  if (node.kite?.kind === 'kite') return 'kite';
  switch (node.type) {
    case 'text':
      return 'text';
    case 'link':
      return 'link';
    case 'group':
      return 'kgroup';
  }
}

export interface CanvasViewProps {
  artifactId: string;
  editable: boolean;
  isPublic?: boolean;
  canComment?: boolean;
  threads?: CommentThread[];
  activeThreadId?: string | null;
  revealCount?: number;
  onNewThread?: () => void;
  onRevealThread?: (threadId: string) => void;
  /** For a past version: shown as it was, nothing editable, nothing saved. */
  fixed?: CanvasDocument;
  /** For History's Changes: what happened to each node or edge, drawn on it. */
  marks?: Record<string, CanvasMark>;
}


export default function CanvasView(props: CanvasViewProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}

/** One empty list for every render, so a canvas shown without comments does not rebuild itself forever. */
const NO_THREADS: CommentThread[] = [];

function CanvasInner({
  artifactId,
  editable: editableProp,
  isPublic = false,
  canComment = false,
  threads = NO_THREADS,
  activeThreadId = null,
  revealCount = 0,
  onNewThread,
  onRevealThread,
  fixed,
  marks,
}: CanvasViewProps) {
  const editable = editableProp && !fixed;
  const flow = useReactFlow<KiteNode, Edge>();
  const wrapper = useRef<HTMLDivElement>(null);
  const [local, setLocal] = useState<CanvasDocument | null>(fixed ?? null);
  const localRef = useRef<CanvasDocument | null>(fixed ?? null);
  const [version, setVersion] = useState(0);
  const versionRef = useRef(0);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [incoming, setIncoming] = useState<string[]>([]);
  const [autoEdit, setAutoEdit] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | { kind: 'link'; id?: string } | { kind: 'kite' } | { kind: 'edge'; id: string }>(null);
  const [composing, setComposing] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const editor = useMemo(() => createEditorState(), []);
  const queueRef = useRef<ReturnType<typeof createOpsQueue> | null>(null);

  const commit = useCallback((doc: CanvasDocument) => {
    localRef.current = doc;
    setLocal(doc);
    setTick((t) => t + 1);
  }, []);

  const load = useCallback(async () => {
    const next = await api<CanvasPayload>(`/api/artifacts/${artifactId}/canvas`);
    // Two reads can be in the air at once; the older one must not win by
    // arriving last, nor undo a save that already went through on top of it.
    if (next.kite.version < versionRef.current) return versionRef.current;
    const known = new Set((localRef.current?.nodes ?? []).map((n) => n.id));
    const first = localRef.current === null;
    versionRef.current = next.kite.version;
    setVersion(next.kite.version);
    const rebased = applyBestEffort({ nodes: next.nodes, edges: next.edges }, queueRef.current?.unsaved() ?? []);
    if (!first) {
      const arrived = rebased.nodes.filter((n) => !known.has(n.id)).map((n) => n.id);
      if (arrived.length > 0) setIncoming((current) => [...new Set([...current, ...arrived])]);
    }
    commit(rebased);
    return next.kite.version;
  }, [artifactId, commit]);

  const queue = useMemo(() => {
    const q = createOpsQueue({
      getVersion: () => versionRef.current,
      reload: load,
      send: (baseVersion, ops) =>
        api<{ version: number }>(`/api/artifacts/${artifactId}/canvas/ops`, {
          method: 'POST',
          body: JSON.stringify({ baseVersion, ops }),
        }),
      onSaved: (saved) => {
        versionRef.current = Math.max(versionRef.current, saved);
        setVersion(versionRef.current);
        setStatus(q.size > 0 ? 'saving' : 'saved');
      },
      onError: (error) => {
        setStatus('error');
        setFailure(error instanceof ApiError ? error.message : 'Could not save the canvas.');
        void load();
      },
    });
    queueRef.current = q;
    return q;
  }, [artifactId, load]);

  /*
   * Following somebody else's changes, as the page's live stream reports them.
   *
   * Only the newest version matters, so a burst of changes is one read at a
   * time until the canvas has caught up rather than one read per change. The
   * stream also says where things stand when it (re)connects, which is how a
   * canvas that was offline for a while catches up, and the version it knows
   * is checked once the first read lands, for a change that came in between.
   */
  const live = useContext(LiveContext);
  const wanted = useRef(0);
  const catchingUp = useRef(false);
  const catchUp = useCallback(
    async (version: number) => {
      wanted.current = Math.max(wanted.current, version);
      if (fixed || catchingUp.current || localRef.current === null) return;
      catchingUp.current = true;
      try {
        while (wanted.current > versionRef.current) {
          if ((await load()) < wanted.current) break;
        }
      } catch {
        // The stream will say when there is something newer; nothing to retry here.
      } finally {
        catchingUp.current = false;
      }
    },
    [fixed, load],
  );

  useLiveEvents(live, (event) => {
    if (event.type === 'ready' || (event.type === 'change' && event.kind === 'content' && event.version !== null)) {
      void catchUp(event.version ?? 0);
    }
  });

  /** Read, not depended on: the stream arriving later must not mean a second first read. */
  const liveRef = useRef(live);
  liveRef.current = live;

  useEffect(() => {
    if (fixed) return;
    load()
      .then(() => catchUp(liveRef.current?.version ?? 0))
      .catch((error: unknown) => setFailure(error instanceof ApiError ? error.message : 'Could not load the canvas.'));
  }, [load, fixed, catchUp]);

  // Leaving the page should not drop a drag that has not been sent yet.
  useEffect(() => () => void queue.flush(), [queue]);

  const act = useCallback(
    (ops: CanvasOp[]) => {
      const doc = localRef.current;
      if (!doc || ops.length === 0) return false;
      const result = editor.act(doc, ops);
      if (!result.ok) {
        setNotice(result.message);
        return false;
      }
      commit(result.doc);
      setStatus('saving');
      setNotice(null);
      queue.pushAll(result.ops);
      return true;
    },
    [commit, editor, queue],
  );

  const undoRedo = useCallback(
    (which: 'undo' | 'redo') => {
      const doc = localRef.current;
      if (!doc) return;
      const result = which === 'undo' ? editor.undo(doc) : editor.redo(doc);
      if (!result.ok) {
        setNotice(result.message);
        setTick((t) => t + 1);
        return;
      }
      commit(result.doc);
      setStatus('saving');
      setNotice(null);
      queue.pushAll(result.ops);
    },
    [commit, editor, queue],
  );

  const actions = useMemo<NodeActions>(
    () => ({
      edit: (id, set) => {
        const ops: CanvasOp[] = [];
        if (set.label !== undefined && set.label.trim() === '') ops.push({ op: 'update', id, unset: ['label'] });
        else ops.push({ op: 'update', id, set });
        act(ops);
        setAutoEdit(null);
      },
      resize: (id, box) => {
        const doc = localRef.current;
        if (!doc) return;
        const desired: CanvasDocument = {
          ...doc,
          nodes: doc.nodes.map((n) =>
            n.id === id ? { ...n, x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) } : n,
          ),
        };
        // Diffed rather than sent as a move: a group moved by its top-left
        // handle must not carry its members along.
        act(canvasDiffOps(doc, desired));
      },
      openThread: (threadId) => onRevealThread?.(threadId),
      editLink: (id) => setDialog({ kind: 'link', id }),
    }),
    [act, onRevealThread],
  );

  // Comment markers, one per node, from open threads.
  const markers = useMemo(() => {
    const map = new Map<string, Marker>();
    for (const thread of threads) {
      if (thread.status !== 'open' || thread.anchor.kind !== 'node' || thread.anchorLost) continue;
      const current = map.get(thread.anchor.nodeId);
      map.set(thread.anchor.nodeId, {
        count: (current?.count ?? 0) + 1,
        drifted: (current?.drifted ?? false) || thread.anchorDrifted,
        threadId: current?.threadId ?? thread.id,
      });
    }
    return map;
  }, [threads]);
  const lostThreads = threads.filter((t) => t.status === 'open' && t.anchor.kind === 'node' && t.anchorLost);
  const activeNodeId = useMemo(() => {
    const thread = threads.find((t) => t.id === activeThreadId);
    return thread?.anchor.kind === 'node' && !thread.anchorLost ? thread.anchor.nodeId : null;
  }, [threads, activeThreadId]);

  const zoom = useStore((state) => state.transform[2]);
  const far = zoom < LOD.far;
  const showLabels = zoom >= LOD.labels;
  const big = local ? isBigCanvas(local) : false;

  const built = useMemo(() => {
    if (!local) return { nodes: [] as KiteNode[], edges: [] as Edge[] };
    const byId = new Map(local.nodes.map((n) => [n.id, n]));
    const nodes: KiteNode[] = flowNodes(local).map((shape) => ({
      id: shape.id,
      type: flowTypeOf(shape.node),
      position: shape.position,
      ...(shape.parentId ? { parentId: shape.parentId } : {}),
      width: shape.node.width,
      height: shape.node.height,
      style: { width: shape.node.width, height: shape.node.height },
      draggable: editable,
      connectable: editable,
      ...(activeNodeId === shape.id || marks?.[shape.id]
        ? { className: [activeNodeId === shape.id ? 'kite-highlighted' : '', marks?.[shape.id] ? `kite-mark-${marks[shape.id]}` : ''].join(' ').trim() }
        : {}),
      data: {
        node: shape.node,
        editable,
        isPublic,
        parentOrigin: shape.parentOrigin,
        marker: markers.get(shape.id),
        autoEdit: autoEdit === shape.id,
        actions,
      },
    }));
    const edges: Edge[] = local.edges.map((edge) => {
      const sides = edgeSides(edge, byId);
      const colour = colourOf(edge.color);
      return {
        id: edge.id,
        source: edge.fromNode,
        target: edge.toNode,
        sourceHandle: sides.fromSide,
        targetHandle: sides.toSide,
        label: showLabels ? edge.label : undefined,
        // On a big canvas zoomed out, edges are the dearest thing to draw and nobody can follow them.
        hidden: big && far,
        ...(marks?.[edge.id] ? { className: `kite-mark-${marks[edge.id]}` } : {}),
        style: colour ? { stroke: colour } : undefined,
        markerEnd: edge.toEnd === 'none' ? undefined : { type: MarkerType.ArrowClosed, ...(colour ? { color: colour } : {}) },
        markerStart: edge.fromEnd === 'arrow' ? { type: MarkerType.ArrowClosed } : undefined,
      };
    });
    return { nodes, edges };
  }, [local, editable, isPublic, markers, autoEdit, actions, showLabels, big, far, activeNodeId, marks]);

  const [nodes, setNodes] = useState<KiteNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  useEffect(() => {
    setNodes((current) => {
      const selected = new Set(current.filter((n) => n.selected).map((n) => n.id));
      return built.nodes.map((n) => (selected.has(n.id) ? { ...n, selected: true } : n));
    });
  }, [built.nodes]);
  useEffect(() => {
    setEdges((current) => {
      const selected = new Set(current.filter((e) => e.selected).map((e) => e.id));
      return built.edges.map((e) => (selected.has(e.id) ? { ...e, selected: true } : e));
    });
  }, [built.edges]);

  const onNodesChange = useCallback(
    (changes: NodeChange<KiteNode>[]) => setNodes((current) => applyNodeChanges(changes, current)),
    [],
  );
  const onEdgesChange = useCallback((changes: EdgeChange[]) => setEdges((current) => applyEdgeChanges(changes, current)), []);

  const absolute = useCallback(
    (id: string) => {
      const internal = flow.getInternalNode(id);
      return internal?.internals.positionAbsolute ?? { x: 0, y: 0 };
    },
    [flow],
  );

  const onNodeDragStop = useCallback(
    (_event: unknown, _node: KiteNode, dragged: KiteNode[]) => {
      const doc = localRef.current;
      if (!doc) return;
      const ops: CanvasOp[] = [];
      // Outer groups first, so a group carrying a member never undoes the member's own move.
      const sorted = [...dragged].sort((a, b) => Number(b.type === 'kgroup') - Number(a.type === 'kgroup'));
      for (const node of sorted) {
        const at = absolute(node.id);
        const before = doc.nodes.find((n) => n.id === node.id);
        const x = Math.round(at.x);
        const y = Math.round(at.y);
        if (before && (before.x !== x || before.y !== y)) ops.push({ op: 'move', id: node.id, x, y });
      }
      if (ops.length > 0) act(ops);
    },
    [absolute, act],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      act([
        {
          op: 'connect',
          id: localId('e'),
          from: connection.source,
          to: connection.target,
          ...(connection.sourceHandle ? { fromSide: connection.sourceHandle as CanvasSide } : {}),
          ...(connection.targetHandle ? { toSide: connection.targetHandle as CanvasSide } : {}),
        },
      ]);
    },
    [act],
  );

  // Deleting a group deletes the group, not what is inside it (React Flow
  // would take the children too). And a node takes its own edges.
  const onBeforeDelete = useCallback<OnBeforeDelete<KiteNode, Edge>>(
    async ({ nodes: gone, edges: goneEdges }) => {
      const nodeIds = gone.filter((n) => n.selected).map((n) => n.id);
      const doc = localRef.current;
      const attached = new Set(
        (doc?.edges ?? []).filter((e) => nodeIds.includes(e.fromNode) || nodeIds.includes(e.toNode)).map((e) => e.id),
      );
      const edgeIds = goneEdges.filter((e) => e.selected && !attached.has(e.id)).map((e) => e.id);
      act([...edgeIds.map((id) => ({ op: 'disconnect', id }) as CanvasOp), ...nodeIds.map((id) => ({ op: 'delete', id }) as CanvasOp)]);
      return false;
    },
    [act],
  );

  /** The middle of what is on screen, in canvas coordinates. */
  const viewCentre = useCallback(() => {
    const rect = wrapper.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return flow.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  }, [flow]);

  const addNode = useCallback(
    (node: { type: 'text' | 'link' | 'group'; width: number; height: number } & Record<string, unknown>, edit = false) => {
      const doc = localRef.current;
      if (!doc) return;
      const centre = viewCentre();
      const at = findFreeSlot(doc, { x: centre.x - node.width / 2, y: centre.y - node.height / 2 }, node);
      const id = localId('n');
      if (act([{ op: 'add', id, node: { ...node, x: at.x, y: at.y } } as CanvasOp])) {
        if (edit) setAutoEdit(id);
        // The free slot can be past what is on screen; bring the new node into view.
        const rect = wrapper.current?.getBoundingClientRect();
        if (rect) {
          const topLeft = flow.screenToFlowPosition({ x: rect.left, y: rect.top });
          const bottomRight = flow.screenToFlowPosition({ x: rect.right, y: rect.bottom });
          const inside =
            at.x >= topLeft.x && at.y >= topLeft.y && at.x + node.width <= bottomRight.x && at.y + node.height <= bottomRight.y;
          if (!inside) flow.setCenter(at.x + node.width / 2, at.y + node.height / 2, { zoom: flow.getZoom(), duration: 200 });
        }
        setNodes((current) => current.map((n) => ({ ...n, selected: n.id === id })));
      }
    },
    [act, viewCentre, flow],
  );

  const addGroup = useCallback(() => {
    const doc = localRef.current;
    if (!doc) return;
    const chosen = nodes.filter((n) => n.selected).map((n) => doc.nodes.find((d) => d.id === n.id)).filter(Boolean) as CanvasNode[];
    if (chosen.length === 0) {
      addNode({ type: 'group', label: 'Group', width: 600, height: 400 }, true);
      return;
    }
    const x = Math.min(...chosen.map((n) => n.x)) - 30;
    const y = Math.min(...chosen.map((n) => n.y)) - 50;
    const right = Math.max(...chosen.map((n) => n.x + n.width)) + 30;
    const bottom = Math.max(...chosen.map((n) => n.y + n.height)) + 30;
    const id = localId('n');
    if (act([{ op: 'add', id, node: { type: 'group', label: 'Group', x, y, width: right - x, height: bottom - y } }])) setAutoEdit(id);
  }, [act, addNode, nodes]);

  // Keyboard: undo and redo, unless somebody is typing.
  useEffect(() => {
    if (!editable) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.closest('input, textarea, [contenteditable="true"]') || target.closest('dialog'))) return;
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault();
        undoRedo('undo');
      } else if ((key === 'z' && event.shiftKey) || key === 'y') {
        event.preventDefault();
        undoRedo('redo');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editable, undoRedo]);

  // Pressing a thread in the panel goes to its node.
  useEffect(() => {
    if (revealCount === 0 || !activeNodeId) return;
    const node = localRef.current?.nodes.find((n) => n.id === activeNodeId);
    if (node) void flow.fitView({ nodes: [{ id: node.id }], duration: 300, maxZoom: 1.2, padding: 0.4 });
  }, [revealCount, activeNodeId, flow]);

  const selectedNodes = nodes.filter((n) => n.selected);
  const commentTarget = selectedNodes.length === 1 ? selectedNodes[0]!.id : null;

  if (failure && !local) {
    return <div className="p-6 text-sm text-danger">{failure}</div>;
  }

  return (
    <div
      ref={wrapper}
      className={`kite-canvas relative h-full min-h-[480px] w-full${editable ? ' is-editable' : ''}`}
      data-testid="canvas-view"
      data-version={version}
    >
      <ReactFlow<KiteNode, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={editable ? onNodeDragStop : undefined}
        onConnect={editable ? onConnect : undefined}
        onBeforeDelete={editable ? onBeforeDelete : undefined}
        onEdgeDoubleClick={editable ? (_event, edge) => setDialog({ kind: 'edge', id: edge.id }) : undefined}
        deleteKeyCode={editable ? ['Delete', 'Backspace'] : null}
        connectionMode={ConnectionMode.Loose}
        nodesDraggable={editable}
        nodesConnectable={editable}
        edgesFocusable={editable}
        elementsSelectable={editable || canComment}
        onlyRenderVisibleElements
        fitView
        // Fitting 2,000 nodes on screen draws all of them; a big canvas opens close enough for culling to work.
        fitViewOptions={big ? { minZoom: LOD.bigOpenZoom } : undefined}
        minZoom={0.05}
        proOptions={{ hideAttribution: false }}
      >
        <Background />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable />
        {(editable || canComment) && (
          <Panel position="top-left">
            <div className="flex flex-wrap items-center gap-1 rounded-md border border-line bg-surface p-1 shadow-sm" data-testid="canvas-toolbar">
              {editable && (
                <>
                  <Button size="sm" tone="ghost" onClick={() => addNode({ type: 'text', text: '', width: 260, height: 140 }, true)}>
                    + Text
                  </Button>
                  <Button size="sm" tone="ghost" onClick={() => setDialog({ kind: 'link' })}>
                    + Link
                  </Button>
                  <Button size="sm" tone="ghost" onClick={() => setDialog({ kind: 'kite' })}>
                    + Document
                  </Button>
                  <Button size="sm" tone="ghost" onClick={addGroup} title="Wraps the selected nodes, or adds an empty group">
                    + Group
                  </Button>
                  <span className="mx-1 h-4 w-px bg-line" />
                  <Button size="sm" tone="ghost" disabled={!editor.canUndo} onClick={() => undoRedo('undo')} aria-label="Undo" title="Undo (Ctrl/⌘ Z)">
                    Undo
                  </Button>
                  <Button size="sm" tone="ghost" disabled={!editor.canRedo} onClick={() => undoRedo('redo')} aria-label="Redo" title="Redo (Ctrl/⌘ Shift Z)">
                    Redo
                  </Button>
                </>
              )}
              {canComment && (
                <>
                  {editable && <span className="mx-1 h-4 w-px bg-line" />}
                  <Button
                    size="sm"
                    tone="ghost"
                    disabled={!commentTarget}
                    onClick={() => setComposing(commentTarget)}
                    title={commentTarget ? 'Comment on the selected node' : 'Select one node to comment on it'}
                  >
                    Comment
                  </Button>
                </>
              )}
              {lostThreads.length > 0 && (
                <button
                  type="button"
                  className="ml-1 rounded px-1.5 text-[12px] text-danger underline"
                  data-testid="canvas-lost-comments"
                  onClick={() => onRevealThread?.(lostThreads[0]!.id)}
                  title="These comments were about nodes that were deleted"
                >
                  {lostThreads.length === 1 ? '1 comment lost its node' : `${lostThreads.length} comments lost their nodes`}
                </button>
              )}
            </div>
          </Panel>
        )}
        {incoming.length > 0 && (
          <Panel position="bottom-center">
            <div className="flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-[12.5px] shadow" data-testid="canvas-incoming">
              {incoming.length === 1 ? '1 new node' : `${incoming.length} new nodes`}
              <Button
                size="sm"
                tone="primary"
                onClick={() => {
                  void flow.fitView({ nodes: incoming.map((id) => ({ id })), duration: 300, maxZoom: 1, padding: 0.3 });
                  setIncoming([]);
                }}
              >
                Show
              </Button>
              <Button size="sm" tone="ghost" onClick={() => setIncoming([])} aria-label="Dismiss">
                ×
              </Button>
            </div>
          </Panel>
        )}
        {composing && (
          <Panel position="top-center">
            <div className="w-[320px] rounded-md border border-line bg-surface p-2 shadow" data-testid="canvas-composer">
              <Composer
                placeholder="Comment on this node…"
                onCancel={() => setComposing(null)}
                onSubmit={async (body) => {
                  const thread = await endpoints.startThread(artifactId, body, { nodeId: composing }, versionRef.current || undefined);
                  setComposing(null);
                  onNewThread?.();
                  onRevealThread?.(thread.id);
                }}
              />
            </div>
          </Panel>
        )}
      </ReactFlow>
      {editable && status !== 'idle' && (
        <div className="absolute right-3 top-3 rounded bg-surface px-2 py-1 text-xs text-muted shadow" data-testid="canvas-status">
          {status === 'saving' ? 'Saving…' : status === 'saved' ? `Saved · v${version}` : failure}
        </div>
      )}
      {notice && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded bg-surface px-3 py-1.5 text-xs text-danger shadow" role="status" data-testid="canvas-notice">
          {notice}
        </div>
      )}
      {editable && dialog?.kind === 'link' && (
        <LinkDialog
          initial={dialog.id ? ((local?.nodes.find((n) => n.id === dialog.id) as { url?: string } | undefined)?.url ?? '') : ''}
          onClose={() => setDialog(null)}
          onSave={(url) => {
            if (dialog.id) act([{ op: 'update', id: dialog.id, set: { url } }]);
            else addNode({ type: 'link', url, width: 320, height: 120 });
            setDialog(null);
          }}
        />
      )}
      {editable && dialog?.kind === 'kite' && (
        <KitePicker
          exclude={artifactId}
          onClose={() => setDialog(null)}
          onPick={(artifact, view) => {
            addNode({
              type: 'link',
              url: artifact.url,
              width: view === 'preview' ? 420 : 320,
              height: view === 'preview' ? 360 : 110,
              kite: { kind: 'kite', ref: artifact.id, view },
            });
            setDialog(null);
          }}
        />
      )}
      {editable && dialog?.kind === 'edge' && (
        <EdgeDialog
          initial={local?.edges.find((e) => e.id === dialog.id)?.label ?? ''}
          onClose={() => setDialog(null)}
          onSave={(label) => {
            act([label.trim() ? { op: 'update', id: dialog.id, set: { label } } : { op: 'update', id: dialog.id, unset: ['label'] }]);
            setDialog(null);
          }}
          onDelete={() => {
            act([{ op: 'disconnect', id: dialog.id }]);
            setDialog(null);
          }}
        />
      )}
    </div>
  );
}

function LinkDialog({ initial, onClose, onSave }: { initial: string; onClose: () => void; onSave: (url: string) => void }) {
  const [url, setUrl] = useState(initial);
  const ok = isSafeCanvasUrl(url.trim());
  return (
    <Dialog
      open
      onClose={onClose}
      title={initial ? 'Edit link' : 'Add a link'}
      footer={
        <>
          <Button tone="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button tone="primary" disabled={!ok} onClick={() => onSave(url.trim())}>
            {initial ? 'Save' : 'Add'}
          </Button>
        </>
      }
    >
      <TextInput
        autoFocus
        placeholder="https://…"
        value={url}
        aria-label="Link address"
        onChange={(event) => setUrl(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && ok) onSave(url.trim());
        }}
      />
      {url.trim() !== '' && !ok && <p className="mt-1 text-[12px] text-danger">Use an http or https address.</p>}
    </Dialog>
  );
}

function EdgeDialog({
  initial,
  onClose,
  onSave,
  onDelete,
}: {
  initial: string;
  onClose: () => void;
  onSave: (label: string) => void;
  onDelete: () => void;
}) {
  const [label, setLabel] = useState(initial);
  return (
    <Dialog
      open
      onClose={onClose}
      title="Edge"
      footer={
        <>
          <Button tone="danger" onClick={onDelete}>
            Remove edge
          </Button>
          <span className="flex-1" />
          <Button tone="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button tone="primary" onClick={() => onSave(label)}>
            Save
          </Button>
        </>
      }
    >
      <TextInput
        autoFocus
        placeholder="Label (optional)"
        value={label}
        aria-label="Edge label"
        onChange={(event) => setLabel(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onSave(label);
        }}
      />
    </Dialog>
  );
}

function KitePicker({
  exclude,
  onClose,
  onPick,
}: {
  exclude: string;
  onClose: () => void;
  onPick: (artifact: ArtifactSummary, view: 'card' | 'preview') => void;
}) {
  const [all, setAll] = useState<ArtifactSummary[] | null>(null);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'card' | 'preview'>('card');
  useEffect(() => {
    endpoints
      .myArtifacts()
      .then((response) => setAll(response.artifacts.filter((a) => a.id !== exclude)))
      .catch(() => setAll([]));
  }, [exclude]);
  const shown = (all ?? []).filter((a) => a.title.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 50);
  return (
    <Dialog open onClose={onClose} title="Add a Kite document" description="Readers who can’t open it see that it is there, and nothing else." width={520}>
      <div className="flex flex-col gap-2">
        <TextInput autoFocus placeholder="Search your documents" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search documents" />
        <div className="flex gap-3 text-[12.5px]">
          <label className="flex items-center gap-1">
            <input type="radio" checked={view === 'card'} onChange={() => setView('card')} /> Card
          </label>
          <label className="flex items-center gap-1">
            <input type="radio" checked={view === 'preview'} onChange={() => setView('preview')} /> Preview
          </label>
        </div>
        <ul className="max-h-[320px] overflow-y-auto" data-testid="kite-picker-list">
          {all === null && <li className="text-ink-3">Loading…</li>}
          {all !== null && shown.length === 0 && <li className="text-ink-3">No documents match.</li>}
          {shown.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                className="w-full rounded px-2 py-1.5 text-left text-[13px] hover:bg-sunken"
                onClick={() => onPick(a, view)}
              >
                <span className="font-medium">{a.title}</span>
                <span className="ml-2 text-[11px] text-ink-3">{a.type}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}
