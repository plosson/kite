import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestServer,
  jsonBody,
  signIn,
  type PublishedArtifact,
  type SignedInUser,
  type TestServer,
} from './helpers/server.js';

/**
 * GET /api/artifacts/:id/canvas/image: who may have the picture, which
 * version and part of the canvas it shows, what it refuses, and what it costs.
 * How the drawing looks is canvas-image-render.test.ts and the e2e comparison.
 */

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

const publishBoard = (board: unknown = BOARD) => owner.publish({ type: 'canvas', content: JSON.stringify(board) });

const image = (as: SignedInUser, artifact: PublishedArtifact, query = '', init?: RequestInit) =>
  as.as(`/api/artifacts/${artifact.id}/canvas/image${query}`, init);

/** A PNG's width and height, from its header. */
async function pngSize(response: Response): Promise<{ width: number; height: number }> {
  const bytes = Buffer.from(await response.arrayBuffer());
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function error(response: Response) {
  return ((await response.json()) as { error: { code: string; message: string } }).error;
}

/** Signs a command line in, the way agentio does. */
async function tokenFor(user: SignedInUser): Promise<string> {
  const started = (await (await server.request('/api/auth/device', jsonBody({ label: 'agentio' }))).json()) as {
    deviceCode: string;
    userCode: string;
  };
  await user.as('/api/auth/device/approve', jsonBody({ userCode: started.userCode }));
  const polled = (await (await server.request('/api/auth/device/token', jsonBody({ deviceCode: started.deviceCode }))).json()) as {
    token: string;
  };
  return polled.token;
}

async function agentFetches(artifact: PublishedArtifact): Promise<number> {
  const views = (await (await owner.as(`/api/artifacts/${artifact.id}/views`)).json()) as { totals: { agentFetches: number } };
  return views.totals.agentFetches;
}

describe('the picture of a canvas', () => {
  it('is a PNG of the whole canvas at twice its size, with room around it, named after the document', async () => {
    const artifact = await publishBoard();
    const response = await image(owner, artifact);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-disposition')).toBe(`inline; filename="Launch plan.png"; filename*=UTF-8''Launch%20plan.png`);
    expect(response.headers.get('x-artifact-version')).toBe('1');
    // The nodes reach from 0,0 to 1000,400; 32 around them by default.
    expect(response.headers.get('x-canvas-origin')).toBe('-32,-32');
    expect(await pngSize(response)).toEqual({ width: 1064 * 2, height: 464 * 2 });
  });

  it('takes a scale and a padding', async () => {
    const artifact = await publishBoard();
    const response = await image(owner, artifact, '?scale=1.5&padding=0');
    expect(response.headers.get('x-canvas-origin')).toBe('0,0');
    expect(await pngSize(response)).toEqual({ width: 1500, height: 600 });
  });

  it('is an SVG with its fonts inside when asked, the text still text', async () => {
    const artifact = await publishBoard();
    const response = await image(owner, artifact, '?format=svg&scale=1');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/svg+xml');
    expect(response.headers.get('content-disposition')).toContain('filename="Launch plan.svg"');
    const svg = await response.text();
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="-32 -32 1064 464" width="1064" height="464">')).toBe(true);
    expect(svg).toContain('@font-face');
    expect(svg).toContain('>Ship the canvas spike</text>');
    expect(svg).toContain('>Launch plan</text>');
  });

  it('draws only a group and what is in it, with node', async () => {
    const artifact = await publishBoard();
    const response = await image(owner, artifact, '?node=g1&padding=0&scale=1&format=svg');
    expect(response.status).toBe(200);
    const svg = await response.text();
    expect(svg).toContain('viewBox="0 0 600 400"');
    expect(svg).toContain('Measure React Flow');
    expect(svg).not.toContain('LINK');
  });

  it('leaves the background out, grid and all, when it is transparent', async () => {
    const artifact = await publishBoard();
    const plain = await (await image(owner, artifact, '?format=svg')).text();
    const clear = await (await image(owner, artifact, '?format=svg&background=transparent')).text();
    expect(plain).toContain('<pattern');
    expect(clear).not.toContain('<pattern');
    expect(clear.length).toBeLessThan(plain.length);
    const noGrid = await (await image(owner, artifact, '?format=svg&grid=false')).text();
    expect(noGrid).not.toContain('<pattern');
  });

  it('shows the title of a Kite card only to somebody who may open what it points at', async () => {
    const secret = await owner.publish({ type: 'markdown', content: '# Budget 2027\n\nNumbers.' });
    const artifact = await publishBoard({
      nodes: [{ id: 'k1', type: 'link', x: 0, y: 0, width: 300, height: 100, url: `https://artifacts.test/a/${secret.slug}`, kite: { kind: 'kite', ref: secret.id } }],
      edges: [],
    });
    await owner.as(`/api/artifacts/${artifact.id}/sharing/people`, jsonBody({ email: colleague.email }));

    const mine = await (await image(owner, artifact, '?format=svg')).text();
    expect(mine).toContain('>Budget 2027</text>');
    const theirs = await (await image(colleague, artifact, '?format=svg')).text();
    expect(theirs).not.toContain('Budget 2027');
    expect(theirs).toContain('A document you can’t open');
  });
});

describe('who may have it', () => {
  it('is anybody who may open the canvas, and nobody else', async () => {
    const artifact = await publishBoard();
    expect((await image(colleague, artifact)).status).toBe(404);
    expect((await server.request(`/api/artifacts/${artifact.id}/canvas/image`)).status).toBe(404);

    await owner.as(`/api/artifacts/${artifact.id}/sharing/people`, jsonBody({ email: colleague.email }));
    expect((await image(colleague, artifact)).status).toBe(200);

    await owner.as(`/api/artifacts/${artifact.id}/sharing/public`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPublic: true }),
    });
    expect((await server.request(`/api/artifacts/${artifact.id}/canvas/image`)).status).toBe(200);
  });

  it('is only for canvases', async () => {
    const page = await owner.publish({ type: 'markdown', content: '# Notes' });
    const response = await image(owner, page);
    expect(response.status).toBe(400);
    expect((await error(response)).message).toContain('not a canvas');
  });
});

describe('a past version', () => {
  it('is drawn for the owner, and for nobody else', async () => {
    const artifact = await publishBoard();
    const moved = await owner.as(
      `/api/artifacts/${artifact.id}/canvas/ops`,
      jsonBody({ baseVersion: 1, ops: [{ op: 'update', id: 'l1', set: { x: 1700 } }] }),
    );
    expect(moved.status).toBe(200);

    const now = await image(owner, artifact, '?format=svg&scale=1');
    expect(now.headers.get('x-artifact-version')).toBe('2');
    expect(await now.text()).toContain('viewBox="-32 -32 2064 464"');
    const before = await image(owner, artifact, '?format=svg&scale=1&version=1');
    expect(before.status).toBe(200);
    expect(before.headers.get('x-artifact-version')).toBe('1');
    expect(await before.text()).toContain('viewBox="-32 -32 1064 464"');

    await owner.as(`/api/artifacts/${artifact.id}/sharing/people`, jsonBody({ email: colleague.email }));
    expect((await image(colleague, artifact)).status).toBe(200);
    expect((await image(colleague, artifact, '?version=1')).status).toBe(404);
  });

  it('must be one there is', async () => {
    const artifact = await publishBoard();
    expect((await image(owner, artifact, '?version=7')).status).toBe(404);
    expect((await image(owner, artifact, '?version=0')).status).toBe(400);
  });
});

describe('what it refuses', () => {
  it.each([
    ['format=jpg', 'format must be "png" or "svg"'],
    ['scale=0.5', 'scale must be a number from 1 to 3'],
    ['scale=4', 'scale must be a number from 1 to 3'],
    ['scale=two', 'scale must be a number from 1 to 3'],
    ['padding=-1', 'padding must be a whole number'],
    ['padding=401', 'padding must be a whole number'],
    ['padding=2.5', 'padding must be a whole number'],
    ['background=red', 'background must be "theme" or "transparent"'],
    ['grid=yes', 'grid must be "true" or "false"'],
    ['node=nope', 'This canvas has no node "nope"'],
  ])('%s', async (query, message) => {
    const artifact = await publishBoard();
    const response = await image(owner, artifact, `?${query}`);
    expect(response.status).toBe(400);
    expect((await error(response)).message).toContain(message);
  });

  it('a PNG too large to send, and says how to get one', async () => {
    const artifact = await publishBoard({
      nodes: [
        { id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 100, text: 'here' },
        { id: 'b', type: 'text', x: 9000, y: 0, width: 100, height: 100, text: 'far away' },
      ],
      edges: [],
    });
    const response = await image(owner, artifact, '?scale=1');
    expect(response.status).toBe(400);
    expect((await error(response)).message).toContain('would be 9164 by 164 pixels');
    expect((await image(owner, artifact, '?format=svg')).status).toBe(200);
    expect((await image(owner, artifact, '?node=a')).status).toBe(200);
  });
});

describe('asking again', () => {
  it('is a 304 while the image would come out the same', async () => {
    const artifact = await publishBoard();
    const first = await image(owner, artifact);
    const etag = first.headers.get('etag')!;
    expect(etag).toMatch(/^"[\w-]+"$/);
    expect(first.headers.get('cache-control')).toBe('private, no-cache');

    const again = await image(owner, artifact, '', { headers: { 'If-None-Match': etag } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');

    // Other options, or another version, are another image.
    const svg = await image(owner, artifact, '?format=svg', { headers: { 'If-None-Match': etag } });
    expect(svg.status).toBe(200);
    expect(svg.headers.get('etag')).not.toBe(etag);
    await owner.as(`/api/artifacts/${artifact.id}/canvas/ops`, jsonBody({ baseVersion: 1, ops: [{ op: 'update', id: 'n1', set: { text: 'Shipped' } }] }));
    const changed = await image(owner, artifact, '', { headers: { 'If-None-Match': etag } });
    expect(changed.status).toBe(200);
  });

  it('draws only so many an hour, and a 304 costs nothing', async () => {
    server.close();
    server = createTestServer({ SIGNUP_MODE: 'open', MAX_CANVAS_IMAGES_PER_HOUR: '2' });
    owner = await signIn(server, 'owner@example.com');
    const artifact = await publishBoard();
    const first = await image(owner, artifact);
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag')!;
    for (let i = 0; i < 3; i++) expect((await image(owner, artifact, '', { headers: { 'If-None-Match': etag } })).status).toBe(304);
    expect((await image(owner, artifact, '?format=svg')).status).toBe(200);
    const refused = await image(owner, artifact, '?scale=1');
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toMatch(/^\d+$/);
  });
});

describe('what counts as reading it', () => {
  it('records a command-line read as an agent read, unless record=false', async () => {
    const artifact = await publishBoard();
    const auth = { headers: { Authorization: `Bearer ${await tokenFor(owner)}` } };
    expect((await server.request(`/api/artifacts/${artifact.id}/canvas/image?record=false`, auth)).status).toBe(200);
    expect(await agentFetches(artifact)).toBe(0);
    expect((await server.request(`/api/artifacts/${artifact.id}/canvas/image`, auth)).status).toBe(200);
    expect(await agentFetches(artifact)).toBe(1);
  });

  it('does not record the web app asking for it', async () => {
    const artifact = await publishBoard();
    await image(owner, artifact);
    const views = (await (await owner.as(`/api/artifacts/${artifact.id}/views`)).json()) as { recent: unknown[] };
    expect(views.recent).toHaveLength(0);
  });
});
