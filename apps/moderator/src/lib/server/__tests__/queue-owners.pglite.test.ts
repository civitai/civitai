import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { executableSchemaSql, pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * The owner write path against `apps/moderator/queue-owners/schema.sql` in an in-process Postgres: no
 * owner changes without its history row, and a save never reverts a change it did not see.
 */

const SCHEMA = join(dirname(fileURLToPath(import.meta.url)), '../../../../queue-owners/schema.sql');

let pg: PGlite;
let kysely: Kysely<unknown>;
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/moderator-db', () => ({ getModeratorDb: () => kysely }));

const owners = await import('../queue-owners');

beforeEach(async () => {
  pg = await freshPglite();
  await pg.exec(executableSchemaSql(readFileSync(SCHEMA, 'utf8')));
  kysely = new Kysely({ dialect: pgliteDialect(pg) });
});
afterEach(async () => {
  await pg.close();
});

const ADMIN = 1;
const history = async () =>
  (
    await pg.query<{ path: string; owners_before: number[]; owners_after: number[] }>(
      'SELECT path, owners_before, owners_after FROM queue_owner_change ORDER BY id'
    )
  ).rows;

describe('changeQueueOwners', () => {
  it('writes the owners and one history row per changed queue', async () => {
    const result = await owners.changeQueueOwners({
      entries: [
        { path: '/a', owners: [10, 11] },
        { path: '/b', owners: [12] },
      ],
      expect: { '/a': [], '/b': [] },
      actorId: ADMIN,
    });
    expect(result).toEqual({ changed: 2 });
    expect(await owners.listQueueOwners()).toEqual({ '/a': [10, 11], '/b': [12] });
    expect(await owners.ownedQueuePaths(11)).toEqual(['/a']);
    expect(await history()).toEqual([
      { path: '/a', owners_before: [], owners_after: [10, 11] },
      { path: '/b', owners_before: [], owners_after: [12] },
    ]);
  });

  it('removing the last owner leaves the queue unowned', async () => {
    await owners.changeQueueOwners({
      entries: [{ path: '/a', owners: [10, 11] }],
      expect: { '/a': [] },
      actorId: ADMIN,
    });
    await owners.changeQueueOwners({
      entries: [{ path: '/a', owners: [11] }],
      expect: { '/a': [10, 11] },
      actorId: ADMIN,
    });
    expect(await owners.listQueueOwners()).toEqual({ '/a': [11] });
    await owners.changeQueueOwners({
      entries: [{ path: '/a', owners: [] }],
      expect: { '/a': [11] },
      actorId: ADMIN,
    });
    expect(await owners.listQueueOwners()).toEqual({});
    expect((await history()).map((h) => h.owners_after)).toEqual([[10, 11], [11], []]);
  });

  it('refuses a save whose expected owners are stale, and writes nothing at all', async () => {
    await owners.changeQueueOwners({
      entries: [{ path: '/a', owners: [10] }],
      expect: { '/a': [] },
      actorId: ADMIN,
    });
    // Another admin's page, loaded before /a got its owner, saves /a and /b together.
    await expect(
      owners.changeQueueOwners({
        entries: [
          { path: '/b', owners: [12] },
          { path: '/a', owners: [13] },
        ],
        expect: { '/b': [], '/a': [] },
        actorId: 2,
      })
    ).rejects.toBeInstanceOf(owners.QueueOwnerConflictError);
    expect(await owners.listQueueOwners()).toEqual({ '/a': [10] });
    expect(await history()).toHaveLength(1);
  });

  it('refuses an entry that does not say what it replaces', async () => {
    await expect(
      owners.changeQueueOwners({ entries: [{ path: '/a', owners: [10] }], expect: {}, actorId: 1 })
    ).rejects.toBeInstanceOf(owners.QueueOwnerConflictError);
    expect(await owners.listQueueOwners()).toEqual({});
  });

  it('records nothing for a save that changes nothing, whatever the order', async () => {
    await owners.changeQueueOwners({
      entries: [{ path: '/a', owners: [10, 11] }],
      expect: { '/a': [] },
      actorId: ADMIN,
    });
    const result = await owners.changeQueueOwners({
      entries: [{ path: '/a', owners: [11, 10] }],
      expect: { '/a': [10, 11] },
      actorId: ADMIN,
    });
    expect(result).toEqual({ changed: 0 });
    expect(await history()).toHaveLength(1);
  });

  it('leaves no history row for a change that failed to land', async () => {
    // Any failure after the history insert; a constraint is simply the easiest one to provoke.
    await pg.exec('ALTER TABLE queue_owner ADD CONSTRAINT test_small_ids CHECK (user_id < 1000)');
    await expect(
      owners.changeQueueOwners({
        entries: [{ path: '/a', owners: [5000] }],
        expect: { '/a': [] },
        actorId: ADMIN,
      })
    ).rejects.toBeInstanceOf(owners.QueueOwnersUnavailableError);
    expect(await history()).toEqual([]);
  });

  it('makes no change it cannot record', async () => {
    await pg.exec('DROP TABLE queue_owner_change');
    await expect(
      owners.changeQueueOwners({
        entries: [{ path: '/a', owners: [10] }],
        expect: { '/a': [] },
        actorId: ADMIN,
      })
    ).rejects.toBeInstanceOf(owners.QueueOwnersUnavailableError);
    expect(await owners.listQueueOwners()).toEqual({});
  });
});
