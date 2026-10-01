import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, type DatabaseHandle } from '../src/db/index.js';
import { users, artifacts } from '../src/db/schema.js';
import { WorkspaceService, INBOX_ID } from '../src/workspaces/service.js';
import { ApiError } from '../src/errors.js';
import { nowIso } from '../src/time.js';

/**
 * The workspace store on its own, below HTTP.
 *
 * What matters here is what a person can get wrong by typing: the same name in
 * another case, the reserved name, blank text, and ids that are not theirs.
 */

let database: DatabaseHandle;
let service: WorkspaceService;

beforeEach(() => {
  database = openDatabase({ path: ':memory:' });
  service = new WorkspaceService(database.db);
  for (const id of ['usr_a', 'usr_b']) {
    database.db
      .insert(users)
      .values({
        id,
        email: `${id}@example.com`,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      } as typeof users.$inferInsert)
      .run();
  }
  for (const id of ['art_1', 'art_2']) {
    database.db
      .insert(artifacts)
      .values({
        id,
        slug: `slug_${id}`,
        ownerId: 'usr_a',
        type: 'markdown',
        title: id,
        content: '# x',
        createdAt: nowIso(),
        updatedAt: nowIso(),
      } as typeof artifacts.$inferInsert)
      .run();
  }
});

afterEach(() => database.close());

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof ApiError) return error.code;
    throw error;
  }
  return undefined;
}

describe('names', () => {
  it('refuses every case of the reserved name, with spaces around it too', () => {
    for (const name of ['Inbox', 'inbox', 'INBOX', '  inBox  ']) {
      expect(codeOf(() => service.create('usr_a', { name, description: 'x' })), name).toBe('name_taken');
    }
  });

  it('refuses a duplicate that differs only in case or surrounding spaces', () => {
    service.create('usr_a', { name: 'Research', description: 'Papers' });
    expect(codeOf(() => service.create('usr_a', { name: ' research ', description: 'x' }))).toBe('name_taken');
  });

  it('lets two people use the same name', () => {
    service.create('usr_a', { name: 'Research', description: 'Papers' });
    expect(() => service.create('usr_b', { name: 'Research', description: 'Mine' })).not.toThrow();
  });

  it('refuses blank, missing, non-text and too long names and descriptions', () => {
    const bad: { name: unknown; description: unknown }[] = [
      { name: '', description: 'x' },
      { name: '   ', description: 'x' },
      { name: undefined, description: 'x' },
      { name: 42, description: 'x' },
      { name: 'a'.repeat(61), description: 'x' },
      { name: 'Ok', description: '' },
      { name: 'Ok', description: '   ' },
      { name: 'Ok', description: 'd'.repeat(501) },
    ];
    for (const input of bad) {
      expect(codeOf(() => service.create('usr_a', input)), JSON.stringify(input)).toBe('validation_failed');
    }
  });

  it('stores names and descriptions trimmed', () => {
    const created = service.create('usr_a', { name: '  Research ', description: ' Papers \n' });
    expect(created).toMatchObject({ name: 'Research', description: 'Papers' });
  });

  it('refuses a rename onto another workspace’s name, but allows a case change of its own', () => {
    const research = service.create('usr_a', { name: 'Research', description: 'Papers' });
    service.create('usr_a', { name: 'Admin', description: 'Forms' });
    expect(codeOf(() => service.update('usr_a', research.id, { name: 'ADMIN' }))).toBe('name_taken');
    expect(service.update('usr_a', research.id, { name: 'RESEARCH' }).name).toBe('RESEARCH');
  });
});

describe('ownership', () => {
  it('treats another person’s workspace exactly like a missing one', () => {
    const theirs = service.create('usr_b', { name: 'Private', description: 'x' });
    expect(codeOf(() => service.update('usr_a', theirs.id, { name: 'Mine now' }))).toBe('not_found');
    expect(codeOf(() => service.delete('usr_a', theirs.id))).toBe('not_found');
    expect(codeOf(() => service.place('usr_a', 'art_1', theirs.id))).toBe('not_found');
    expect(codeOf(() => service.resolve('usr_a', theirs.id))).toBe('not_found');
    expect(codeOf(() => service.resolve('usr_a', 'Private'))).toBe('not_found');
    expect(codeOf(() => service.update('usr_a', 'ws_nope', { name: 'x' }))).toBe('not_found');
  });

  it('refuses to edit or delete Inbox', () => {
    expect(codeOf(() => service.update('usr_a', INBOX_ID, { name: 'Other' }))).toBe('validation_failed');
    expect(codeOf(() => service.delete('usr_a', INBOX_ID))).toBe('validation_failed');
  });
});

describe('placement', () => {
  it('moves a kite, keeps one placement per person, and moves it back to Inbox', () => {
    const one = service.create('usr_a', { name: 'One', description: 'x' });
    const two = service.create('usr_a', { name: 'Two', description: 'x' });
    service.place('usr_a', 'art_1', one.id);
    service.place('usr_a', 'art_1', two.id);
    expect(service.placementsFor('usr_a').get('art_1')).toBe(two.id);
    expect(service.place('usr_a', 'art_1', INBOX_ID)).toBe(INBOX_ID);
    expect(service.placementsFor('usr_a').has('art_1')).toBe(false);
  });

  it('keeps one person’s placement out of another’s', () => {
    const mine = service.create('usr_a', { name: 'Mine', description: 'x' });
    service.place('usr_a', 'art_1', mine.id);
    expect(service.placementsFor('usr_b').size).toBe(0);
  });

  it('sends a deleted workspace’s kites back to Inbox and deletes no kite', () => {
    const doomed = service.create('usr_a', { name: 'Doomed', description: 'x' });
    service.place('usr_a', 'art_1', doomed.id);
    service.delete('usr_a', doomed.id);
    expect(service.placementsFor('usr_a').has('art_1')).toBe(false);
    expect(database.db.select().from(artifacts).all()).toHaveLength(2);
  });
});

describe('listing', () => {
  it('puts Inbox first, then sorts by name ignoring case, and counts only visible kites', () => {
    const zeta = service.create('usr_a', { name: 'zeta', description: 'z' });
    service.create('usr_a', { name: 'Alpha', description: 'a' });
    service.place('usr_a', 'art_1', zeta.id);
    service.place('usr_a', 'art_2', zeta.id);

    const listed = service.list('usr_a', new Set(['art_1']));
    expect(listed.map((w) => w.name)).toEqual(['Inbox', 'Alpha', 'zeta']);
    expect(listed[0]).toEqual({
      id: 'inbox',
      name: 'Inbox',
      description: 'Kites that are not sorted into a workspace yet.',
      count: 0,
    });
    // art_2 is placed but not visible, so it is not counted.
    expect(listed.find((w) => w.name === 'zeta')?.count).toBe(1);
  });

  it('counts visible kites with no placement in Inbox', () => {
    expect(service.list('usr_a', new Set(['art_1', 'art_2']))[0]?.count).toBe(2);
  });

  it('resolves by id, or by name ignoring case, and resolves "inbox" in any case', () => {
    const research = service.create('usr_a', { name: 'Research', description: 'x' });
    expect(service.resolve('usr_a', research.id).id).toBe(research.id);
    expect(service.resolve('usr_a', '  research ').id).toBe(research.id);
    expect(service.resolve('usr_a', 'INBOX')).toEqual({ id: 'inbox', name: 'Inbox' });
  });
});
