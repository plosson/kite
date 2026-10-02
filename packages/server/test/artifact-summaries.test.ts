import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  TEST_DESCRIBED,
  createTestServer,
  jsonBody,
  signIn,
  type PublishedArtifact,
  type SignedInUser,
  type TestServer,
} from './helpers/server.js';
import { artifacts, artifactVersions } from '../src/db/schema.js';

/**
 * What a publisher has to say about a document, and how it is kept.
 *
 * Every new document carries a one-line description and a summary of at most
 * ten lines, so a whole library can be read and sorted without opening each
 * one. Both are refused rather than cut when they break the rules: an agent
 * that wrote too much should rewrite it, not ship half a sentence. The cases
 * here are the ones an agent gets wrong, and the ones where getting it wrong
 * must not cost the document.
 */

interface Listed {
  id: string;
  title: string;
  description: string | null;
  summary: string | null;
  summaryVersion: number | null;
  version: number;
  updatedAt: string;
}

let server: TestServer;
let owner: SignedInUser;

beforeEach(async () => {
  server = createTestServer({ SIGNUP_MODE: 'open' });
  owner = await signIn(server, 'owner@example.com');
});

afterEach(() => {
  server.close();
});

function publishRaw(body: Record<string, unknown>): Promise<Response> {
  return owner.as('/api/artifacts', jsonBody(body));
}

function put(id: string, body: Record<string, unknown>, as: SignedInUser = owner): Promise<Response> {
  return as.as(`/api/artifacts/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function patch(id: string, body: unknown, as: SignedInUser = owner): Promise<Response> {
  return as.as(`/api/artifacts/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function errorOf(response: Response): Promise<{ status: number; code: string; message: string }> {
  const body = (await response.json()) as { error: { code: string; message: string } };
  return { status: response.status, ...body.error };
}

async function listed(id: string): Promise<Listed> {
  const listing = (await (await owner.as('/api/artifacts')).json()) as { artifacts: Listed[] };
  const found = listing.artifacts.find((artifact) => artifact.id === id);
  if (!found) throw new Error(`${id} is not listed`);
  return found;
}

function versionCount(id: string): number {
  return server.database.db.select().from(artifactVersions).where(eq(artifactVersions.artifactId, id)).all().length;
}

async function kiteCount(): Promise<number> {
  const listing = (await (await owner.as('/api/artifacts')).json()) as { artifacts: unknown[] };
  return listing.artifacts.length;
}

const tenLines = Array.from({ length: 10 }, (_, index) => `Point ${index + 1}.`).join('\n');

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

describe('publishing requires a description and a summary', () => {
  it('refuses a document with no description, and publishes nothing', async () => {
    const response = await publishRaw({ type: 'markdown', content: '# Hi', summary: 'S.' });
    const error = await errorOf(response);
    expect(error.status).toBe(400);
    expect(error.code).toBe('validation_failed');
    expect(error.message).toContain('description');
    expect(await kiteCount()).toBe(0);
  });

  it('refuses a document with no summary, and publishes nothing', async () => {
    const response = await publishRaw({ type: 'markdown', content: '# Hi', description: 'D.' });
    const error = await errorOf(response);
    expect(error.status).toBe(400);
    expect(error.message).toContain('summary');
    expect(await kiteCount()).toBe(0);
  });

  it('refuses a description that is not text', async () => {
    const response = await publishRaw({ type: 'markdown', content: '# Hi', description: 42, summary: 'S.' });
    expect((await errorOf(response)).status).toBe(400);
  });

  it('refuses a description of only whitespace', async () => {
    const response = await publishRaw({ ...TEST_DESCRIBED, type: 'markdown', content: '# Hi', description: ' \t ' });
    expect((await errorOf(response)).message).toContain('blank');
    expect(await kiteCount()).toBe(0);
  });

  it('refuses a description that runs over a line break', async () => {
    const response = await publishRaw({
      ...TEST_DESCRIBED,
      type: 'markdown',
      content: '# Hi',
      description: 'First line\nsecond line',
    });
    expect((await errorOf(response)).message).toContain('single line');
  });

  it('refuses a carriage return as a line break too', async () => {
    const response = await publishRaw({
      ...TEST_DESCRIBED,
      type: 'markdown',
      content: '# Hi',
      description: 'First line\rsecond line',
    });
    expect((await errorOf(response)).status).toBe(400);
  });

  it('refuses a description one character over the limit, rather than cutting it', async () => {
    const response = await publishRaw({
      ...TEST_DESCRIBED,
      type: 'markdown',
      content: '# Hi',
      description: 'x'.repeat(161),
    });
    const error = await errorOf(response);
    expect(error.status).toBe(400);
    expect(error.message).toContain('160');
    expect(await kiteCount()).toBe(0);
  });

  it('accepts a description exactly at the limit', async () => {
    const response = await publishRaw({
      ...TEST_DESCRIBED,
      type: 'markdown',
      content: '# Hi',
      description: 'x'.repeat(160),
    });
    expect(response.status).toBe(201);
  });

  it('collapses runs of spaces before measuring, so padding does not count against it', async () => {
    const response = await publishRaw({
      ...TEST_DESCRIBED,
      type: 'markdown',
      content: '# Hi',
      description: `  ${'word    '.repeat(30)}  `,
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as Listed;
    expect(created.description).toBe(Array.from({ length: 30 }, () => 'word').join(' '));
  });

  it('refuses a summary of eleven lines, naming the limit', async () => {
    const response = await publishRaw({
      ...TEST_DESCRIBED,
      type: 'markdown',
      content: '# Hi',
      summary: `${tenLines}\nPoint 11.`,
    });
    const error = await errorOf(response);
    expect(error.status).toBe(400);
    expect(error.message).toContain('11 lines');
    expect(await kiteCount()).toBe(0);
  });

  it('counts blank lines inside the summary, so spacing cannot smuggle in more', async () => {
    const response = await publishRaw({
      ...TEST_DESCRIBED,
      type: 'markdown',
      content: '# Hi',
      summary: Array.from({ length: 6 }, (_, index) => `Point ${index}.`).join('\n\n'),
    });
    expect((await errorOf(response)).message).toContain('11 lines');
  });

  it('accepts ten lines written with Windows line endings', async () => {
    const response = await publishRaw({
      ...TEST_DESCRIBED,
      type: 'markdown',
      content: '# Hi',
      summary: tenLines.replace(/\n/g, '\r\n'),
    });
    expect(response.status).toBe(201);
    expect(((await response.json()) as Listed).summary).toBe(tenLines);
  });

  it('ignores blank lines around the summary', async () => {
    const response = await publishRaw({
      ...TEST_DESCRIBED,
      type: 'markdown',
      content: '# Hi',
      summary: `\n\n\n${tenLines}\n\n\n`,
    });
    expect(response.status).toBe(201);
  });

  it('refuses a summary within ten lines but over the character limit', async () => {
    const response = await publishRaw({
      ...TEST_DESCRIBED,
      type: 'markdown',
      content: '# Hi',
      summary: 'x'.repeat(1201),
    });
    const error = await errorOf(response);
    expect(error.status).toBe(400);
    expect(error.message).toContain('1200');
  });

  it('refuses a summary of only whitespace and line breaks', async () => {
    const response = await publishRaw({ ...TEST_DESCRIBED, type: 'markdown', content: '# Hi', summary: '\n \n\t\n' });
    expect((await errorOf(response)).message).toContain('blank');
  });

  it('returns both, with the summary written for the first version', async () => {
    const created = await owner.publish({
      type: 'markdown',
      content: '# Hi',
      description: 'A greeting.',
      summary: 'Says hi.',
    });
    expect(await listed(created.id)).toMatchObject({
      description: 'A greeting.',
      summary: 'Says hi.',
      summaryVersion: 1,
      version: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// Updating content
// ---------------------------------------------------------------------------

describe('updating content keeps what was said unless it is replaced', () => {
  let doc: PublishedArtifact;

  beforeEach(async () => {
    doc = await owner.publish({ type: 'markdown', content: '# Plan', description: 'The plan.', summary: 'Do it.' });
  });

  it('keeps description and summary when the update leaves them out, and shows the summary falling behind', async () => {
    expect((await put(doc.id, { content: '# Plan\n\nTypo fixed.', baseVersion: 1 })).status).toBe(200);
    expect((await put(doc.id, { content: '# Plan\n\nAnother fix.', baseVersion: 2 })).status).toBe(200);

    expect(await listed(doc.id)).toMatchObject({
      description: 'The plan.',
      summary: 'Do it.',
      summaryVersion: 1,
      version: 3,
    });
  });

  it('catches the summary up when the update sends one', async () => {
    await put(doc.id, { content: '# Plan v2', baseVersion: 1 });
    await put(doc.id, { content: '# Plan v3', baseVersion: 2, summary: 'Do it differently.' });

    expect(await listed(doc.id)).toMatchObject({ summary: 'Do it differently.', summaryVersion: 3, version: 3 });
  });

  it('does not move the summary version when only the description changes', async () => {
    await put(doc.id, { content: '# Plan v2', baseVersion: 1, description: 'The revised plan.' });
    expect(await listed(doc.id)).toMatchObject({ description: 'The revised plan.', summaryVersion: 1, version: 2 });
  });

  it('refuses an update whose summary is too long, and leaves the content as it was', async () => {
    const response = await put(doc.id, {
      content: '# Replaced',
      baseVersion: 1,
      summary: `${tenLines}\nOne too many.`,
    });
    expect(response.status).toBe(400);

    const stored = (await (await owner.as(`/api/artifacts/${doc.id}`)).json()) as { content: string; version: number };
    expect(stored).toMatchObject({ content: '# Plan', version: 1 });
  });

  it('refuses a blank description on update rather than wiping the old one', async () => {
    const response = await put(doc.id, { content: '# Plan v2', baseVersion: 1, description: '' });
    expect(response.status).toBe(400);
    expect(await listed(doc.id)).toMatchObject({ description: 'The plan.', version: 1 });
  });

  it('checks the version before anything else is written, even with a valid summary', async () => {
    await put(doc.id, { content: '# Plan v2', baseVersion: 1 });
    const stale = await put(doc.id, { content: '# Plan v3', baseVersion: 1, summary: 'Stale view.' });
    expect(stale.status).toBe(409);
    expect(await listed(doc.id)).toMatchObject({ summary: 'Do it.', summaryVersion: 1, version: 2 });
  });
});

// ---------------------------------------------------------------------------
// Retitling and redescribing without touching content
// ---------------------------------------------------------------------------

describe('PATCH changes what is said about a document and nothing else', () => {
  let doc: PublishedArtifact;

  beforeEach(async () => {
    doc = await owner.publish({ type: 'markdown', content: '# Draft', description: 'A draft.', summary: 'Early.' });
  });

  it('retitles without writing a version or moving the last-changed time', async () => {
    const before = await listed(doc.id);
    const versionRows = versionCount(doc.id);

    const response = await patch(doc.id, { title: 'Q3 launch plan' });
    expect(response.status).toBe(200);

    const after = await listed(doc.id);
    expect(after.title).toBe('Q3 launch plan');
    expect(after.version).toBe(before.version);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(versionCount(doc.id)).toBe(versionRows);
  });

  it('keeps a title set this way when the content changes later', async () => {
    await patch(doc.id, { title: 'Chosen title' });
    await put(doc.id, { content: '# A different heading', baseVersion: 1 });
    expect((await listed(doc.id)).title).toBe('Chosen title');
  });

  it('brings a summary that fell behind back to the current version', async () => {
    await put(doc.id, { content: '# Draft 2', baseVersion: 1 });
    await put(doc.id, { content: '# Draft 3', baseVersion: 2 });
    expect((await listed(doc.id)).summaryVersion).toBe(1);

    await patch(doc.id, { summary: 'Nearly final.' });
    expect(await listed(doc.id)).toMatchObject({ summary: 'Nearly final.', summaryVersion: 3, version: 3 });
  });

  it('leaves out what it was not sent', async () => {
    await patch(doc.id, { description: 'A better draft.' });
    expect(await listed(doc.id)).toMatchObject({ title: 'Draft', description: 'A better draft.', summary: 'Early.' });
  });

  it('never touches content, even when content is sent', async () => {
    const response = await patch(doc.id, { title: 'New', content: '# Overwritten' });
    expect(response.status).toBe(200);
    const stored = (await (await owner.as(`/api/artifacts/${doc.id}`)).json()) as { content: string };
    expect(stored.content).toBe('# Draft');
  });

  it('refuses a request with nothing to change', async () => {
    const response = await patch(doc.id, {});
    expect(await errorOf(response)).toMatchObject({ status: 400, code: 'validation_failed' });
  });

  it('refuses a request whose only field is one it does not know', async () => {
    expect((await patch(doc.id, { content: '# Sneaky' })).status).toBe(400);
  });

  it('refuses a body that is not an object', async () => {
    expect((await patch(doc.id, ['title'])).status).toBe(400);
  });

  it('refuses the whole request when one field is bad, changing none of them', async () => {
    const response = await patch(doc.id, { title: 'Good title', summary: 'x'.repeat(1201) });
    expect(response.status).toBe(400);
    expect(await listed(doc.id)).toMatchObject({ title: 'Draft', summary: 'Early.' });
  });

  it('refuses a blank title rather than deriving one', async () => {
    expect((await patch(doc.id, { title: '   ' })).status).toBe(400);
    expect((await listed(doc.id)).title).toBe('Draft');
  });

  it('refuses somebody signed out', async () => {
    const response = await server.request(`/api/artifacts/${doc.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Mine now' }),
    });
    expect(response.status).toBe(401);
  });

  it('refuses somebody who can read it but does not own it', async () => {
    const reader = await signIn(server, 'reader@example.com');
    await owner.as(`/api/artifacts/${doc.id}/sharing/people`, jsonBody({ email: reader.email }));
    expect((await reader.as(`/api/artifacts/${doc.id}`)).status).toBe(200);

    const response = await patch(doc.id, { title: 'Renamed by a reader' }, reader);
    expect([403, 404]).toContain(response.status);
    expect((await listed(doc.id)).title).toBe('Draft');
  });

  it('refuses somebody who cannot see it at all, without saying it exists', async () => {
    const stranger = await signIn(server, 'stranger@example.com');
    const response = await patch(doc.id, { title: 'Renamed by a stranger' }, stranger);
    expect(response.status).toBe(404);
    expect((await listed(doc.id)).title).toBe('Draft');
  });

  it('answers 404 for an artifact that does not exist', async () => {
    expect((await patch('art_nope', { title: 'X' })).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Documents published before any of this
// ---------------------------------------------------------------------------

describe('documents published before descriptions were required', () => {
  let doc: PublishedArtifact;

  beforeEach(async () => {
    doc = await owner.publish({ type: 'markdown', content: '# Old' });
    server.database.db
      .update(artifacts)
      .set({ description: null, summary: null, summaryVersion: null })
      .where(eq(artifacts.id, doc.id))
      .run();
  });

  it('are listed with nothing said about them rather than refused', async () => {
    expect(await listed(doc.id)).toMatchObject({ description: null, summary: null, summaryVersion: null });
  });

  it('can still be updated without writing a description first', async () => {
    expect((await put(doc.id, { content: '# Old, edited', baseVersion: 1 })).status).toBe(200);
    expect(await listed(doc.id)).toMatchObject({ summary: null, summaryVersion: null, version: 2 });
  });

  it('can be given a summary afterwards, written for the version they are at', async () => {
    await put(doc.id, { content: '# Old, edited', baseVersion: 1 });
    await patch(doc.id, { description: 'An old note.', summary: 'Kept for reference.' });
    expect(await listed(doc.id)).toMatchObject({ description: 'An old note.', summaryVersion: 2 });
  });
});
