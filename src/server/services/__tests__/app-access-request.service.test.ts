import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as SessionInvalidation from '~/server/auth/session-invalidation';

const { refreshSession } = vi.hoisted(() => ({ refreshSession: vi.fn(async () => undefined) }));
vi.mock('~/server/auth/session-invalidation', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionInvalidation>()),
  refreshSession,
}));

const {
  APP_ACCESS_ALREADY_APPROVED,
  APP_ACCESS_ALREADY_PENDING,
  decideAppAccessRequest,
  getMyAppAccessRequest,
  listAppAccessRequests,
  submitAppAccessRequest,
} = await import('../app-access-request.service');

/**
 * `AppAccessRequest` against REAL rows: the hand-applied migration runs on an in-process Postgres,
 * and every statement the service sends runs there as the parameterised text Prisma would send.
 *
 * The one-pending-per-user rule is a PARTIAL unique index the service targets with
 * `ON CONFLICT … WHERE`, and an approved row is the builder grant the auth hub reads. A mock can
 * tell neither a statement that hits that index nor a status transition from one that does not, so
 * only rows can test them — and nothing else in CI executes the migration SQL.
 */

const MIGRATION = join(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations/20261204120000_app_access_request/migration.sql'
);

// A stand-in for the real `User` table, cut to what the queue reads.
const PRELUDE = `CREATE TABLE "User" ("id" SERIAL PRIMARY KEY, "username" TEXT);`;

const MIRA_IDEA =
  'A pose-reference board that pulls my favourite model images into collections I can share.';
const MIRA_IDEA_AGAIN =
  'A pose-reference board with tagging, so a collection can be filtered by camera angle.';
const TOMASZ_IDEA = 'A prompt diary that shows how my results changed across model versions.';

/**
 * The auth hub's grant predicate, verbatim (`apps/auth/.../session-producer.ts`): EXISTS an
 * approved row. Asserted here against the rows the service writes, so a transition that leaves the
 * wrong status behind is a failing test rather than a silent grant or a silent non-revoke.
 */
const isApproved = async (userId: number) =>
  (
    await pg.query<{ approved: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM "AppAccessRequest" WHERE "userId" = $1 AND "status" = 'approved') AS "approved"`,
      [userId]
    )
  ).rows[0].approved;

let pg: PGlite;
let mira: number;
let tomasz: number;
let moderator: number;

const run = async (q: Prisma.Sql) =>
  (await pg.query<Record<string, unknown>>(q.text, q.values)).rows;

const seedUser = async (username: string) =>
  (
    await pg.query<{ id: number }>('INSERT INTO "User" ("username") VALUES ($1) RETURNING "id"', [
      username,
    ])
  ).rows[0].id;

const rowsFor = async (userId: number) =>
  (
    await pg.query<{ id: number; status: string; whatToBuild: string }>(
      'SELECT "id", "status", "whatToBuild" FROM "AppAccessRequest" WHERE "userId" = $1 ORDER BY "id"',
      [userId]
    )
  ).rows;

const submit = (userId: number, whatToBuild: string) =>
  submitAppAccessRequest({ userId, input: { whatToBuild } });
const decide = (id: number, decision: 'approved' | 'declined') =>
  decideAppAccessRequest({ moderatorId: moderator, input: { id, decision } });

// One cluster per file: initdb is most of a cluster's cost, so the tables are emptied between tests
// instead. RESTART IDENTITY gives every test the same ids a fresh cluster would.
beforeAll(async () => {
  pg = await PGlite.create();
  await pg.exec(PRELUDE);
  await pg.exec(readFileSync(MIGRATION, 'utf8'));
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec('TRUNCATE "AppAccessRequest", "User" RESTART IDENTITY');
  // Three users whose ids differ, so a statement keyed on the wrong one cannot pass by accident.
  moderator = await seedUser('queue_reviewer');
  mira = await seedUser('mira_builds');
  tomasz = await seedUser('tomasz_k');
  dbMock.dbWrite.$queryRaw.mockReset();
  dbMock.dbWrite.$queryRaw.mockImplementation(run as never);
  refreshSession.mockClear();
});

describe('submitAppAccessRequest', () => {
  it('creates one pending request with the text', async () => {
    const row = await submit(mira, MIRA_IDEA);
    expect(row).toMatchObject({ status: 'pending', whatToBuild: MIRA_IDEA, reviewedAt: null });
    expect(await rowsFor(mira)).toEqual([
      { id: row.id, status: 'pending', whatToBuild: MIRA_IDEA },
    ]);
    expect(await isApproved(mira)).toBe(false);
  });

  it('🔴 one pending request per person: a second submit is a CONFLICT and changes nothing', async () => {
    const first = await submit(mira, MIRA_IDEA);
    await expect(submit(mira, MIRA_IDEA_AGAIN)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: APP_ACCESS_ALREADY_PENDING,
    });
    expect(await rowsFor(mira)).toEqual([
      { id: first.id, status: 'pending', whatToBuild: MIRA_IDEA },
    ]);
  });

  it('keeps each person’s pending request separate', async () => {
    await submit(mira, MIRA_IDEA);
    await submit(tomasz, TOMASZ_IDEA);
    expect(await rowsFor(mira)).toHaveLength(1);
    expect(await rowsFor(tomasz)).toEqual([
      expect.objectContaining({ status: 'pending', whatToBuild: TOMASZ_IDEA }),
    ]);
  });

  it('after a decline, a new request is a NEW row and the declined one is kept', async () => {
    const first = await submit(mira, MIRA_IDEA);
    await decide(first.id, 'declined');
    const again = await submit(mira, MIRA_IDEA_AGAIN);
    expect(again.id).not.toBe(first.id);
    expect((await rowsFor(mira)).map((r) => r.status)).toEqual(['declined', 'pending']);
  });

  it('refuses a request from someone already approved, and writes nothing', async () => {
    const first = await submit(mira, MIRA_IDEA);
    await decide(first.id, 'approved');
    await expect(submit(mira, MIRA_IDEA_AGAIN)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: APP_ACCESS_ALREADY_APPROVED,
    });
    expect((await rowsFor(mira)).map((r) => r.status)).toEqual(['approved']);
  });
});

describe('the migration’s own guards', () => {
  it('🔴 the database refuses a second pending row for one user, whatever the service does', async () => {
    await submit(mira, MIRA_IDEA);
    await expect(
      pg.query(`INSERT INTO "AppAccessRequest" ("userId", "whatToBuild") VALUES ($1, 'second')`, [
        mira,
      ])
    ).rejects.toThrow(/AppAccessRequest_userId_pending_key/);
  });

  it('refuses a status outside the three', async () => {
    // `reviewedAt` set, so the review check passes and only the status check can refuse it.
    await expect(
      pg.query(
        `INSERT INTO "AppAccessRequest" ("userId", "whatToBuild", "status", "reviewedAt")
         VALUES ($1, 'x', 'granted', CURRENT_TIMESTAMP)`,
        [mira]
      )
    ).rejects.toThrow(/AppAccessRequest_status_check/);
  });

  it('refuses a decided row with no review time, and a pending row with one', async () => {
    await expect(
      pg.query(
        `INSERT INTO "AppAccessRequest" ("userId", "whatToBuild", "status") VALUES ($1, 'x', 'approved')`,
        [mira]
      )
    ).rejects.toThrow(/AppAccessRequest_review_check/);
    await expect(
      pg.query(
        `INSERT INTO "AppAccessRequest" ("userId", "whatToBuild", "reviewedAt") VALUES ($1, 'x', CURRENT_TIMESTAMP)`,
        [mira]
      )
    ).rejects.toThrow(/AppAccessRequest_review_check/);
  });
});

describe('getMyAppAccessRequest', () => {
  it('is null for someone who never asked', async () => {
    await submit(tomasz, TOMASZ_IDEA);
    expect(await getMyAppAccessRequest({ userId: mira })).toBeNull();
  });

  it('returns the latest request, decided ones included', async () => {
    const first = await submit(mira, MIRA_IDEA);
    await decide(first.id, 'declined');
    expect(await getMyAppAccessRequest({ userId: mira })).toMatchObject({
      id: first.id,
      status: 'declined',
    });
    const second = await submit(mira, MIRA_IDEA_AGAIN);
    expect(await getMyAppAccessRequest({ userId: mira })).toMatchObject({
      id: second.id,
      status: 'pending',
      whatToBuild: MIRA_IDEA_AGAIN,
    });
  });
});

describe('listAppAccessRequests', () => {
  it('filters by status, newest first, with the requester’s and reviewer’s usernames', async () => {
    const a = await submit(mira, MIRA_IDEA);
    const b = await submit(tomasz, TOMASZ_IDEA);
    await decide(a.id, 'approved');

    const pending = await listAppAccessRequests({ status: 'pending', limit: 50 });
    expect(pending.items.map((i) => [i.id, i.username])).toEqual([[b.id, 'tomasz_k']]);

    const approved = await listAppAccessRequests({ status: 'approved', limit: 50 });
    expect(approved.items).toEqual([
      expect.objectContaining({
        id: a.id,
        userId: mira,
        username: 'mira_builds',
        reviewedById: moderator,
        reviewedByUsername: 'queue_reviewer',
      }),
    ]);

    const all = await listAppAccessRequests({ limit: 50 });
    expect(all.items.map((i) => i.id)).toEqual([b.id, a.id]);
  });

  it('pages by id with a cursor, and stops', async () => {
    const a = await submit(mira, MIRA_IDEA);
    const b = await submit(tomasz, TOMASZ_IDEA);
    const page1 = await listAppAccessRequests({ limit: 1 });
    expect(page1.items.map((i) => i.id)).toEqual([b.id]);
    expect(page1.nextCursor).toBe(b.id);
    const page2 = await listAppAccessRequests({ limit: 1, cursor: page1.nextCursor! });
    expect(page2.items.map((i) => i.id)).toEqual([a.id]);
    expect(page2.nextCursor).toBeNull();
  });
});

describe('decideAppAccessRequest — approving GRANTS, declining an approved row REVOKES', () => {
  it('🔴 approve: the hub predicate turns true for THAT user only, and their session is refreshed', async () => {
    const req = await submit(mira, MIRA_IDEA);
    await submit(tomasz, TOMASZ_IDEA);
    const decided = await decide(req.id, 'approved');

    expect(decided).toMatchObject({ id: req.id, status: 'approved' });
    expect(decided.reviewedAt).toBeInstanceOf(Date);
    expect(await isApproved(mira)).toBe(true);
    expect(await isApproved(tomasz)).toBe(false);
    // The REQUESTER's session — not the moderator's.
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(refreshSession).toHaveBeenCalledWith(mira, { caller: 'moderation' });

    const [row] = (
      await pg.query<{ reviewedById: number }>(
        'SELECT "reviewedById" FROM "AppAccessRequest" WHERE "id" = $1',
        [req.id]
      )
    ).rows;
    expect(row.reviewedById).toBe(moderator);
  });

  it('🔴 decline of a pending request grants nothing, and still refreshes the requester', async () => {
    const req = await submit(mira, MIRA_IDEA);
    await decide(req.id, 'declined');
    expect(await isApproved(mira)).toBe(false);
    expect(refreshSession).toHaveBeenCalledWith(mira, { caller: 'moderation' });
  });

  it('🔴 revoke: declining an APPROVED request turns the predicate false and refreshes the session', async () => {
    const req = await submit(mira, MIRA_IDEA);
    await decide(req.id, 'approved');
    refreshSession.mockClear();

    const revoked = await decide(req.id, 'declined');
    expect(revoked).toMatchObject({ id: req.id, status: 'declined' });
    expect(await isApproved(mira)).toBe(false);
    expect(refreshSession).toHaveBeenCalledWith(mira, { caller: 'moderation' });
    // A revoked person can ask again.
    await expect(submit(mira, MIRA_IDEA_AGAIN)).resolves.toMatchObject({ status: 'pending' });
  });

  /**
   * Two approved rows for one person is reachable: `submit`'s "already approved?" read and its
   * INSERT are two statements, so a submit that reads before a moderator approves the pending row
   * and inserts after it leaves a second pending row, which a moderator can then approve too. The
   * grant is "EXISTS an approved row", so revoking only the row the moderator clicked would leave
   * the other one granting access.
   */
  const raceIntoTwoApprovedRows = async () => {
    const first = await submit(mira, MIRA_IDEA);
    await decide(first.id, 'approved');
    // The losing half of the race: the INSERT that ran after the approve (the service's read
    // would refuse it now, which is the point — it did not when it ran).
    const [{ id: secondId }] = (
      await pg.query<{ id: number }>(
        `INSERT INTO "AppAccessRequest" ("userId", "whatToBuild") VALUES ($1, $2) RETURNING "id"`,
        [mira, MIRA_IDEA_AGAIN]
      )
    ).rows;
    await decide(secondId, 'approved');
    expect((await rowsFor(mira)).map((r) => r.status)).toEqual(['approved', 'approved']);
    return { firstId: first.id, secondId };
  };

  it('🔴 revoke removes access even when the person holds TWO approved rows', async () => {
    const t = await submit(tomasz, TOMASZ_IDEA);
    await decide(t.id, 'approved');
    const { firstId, secondId } = await raceIntoTwoApprovedRows();
    refreshSession.mockClear();

    const revoked = await decide(firstId, 'declined');
    expect(revoked).toMatchObject({ id: firstId, status: 'declined' });
    expect(await isApproved(mira)).toBe(false);
    expect(await rowsFor(mira)).toEqual([
      { id: firstId, status: 'declined', whatToBuild: MIRA_IDEA },
      { id: secondId, status: 'declined', whatToBuild: MIRA_IDEA_AGAIN },
    ]);
    // Another person's grant is untouched, and only the requester's session is refreshed, once.
    expect(await isApproved(tomasz)).toBe(true);
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(refreshSession).toHaveBeenCalledWith(mira, { caller: 'moderation' });
  });

  it('🔴 declining a PENDING request does not revoke the same person’s approved one', async () => {
    const first = await submit(mira, MIRA_IDEA);
    await decide(first.id, 'approved');
    const [{ id: strayId }] = (
      await pg.query<{ id: number }>(
        `INSERT INTO "AppAccessRequest" ("userId", "whatToBuild") VALUES ($1, $2) RETURNING "id"`,
        [mira, MIRA_IDEA_AGAIN]
      )
    ).rows;

    await expect(decide(strayId, 'declined')).resolves.toMatchObject({
      id: strayId,
      status: 'declined',
    });
    expect((await rowsFor(mira)).map((r) => r.status)).toEqual(['approved', 'declined']);
    expect(await isApproved(mira)).toBe(true);
  });

  it('🔴 a declined request is not re-decided: approving it is a CONFLICT and grants nothing', async () => {
    const req = await submit(mira, MIRA_IDEA);
    await decide(req.id, 'declined');
    refreshSession.mockClear();
    await expect(decide(req.id, 'approved')).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'This request was already declined.',
    });
    expect((await rowsFor(mira)).map((r) => r.status)).toEqual(['declined']);
    expect(await isApproved(mira)).toBe(false);
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it('a second approve of the same request is a CONFLICT', async () => {
    const req = await submit(mira, MIRA_IDEA);
    await decide(req.id, 'approved');
    await expect(decide(req.id, 'approved')).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'This request was already approved.',
    });
  });

  it('a failed session refresh does not undo or fail the decision', async () => {
    const req = await submit(mira, MIRA_IDEA);
    refreshSession.mockRejectedValueOnce(new Error('sysredis down'));
    await expect(decide(req.id, 'approved')).resolves.toMatchObject({ status: 'approved' });
    expect(await isApproved(mira)).toBe(true);
  });

  it('is NOT_FOUND for an id that does not exist', async () => {
    await expect(decide(9_999, 'approved')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(refreshSession).not.toHaveBeenCalled();
  });
});
