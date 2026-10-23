/**
 * A canvas document, drawn with React Flow.
 *
 * Readers can pan and zoom. The owner can also drag nodes and double-click text
 * to edit it; both go through POST /api/artifacts/:id/canvas/ops, coalesced so a
 * drag is one version, and re-read afterwards so the server stays the source of
 * truth (it moves a group's members with it, for example).
 *
 * Default export so Artifact.tsx can lazy-load it: React Flow is a separate
 * chunk that Markdown and HTML readers never download.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useStore,
  applyNodeChanges,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { CanvasDocument, CanvasNode } from '@open-artifact/shared';
import { api, ApiError } from '../api.js';
import { createOpsQueue, type QueuedOp } from './ops-queue.js';

type CanvasPayload = CanvasDocument & { kite: { version: number; docId: string } };

interface NodeData extends Record<string, unknown> {
  node: CanvasNode;
  editable: boolean;
  onEdit: (id: string, set: { text?: string; label?: string }) => void;
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

function colourOf(node: CanvasNode): string | undefined {
  if (!node.color) return undefined;
  return PRESET[node.color] ?? node.color;
}

const SIDES = [
  ['top', Position.Top],
  ['right', Position.Right],
  ['bottom', Position.Bottom],
  ['left', Position.Left],
] as const;

/** Edges in JSON Canvas name a side; React Flow needs a handle there. Invisible. */
function Handles() {
  return (
    <>
      {SIDES.map(([side, position]) => (
        <span key={side}>
          <Handle id={`s-${side}`} type="source" position={position} isConnectable={false} style={{ opacity: 0 }} />
          <Handle id={`t-${side}`} type="target" position={position} isConnectable={false} style={{ opacity: 0 }} />
        </span>
      ))}
    </>
  );
}

/**
 * Zoomed far out, a card is a coloured box: text nobody can read is the most
 * expensive thing on screen. The selector is a boolean, so a node re-renders
 * when the threshold is crossed, not on every frame of a zoom.
 */
const FAR = 0.35;
const useFar = () => useStore((state) => state.transform[2] < FAR);

function Frame({ node, children }: { node: CanvasNode; children: React.ReactNode }) {
  const colour = colourOf(node);
  const far = useFar();
  if (far) {
    return (
      <div
        className="h-full w-full rounded-md border bg-surface"
        style={{ borderColor: colour ?? 'var(--color-line, #d4d4d8)' }}
        data-canvas-node={node.id}
      >
        <Handles />
      </div>
    );
  }
  return (
    <div
      className="h-full w-full overflow-hidden rounded-md border bg-surface p-2 text-sm text-ink shadow-sm"
      style={{ borderColor: colour ?? 'var(--color-line, #d4d4d8)' }}
      data-canvas-node={node.id}
    >
      <Handles />
      {children}
    </div>
  );
}

const TextNode = memo(function TextNode({ data }: NodeProps<KiteNode>) {
  const { node, editable, onEdit } = data;
  const text = node.type === 'text' ? node.text : '';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);

  if (editing) {
    return (
      <Frame node={node}>
        <textarea
          className="nodrag h-full w-full resize-none bg-transparent outline-none"
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            setEditing(false);
            if (draft !== text) onEdit(node.id, { text: draft });
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setDraft(text);
              setEditing(false);
            }
          }}
        />
      </Frame>
    );
  }
  return (
    <Frame node={node}>
      <div
        className="h-full whitespace-pre-wrap break-words"
        onDoubleClick={editable ? () => setEditing(true) : undefined}
        title={editable ? 'Double-click to edit' : undefined}
      >
        {text}
      </div>
    </Frame>
  );
});

const LinkNode = memo(function LinkNode({ data }: NodeProps<KiteNode>) {
  const { node } = data;
  if (node.type !== 'link') return null;
  // Always through the interstitial: a canvas link is a stranger's link until
  // proven otherwise, and the spike does not distinguish public from shared.
  const href = `/leaving?to=${encodeURIComponent(node.url)}`;
  return (
    <Frame node={node}>
      <a className="nodrag break-all text-accent underline" href={href} target="_blank" rel="noopener noreferrer">
        {node.url}
      </a>
    </Frame>
  );
});

const GroupNode = memo(function GroupNode({ data }: NodeProps<KiteNode>) {
  const { node } = data;
  const colour = colourOf(node);
  const label = node.type === 'group' ? node.label : undefined;
  return (
    <div
      className="h-full w-full rounded-lg border-2 border-dashed"
      style={{ borderColor: colour ?? 'var(--color-line, #d4d4d8)', background: 'transparent' }}
      data-canvas-node={node.id}
    >
      <Handles />
      {label && <div className="px-2 py-1 text-xs font-semibold text-muted">{label}</div>}
    </div>
  );
});

interface KiteCardInfo {
  title: string;
  slug: string;
}

/** A reference to another Kite document, resolved for THIS reader. */
const KitePreviewNode = memo(function KitePreviewNode({ data }: NodeProps<KiteNode>) {
  const { node } = data;
  const ref = node.kite?.ref;
  const [info, setInfo] = useState<KiteCardInfo | null | 'hidden'>(null);
  useEffect(() => {
    if (!ref) return;
    let live = true;
    api<KiteCardInfo>(`/api/artifacts/${ref}`)
      .then((found) => live && setInfo({ title: found.title, slug: found.slug }))
      // 404 is "not yours to open", and the canvas must not say more than that.
      .catch(() => live && setInfo('hidden'));
    return () => {
      live = false;
    };
  }, [ref]);

  if (info === 'hidden' || !ref) {
    return (
      <Frame node={node}>
        <div className="text-muted italic">A document you can’t open</div>
      </Frame>
    );
  }
  if (!info) {
    return (
      <Frame node={node}>
        <div className="text-muted">…</div>
      </Frame>
    );
  }
  return (
    <Frame node={node}>
      <a className="nodrag mb-1 block font-semibold underline" href={`/a/${info.slug}`}>
        {info.title}
      </a>
      {node.kite?.view === 'preview' && (
        <iframe
          title={info.title}
          src={`/a/${info.slug}/content`}
          sandbox="allow-scripts"
          className="nodrag nowheel h-[calc(100%-1.75rem)] w-full rounded border-0 bg-white"
        />
      )}
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

function toFlow(
  doc: CanvasDocument,
  editable: boolean,
  onEdit: NodeData['onEdit'],
): { nodes: KiteNode[]; edges: Edge[] } {
  const nodes: KiteNode[] = doc.nodes.map((node) => ({
    id: node.id,
    type: flowTypeOf(node),
    position: { x: node.x, y: node.y },
    width: node.width,
    height: node.height,
    style: { width: node.width, height: node.height },
    // Groups sit behind what they hold, as in Obsidian.
    zIndex: node.type === 'group' ? -1 : 0,
    data: { node, editable, onEdit },
  }));
  const edges: Edge[] = doc.edges.map((edge) => ({
    id: edge.id,
    source: edge.fromNode,
    target: edge.toNode,
    sourceHandle: `s-${edge.fromSide ?? 'right'}`,
    targetHandle: `t-${edge.toSide ?? 'left'}`,
    label: edge.label,
    style: edge.color ? { stroke: PRESET[edge.color] ?? edge.color } : undefined,
    markerEnd: edge.toEnd === 'none' ? undefined : { type: MarkerType.ArrowClosed },
  }));
  return { nodes, edges };
}

export default function CanvasView({ artifactId, editable }: { artifactId: string; editable: boolean }) {
  return (
    <ReactFlowProvider>
      <CanvasInner artifactId={artifactId} editable={editable} />
    </ReactFlowProvider>
  );
}

function CanvasInner({ artifactId, editable }: { artifactId: string; editable: boolean }) {
  const [doc, setDoc] = useState<CanvasPayload | null>(null);
  const [nodes, setNodes] = useState<KiteNode[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const version = useRef(0);

  const load = useCallback(async () => {
    const next = await api<CanvasPayload>(`/api/artifacts/${artifactId}/canvas`);
    version.current = next.kite.version;
    setDoc(next);
    return next.kite.version;
  }, [artifactId]);

  const queue = useMemo(
    () =>
      createOpsQueue({
        getVersion: () => version.current,
        reload: load,
        send: (baseVersion, ops: QueuedOp[]) =>
          api<{ version: number }>(`/api/artifacts/${artifactId}/canvas/ops`, {
            method: 'POST',
            body: JSON.stringify({ baseVersion, ops }),
          }),
        onSaved: () => setStatus('saved'),
        onError: (error) => {
          setStatus('error');
          setFailure(error instanceof ApiError ? error.message : 'Could not save the canvas.');
          void load();
        },
      }),
    [artifactId, load],
  );

  useEffect(() => {
    load().catch((error: unknown) =>
      setFailure(error instanceof ApiError ? error.message : 'Could not load the canvas.'),
    );
  }, [load]);

  // Leaving the page should not drop a drag that has not been sent yet.
  useEffect(() => () => void queue.flush(), [queue]);

  const onEdit = useCallback(
    (id: string, set: { text?: string; label?: string }) => {
      setStatus('saving');
      queue.push({ op: 'update', id, set });
    },
    [queue],
  );

  const flow = useMemo(
    () => (doc ? toFlow(doc, editable, onEdit) : { nodes: [], edges: [] }),
    [doc, editable, onEdit],
  );
  useEffect(() => setNodes(flow.nodes), [flow.nodes]);

  const onNodesChange = useCallback(
    (changes: NodeChange<KiteNode>[]) => setNodes((current) => applyNodeChanges(changes, current)),
    [],
  );

  const onNodeDragStop = useCallback(
    (_event: unknown, _node: KiteNode, dragged: KiteNode[]) => {
      setStatus('saving');
      for (const node of dragged) {
        queue.push({
          op: 'move',
          id: node.id,
          x: Math.round(node.position.x),
          y: Math.round(node.position.y),
        });
      }
    },
    [queue],
  );

  if (failure && !doc) {
    return <div className="p-6 text-sm text-danger">{failure}</div>;
  }

  return (
    <div className="relative h-full min-h-[480px] w-full" data-testid="canvas-view">
      <ReactFlow<KiteNode, Edge>
        nodes={nodes}
        edges={flow.edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onNodeDragStop={editable ? onNodeDragStop : undefined}
        nodesDraggable={editable}
        nodesConnectable={false}
        edgesFocusable={false}
        elementsSelectable={editable}
        onlyRenderVisibleElements
        fitView
        minZoom={0.05}
        proOptions={{ hideAttribution: false }}
      >
        <Background />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable />
      </ReactFlow>
      {editable && status !== 'idle' && (
        <div className="absolute right-3 top-3 rounded bg-surface px-2 py-1 text-xs text-muted shadow" data-testid="canvas-status">
          {status === 'saving' ? 'Saving…' : status === 'saved' ? `Saved · v${doc?.kite.version ?? ''}` : failure}
        </div>
      )}
    </div>
  );
}
