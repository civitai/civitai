import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
// Relative, because `~` does not reach `apps/`.
import { freshPglite } from '../../../../apps/moderator/src/test/pglite';
import {
  APP_ACCESS_ALREADY_APPROVED,
  decideAppAccessRequest,
  getMyAppAccessRequest,
  listAppAccessRequests,
  submitAppAccessRequest,
} from '../app-access-request.service';

/**
 * `AppAccessRequest` against REAL rows: the hand-applied migration runs on an in-process Postgres,
 * and every statement the service sends runs there as the parameterised text Prisma would send.
 *
 * The one-pending-per-user rule is a PARTIAL unique index the service targets with
 * `ON CONFLICT … WHERE`. A mock cannot tell a statement that hits that index from one that inserts a
 * second row, so only rows can test the idempotent resubmit — and nothing else in CI executes the
 * migration SQL.
 */

const MIGRATION = join(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations/20261204120000_app_access_request/migration.sql'
);

// A stand-in for the real `User` table, cut to what the queue reads.
const PRELUDE = `CREATE TABLE "User" ("id" SERIAL PRIMARY KEY, "username" TEXT);`;

const MIRA_IDEA =
  'A pose-reference board that pulls my favourite model images into collections I can share.';
const MIRA_IDEA_EDITED =
  'A pose-reference board with tagging, so a collection can be filtered by camera angle.';
const TOMASZ_IDEA = 'A prompt diary that shows how my results changed across model versions.';
const MIRA_LINKS = ['https://example.com/sketch-board', 'https://example.org/inspiration'];
const MIRA_LINKS_EDITED = ['https://example.net/sketch-v2'];

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
    await pg.query<{ id: number; status: string; whatToBuild: string; links: string[] }>(
      'SELECT "id", "status", "whatToBuild", "links" FROM "AppAccessRequest" WHERE "userId" = $1 ORDER BY "id"',
      [userId]
    )
  ).rows;

const submit = (userId: number, whatToBuild: string, links: string[] = []) =>
  submitAppAccessRequest({ userId, input: { whatToBuild, links } });

beforeEach(async () => {
  pg = await freshPglite();
  await pg.exec(PRELUDE);
  await pg.exec(readFileSync(MIGRATION, 'utf8'));
  // Three users whose ids differ, so a statement keyed on the wrong one cannot pass by accident.
  moderator = await seedUser('queue_reviewer');
  mira = await seedUser('mira_builds');
  tomasz = await seedUser('tomasz_k');
  dbMock.dbWrite.$queryRaw.mockReset();
  dbMock.dbWrite.$queryRaw.mockImplementation(run as never);
});

afterEach(async () => {
  await pg.close();
});

describe('the fixtures', () => {
  it('seeds three distinct users', () => {
    expect(new Set([moderator, mira, tomasz]).size).toBe(3);
  });
});

describe('submitAppAccessRequest', () => {
  it('creates one pending request with the text and links', async () => {
    const row = await submit(mira, MIRA_IDEA, MIRA_LINKS);
    expect(row).toMatchObject({
      status: 'pending',
      whatToBuild: MIRA_IDEA,
      links: MIRA_LINKS,
      reviewedAt: null,
    });
    expect(await rowsFor(mira)).toEqual([
      { id: row.id, status: 'pending', whatToBuild: MIRA_IDEA, links: MIRA_LINKS },
    ]);
  });

  it('🔴 a resubmit UPDATES the pending request instead of adding a second one', async () => {
    const first = await submit(mira, MIRA_IDEA, MIRA_LINKS);
    const second = await submit(mira, MIRA_IDEA_EDITED, MIRA_LINKS_EDITED);
    expect(second.id).toBe(first.id);
    expect(await rowsFor(mira)).toEqual([
      { id: first.id, status: 'pending', whatToBuild: MIRA_IDEA_EDITED, links: MIRA_LINKS_EDITED },
    ]);
  });

  it('keeps each person’s pending request separate', async () => {
    await submit(mira, MIRA_IDEA, MIRA_LINKS);
    await submit(tomasz, TOMASZ_IDEA);
    expect(await rowsFor(mira)).toHaveLength(1);
    expect(await rowsFor(tomasz)).toEqual([
      expect.objectContaining({ status: 'pending', whatToBuild: TOMASZ_IDEA, links: [] }),
    ]);
  });

  it('after a decline, a new request is a NEW row and the declined one is kept', async () => {
    const first = await submit(mira, MIRA_IDEA);
    await decideAppAccessRequest({
      moderatorId: moderator,
      input: { id: first.id, decision: 'declined' },
    });
    const again = await submit(mira, MIRA_IDEA_EDITED);
    expect(again.id).not.toBe(first.id);
    expect((await rowsFor(mira)).map((r) => r.status)).toEqual(['declined', 'pending']);
  });

  it('refuses a request from someone already approved, and writes nothing', async () => {
    const first = await submit(mira, MIRA_IDEA);
    await decideAppAccessRequest({
      moderatorId: moderator,
      input: { id: first.id, decision: 'approved' },
    });
    await expect(submit(mira, MIRA_IDEA_EDITED)).rejects.toMatchObject({
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
    await decideAppAccessRequest({
      moderatorId: moderator,
      input: { id: first.id, decision: 'declined' },
    });
    expect(await getMyAppAccessRequest({ userId: mira })).toMatchObject({
      id: first.id,
      status: 'declined',
    });
    const second = await submit(mira, MIRA_IDEA_EDITED, MIRA_LINKS_EDITED);
    expect(await getMyAppAccessRequest({ userId: mira })).toMatchObject({
      id: second.id,
      status: 'pending',
      whatToBuild: MIRA_IDEA_EDITED,
      links: MIRA_LINKS_EDITED,
    });
  });
});

describe('listAppAccessRequests', () => {
  it('filters by status, newest first, with the requester’s and reviewer’s usernames', async () => {
    const a = await submit(mira, MIRA_IDEA);
    const b = await submit(tomasz, TOMASZ_IDEA);
    await decideAppAccessRequest({
      moderatorId: moderator,
      input: { id: a.id, decision: 'approved' },
    });

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

describe('decideAppAccessRequest', () => {
  it('records the decision, who made it and when', async () => {
    const req = await submit(mira, MIRA_IDEA);
    const decided = await decideAppAccessRequest({
      moderatorId: moderator,
      input: { id: req.id, decision: 'approved' },
    });
    expect(decided).toMatchObject({ id: req.id, status: 'approved' });
    expect(decided.reviewedAt).toBeInstanceOf(Date);
    const [row] = (
      await pg.query<{ reviewedById: number }>(
        'SELECT "reviewedById" FROM "AppAccessRequest" WHERE "id" = $1',
        [req.id]
      )
    ).rows;
    expect(row.reviewedById).toBe(moderator);
  });

  it('🔴 a decided request is not re-decided: the second decision is a CONFLICT', async () => {
    const req = await submit(mira, MIRA_IDEA);
    await decideAppAccessRequest({
      moderatorId: moderator,
      input: { id: req.id, decision: 'declined' },
    });
    await expect(
      decideAppAccessRequest({
        moderatorId: moderator,
        input: { id: req.id, decision: 'approved' },
      })
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'This request was already declined.' });
    expect((await rowsFor(mira)).map((r) => r.status)).toEqual(['declined']);
  });

  it('is NOT_FOUND for an id that does not exist', async () => {
    await expect(
      decideAppAccessRequest({ moderatorId: moderator, input: { id: 9_999, decision: 'approved' } })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
