import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';
import { quotaStatus } from '$lib/scan-labels';
import type { BlockDeps, BlockImageArgs } from '../scan-label.service';

/** The majority-block sweep, the quota report and the label view, against the real migrations. */

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../removal-hold', () => ({
  // No approved appeals here; the hold itself is covered by image-removal-confirmation.pglite.test.ts.
  holdRemovals: vi.fn(async (requests: { imageId: number }[]) => ({
    held: [],
    proceed: requests.map((r) => r.imageId),
  })),
}));
vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));

const { ACTION_CLAIM_MS, applyMajorityBlocks, castVote } = await import('../scan-label.service');
const { isModerationBlocked } = await import('../image-moderation.service');

const noop = () => vi.fn(async (_args: BlockImageArgs) => undefined);
const deps = (block: BlockDeps['block'] = noop()): BlockDeps => ({ block, isModerationBlocked });
const { getQuotaReport, removeFromRoster, setQuota, SCAN_LABEL_ROLE } = await import(
  '../scan-label-metrics.service'
);
const busted = () => ({ invalidateSession: vi.fn(async (_userId: number) => undefined) });

const BLOCK = { block: true, reason: 'real-person', reasonComment: null } as const;
const KEEP = { block: false } as const;

const HERE = dirname(fileURLToPath(import.meta.url));
const migration = (name: string) =>
  readFileSync(
    join(
      HERE,
      `../../../../../../packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`
    ),
    'utf8'
  );

let pg: PGlite;

beforeEach(async () => {
  pg = await freshPglite();
  await pg.exec(`
    CREATE TABLE "User" (
      "id" INTEGER PRIMARY KEY, "username" TEXT, "isModerator" BOOLEAN NOT NULL DEFAULT true
    );
    CREATE TABLE "Image" (
      "id" INTEGER PRIMARY KEY, "url" TEXT NOT NULL DEFAULT 'u', "pHash" BIGINT,
      "ingestion" TEXT NOT NULL DEFAULT 'Scanned', "blockedFor" TEXT, "metadata" JSONB
    );
    CREATE TABLE "OauthClient" ("id" TEXT PRIMARY KEY);
  `);
  await pg.exec(migration('20261022130000_scan_label_queue'));
  await pg.exec(migration('20261022140000_scan_label_outcomes'));
  await pg.exec(migration('20261023130000_scan_label_reasons_copy'));
  await pg.exec(migration('20261128120000_scan_label_claim_token'));
  await pg.exec(migration('20260626120000_add_user_roles_and_oauth_access'));
  await pg.exec(migration('20260630140000_add_role_table'));
  await pg.exec(`INSERT INTO "Role" ("id") VALUES ('moderator:scan-labels')`);
  dbHandle.current = new Kysely<DB>({ dialect: pgliteDialect(pg) });
});

async function seedItem(imageId: number): Promise<number> {
  await pg.query(`INSERT INTO "Image" ("id", "url", "pHash") VALUES ($1, $2, 42)`, [
    imageId,
    `key-${imageId}`,
  ]);
  const { rows } = await pg.query<{ id: number }>(
    `INSERT INTO "ScanLabelItem" ("imageId", "firstFlaggedAt") VALUES ($1, '2026-10-13T08:00:00Z') RETURNING id`,
    [imageId]
  );
  await pg.query(
    `INSERT INTO "ScanLabelFlag" ("itemId", "source", "flaggerVersion", "workflowId", "flaggedAt", "snapshot")
     VALUES ($1, 'orchestrator-scan', 'scan@1', $2, '2026-10-13T08:00:00Z', '{"k":1}')`,
    [rows[0].id, `wf-${imageId}`]
  );
  return rows[0].id;
}

const at = (iso: string) => new Date(iso);
const vote = (itemId: number, userId: number, block: boolean, when = '2026-10-13T10:00:00Z') =>
  castVote({ itemId, userId, choice: block ? BLOCK : KEEP, msOnItem: 1000 }, at(when));
const item = async (id: number) =>
  (await pg.query<Record<string, unknown>>(`SELECT * FROM "ScanLabelItem" WHERE id = $1`, [id]))
    .rows[0];

describe('applyMajorityBlocks', () => {
  it('blocks once a second block vote lands, as the moderator whose vote made the majority', async () => {
    const it1 = await seedItem(1);
    const block = vi.fn(async () => undefined);
    await vote(it1, 11, true, '2026-10-13T10:00:00Z');
    expect(await applyMajorityBlocks({}, deps(block))).toEqual({
      blocked: [],
      skipped: [],
      failed: [],
    });
    await vote(it1, 12, false, '2026-10-13T10:01:00Z');
    await vote(it1, 13, true, '2026-10-13T10:02:00Z');

    expect(await applyMajorityBlocks({ requester: 13, ip: '1.2.3.4' }, deps(block))).toEqual({
      blocked: [it1],
      skipped: [],
      failed: [],
    });
    expect(block).toHaveBeenCalledExactlyOnceWith({
      imageId: 1,
      userId: 13,
      ip: '1.2.3.4',
      userAgent: undefined,
      violationDetails: 'Scan label majority',
    });
    expect(await item(it1)).toMatchObject({ actionResult: 'blocked', actionError: null });
    expect((await item(it1)).actionedAt).not.toBeNull();
  });

  it('does not block an image that is already blocked, so its owner is not notified twice', async () => {
    const it1 = await seedItem(1);
    await pg.query(
      `UPDATE "Image" SET "ingestion" = 'Blocked', "blockedFor" = 'moderated' WHERE id = 1`
    );
    await vote(it1, 11, true);
    await vote(it1, 12, true);
    const block = vi.fn(async () => undefined);
    expect(await applyMajorityBlocks({}, deps(block))).toEqual({
      blocked: [],
      skipped: [{ itemId: it1, result: 'already-blocked' }],
      failed: [],
    });
    expect(block).not.toHaveBeenCalled();
    expect(await item(it1)).toMatchObject({ actionResult: 'already-blocked' });
  });

  it('still blocks an image held only by a weaker block', async () => {
    const graceBlocked = await seedItem(1);
    const otherReason = await seedItem(2);
    await pg.query(
      `UPDATE "Image" SET "ingestion" = 'Blocked', "blockedFor" = 'moderated',
         "metadata" = '{"accountDeletionPriorIngestion": "Scanned"}' WHERE id = 1`
    );
    await pg.query(
      `UPDATE "Image" SET "ingestion" = 'Blocked', "blockedFor" = 'other' WHERE id = 2`
    );
    for (const it of [graceBlocked, otherReason]) {
      await vote(it, 11, true);
      await vote(it, 12, true);
    }
    const block = noop();
    expect((await applyMajorityBlocks({}, deps(block))).blocked).toEqual([
      graceBlocked,
      otherReason,
    ]);
    expect(block).toHaveBeenCalledTimes(2);
  });

  it('retries its own half-finished block in full rather than taking it for someone else’s', async () => {
    const it1 = await seedItem(1);
    await vote(it1, 11, true);
    await vote(it1, 12, true);
    // The image row is blocked, then a side effect throws.
    const halfway = vi.fn(async () => {
      await pg.query(
        `UPDATE "Image" SET "ingestion" = 'Blocked', "blockedFor" = 'moderated' WHERE id = 1`
      );
      throw new Error('mod activity insert failed');
    });
    expect((await applyMajorityBlocks({}, deps(halfway))).failed).toHaveLength(1);
    const block = noop();
    expect((await applyMajorityBlocks({}, deps(block))).blocked).toEqual([it1]);
    expect(block).toHaveBeenCalledTimes(1);
    expect(await item(it1)).toMatchObject({ actionResult: 'blocked' });
  });

  it('takes over a claim left by a crashed sweep only once it is stale', async () => {
    const it1 = await seedItem(1);
    await vote(it1, 11, true);
    await vote(it1, 12, true);
    const crashedAt = new Date('2026-10-13T11:00:00Z');
    await pg.query(`UPDATE "ScanLabelItem" SET "actionStartedAt" = $1 WHERE id = $2`, [
      crashedAt,
      it1,
    ]);
    const block = vi.fn(async () => undefined);
    await applyMajorityBlocks(
      {},
      deps(block),
      () => new Date(crashedAt.getTime() + ACTION_CLAIM_MS - 1)
    );
    expect(block).not.toHaveBeenCalled();
    await applyMajorityBlocks(
      {},
      deps(block),
      () => new Date(crashedAt.getTime() + ACTION_CLAIM_MS + 1)
    );
    expect(block).toHaveBeenCalledTimes(1);
  });

  it('never blocks a void item', async () => {
    const it1 = await seedItem(1);
    await vote(it1, 11, true);
    await vote(it1, 12, true);
    await pg.query(`UPDATE "ScanLabelItem" SET status = 'void' WHERE id = $1`, [it1]);
    const block = vi.fn(async () => undefined);
    await applyMajorityBlocks({}, deps(block));
    expect(block).not.toHaveBeenCalled();
  });

  it('never blocks the same image twice', async () => {
    const it1 = await seedItem(1);
    await vote(it1, 11, true);
    await vote(it1, 12, true);
    const block = vi.fn(async () => undefined);
    await applyMajorityBlocks({}, deps(block));
    await vote(it1, 13, true);
    await applyMajorityBlocks({}, deps(block));
    expect(block).toHaveBeenCalledTimes(1);
  });

  it('blocks once when two sweeps run at the same time', async () => {
    const it1 = await seedItem(1);
    await vote(it1, 11, true);
    await vote(it1, 12, true);
    const block = vi.fn(async () => undefined);
    await Promise.all([applyMajorityBlocks({}, deps(block)), applyMajorityBlocks({}, deps(block))]);
    expect(block).toHaveBeenCalledTimes(1);
  });

  it('leaves a clear majority alone', async () => {
    const it1 = await seedItem(1);
    await vote(it1, 11, true);
    await vote(it1, 12, false);
    await vote(it1, 13, false);
    const block = vi.fn(async () => undefined);
    await applyMajorityBlocks({}, deps(block));
    expect(block).not.toHaveBeenCalled();
  });

  it('records a failure and retries it on the next sweep', async () => {
    const it1 = await seedItem(1);
    await vote(it1, 11, true);
    await vote(it1, 12, true);
    const failing = vi.fn(async () => {
      throw new Error('notifications down');
    });
    expect(await applyMajorityBlocks({}, deps(failing))).toEqual({
      blocked: [],
      skipped: [],
      failed: [{ itemId: it1, error: 'notifications down' }],
    });
    expect(await item(it1)).toMatchObject({
      actionedAt: null,
      actionStartedAt: null,
      actionError: 'notifications down',
    });

    const block = vi.fn(async () => undefined);
    expect((await applyMajorityBlocks({}, deps(block))).blocked).toEqual([it1]);
    expect(await item(it1)).toMatchObject({ actionError: null });
  });

  it('passes the requester’s address only when the requester is the acting moderator', async () => {
    const it1 = await seedItem(1);
    await vote(it1, 11, true);
    await vote(it1, 12, true);
    const block = vi.fn(async () => undefined);
    await applyMajorityBlocks({ requester: 99, ip: '9.9.9.9', userAgent: 'x' }, deps(block));
    expect(block).toHaveBeenCalledExactlyOnceWith({
      imageId: 1,
      userId: 12,
      violationDetails: 'Scan label majority',
    });
  });
});

describe('block reasons', () => {
  it('stores the reason and comment with a block vote', async () => {
    const it1 = await seedItem(1);
    await castVote(
      {
        itemId: it1,
        userId: 11,
        choice: { block: true, reason: 'other', reasonComment: 'self-harm' },
        msOnItem: 1,
      },
      at('2026-10-13T10:00:00Z')
    );
    const { rows } = await pg.query(`SELECT "reason", "reasonComment" FROM "ScanLabelVote"`);
    expect(rows).toEqual([{ reason: 'other', reasonComment: 'self-harm' }]);
  });

  it.each([
    ['a block with no reason', `TRUE, NULL, NULL`],
    ['a keep vote with a reason', `FALSE, 'real-person', NULL`],
    ['an unknown reason', `TRUE, 'made-up', NULL`],
    ['"other" with no comment', `TRUE, 'other', '  '`],
  ])('the database refuses %s', async (_, values) => {
    const it1 = await seedItem(1);
    await expect(
      pg.query(
        `INSERT INTO "ScanLabelVote" ("itemId", "userId", "block", "reason", "reasonComment")
         VALUES (${it1}, 11, ${values})`
      )
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('quota', () => {
  it('treats a day with no votes as a day off and a short day as a miss', () => {
    expect(quotaStatus(0, 50, true, true)).toBe('off');
    expect(quotaStatus(49, 50, true, true)).toBe('missed');
    expect(quotaStatus(50, 50, true, true)).toBe('met');
    expect(quotaStatus(10, 50, false, true)).toBe('unlisted');
    expect(quotaStatus(10, 50, true, false)).toBe('in-progress');
    expect(quotaStatus(50, 50, true, false)).toBe('met');
  });

  it('reports each roster moderator per UTC day', async () => {
    await pg.exec(`INSERT INTO "User" VALUES (1, 'ana'), (2, 'bo'), (3, 'cy')`);
    const deps = busted();
    const add = (userId: number) =>
      setQuota({ userId, dailyVotes: 50, active: true, updatedBy: 9 }, deps);
    expect(await add(1)).toMatchObject({ ok: true });
    expect(await add(2)).toMatchObject({ ok: true });
    expect(await add(404)).toEqual({ ok: false, reason: 'no-user' });

    const ids: number[] = [];
    for (let i = 0; i < 55; i++) ids.push(await seedItem(100 + i));
    // ana: 50 on the 12th (the last at 23:59 UTC), 5 on the 13th. bo: nothing. cy: 3, not on the roster.
    for (let i = 0; i < 49; i++) await vote(ids[i], 1, false, '2026-10-12T10:00:00Z');
    await vote(ids[49], 1, false, '2026-10-12T23:59:59Z');
    for (let i = 50; i < 55; i++) await vote(ids[i], 1, false, '2026-10-13T00:00:00Z');
    for (let i = 0; i < 3; i++) await vote(ids[i], 3, false, '2026-10-12T10:00:00Z');

    const report = await getQuotaReport('2026-10-13', 2, new Date('2026-10-14T01:00:00Z'));
    const byName = Object.fromEntries(report.map((r) => [r.username ?? '', r] as const));
    expect(byName.ana.days).toEqual([
      { day: '2026-10-12', votes: 50, status: 'met' },
      { day: '2026-10-13', votes: 5, status: 'missed' },
    ]);
    expect(byName.bo.days.map((d) => d.status)).toEqual(['off', 'off']);
    expect(byName.cy).toMatchObject({ onRoster: false });
    expect(byName.cy.days.map((d) => d.status)).toEqual(['unlisted', 'unlisted']);

    const sameDay = await getQuotaReport('2026-10-13', 1, new Date('2026-10-13T12:00:00Z'));
    expect(sameDay.find((r) => r.username === 'ana')!.days).toEqual([
      { day: '2026-10-13', votes: 5, status: 'in-progress' },
    ]);
    // 55 votes, each its own transaction: slow under a loaded machine, not stuck.
  }, 30_000);

  it('drops a moderator taken off the roster unless they voted', async () => {
    await pg.exec(`INSERT INTO "User" VALUES (1, 'ana')`);
    await setQuota({ userId: 1, dailyVotes: 60, active: false, updatedBy: 9 }, busted());
    expect(await getQuotaReport('2026-10-12', 1)).toEqual([]);
  });

  it('refuses a quota under the floor in the database too', async () => {
    await pg.exec(`INSERT INTO "User" VALUES (1, 'ana')`);
    await expect(
      setQuota({ userId: 1, dailyVotes: 49, active: true, updatedBy: 9 }, busted())
    ).rejects.toThrow();
  });
});

describe('roster access', () => {
  const roles = async (userId: number) =>
    (
      await pg.query<{ role: string; note: string | null; addedById: number | null }>(
        `SELECT "role", "note", "addedById" FROM "UserRole" WHERE "userId" = $1 ORDER BY "role"`,
        [userId]
      )
    ).rows;
  const quota = async (userId: number) =>
    (
      await pg.query<{ active: boolean; dailyVotes: number; updatedBy: number }>(
        `SELECT "active", "dailyVotes", "updatedBy" FROM "ScanLabelQuota" WHERE "userId" = $1`,
        [userId]
      )
    ).rows[0];
  const add = (userId: number, deps = busted(), dailyVotes = 50) =>
    setQuota({ userId, dailyVotes, active: true, updatedBy: 9 }, deps);

  it('grants the page role on add, records who added them, and busts their session', async () => {
    await pg.exec(`INSERT INTO "User" VALUES (1, 'ana', true)`);
    const deps = busted();
    expect(await add(1, deps)).toEqual({ ok: true, username: 'ana', sessionBusted: true });
    expect(await roles(1)).toEqual([
      { role: SCAN_LABEL_ROLE, note: 'Scan Labels roster', addedById: 9 },
    ]);
    expect(await quota(1)).toEqual({ active: true, dailyVotes: 50, updatedBy: 9 });
    expect(deps.invalidateSession).toHaveBeenCalledWith(1);
  });

  it('keeps the original grant when a member is saved again with a new quota', async () => {
    await pg.exec(`INSERT INTO "User" VALUES (1, 'ana', true)`);
    await pg.exec(
      `INSERT INTO "UserRole" ("userId", "role", "note", "addedById")
       VALUES (1, 'moderator:scan-labels', 'by hand', 7)`
    );
    expect(await add(1, busted(), 80)).toMatchObject({ ok: true });
    expect(await roles(1)).toEqual([{ role: SCAN_LABEL_ROLE, note: 'by hand', addedById: 7 }]);
    expect(await quota(1)).toMatchObject({ dailyVotes: 80 });
  });

  it('refuses to add a user who is not a moderator, writing nothing', async () => {
    await pg.exec(`INSERT INTO "User" VALUES (2, 'bo', false)`);
    const deps = busted();
    expect(await add(2, deps)).toEqual({ ok: false, reason: 'not-moderator' });
    expect(await roles(2)).toEqual([]);
    expect(await quota(2)).toBeUndefined();
    expect(deps.invalidateSession).not.toHaveBeenCalled();
  });

  it('revokes the role on remove, keeping the quota, including a grant made elsewhere', async () => {
    await pg.exec(`INSERT INTO "User" VALUES (1, 'ana', true), (2, 'bo', true)`);
    await add(1, busted(), 70);
    await add(2);
    await pg.exec(`UPDATE "UserRole" SET "note" = 'from the hub' WHERE "userId" = 2`);
    await pg.exec(`INSERT INTO "Role" ("id") VALUES ('moderator:other')`);
    await pg.exec(`INSERT INTO "UserRole" ("userId", "role") VALUES (1, 'moderator:other')`);

    const deps = busted();
    expect(await removeFromRoster({ userId: 1, updatedBy: 5 }, deps)).toEqual({
      ok: true,
      username: 'ana',
      sessionBusted: true,
    });
    expect(await removeFromRoster({ userId: 2, updatedBy: 5 }, deps)).toMatchObject({ ok: true });
    expect(await roles(1)).toEqual([{ role: 'moderator:other', note: null, addedById: null }]);
    expect(await roles(2)).toEqual([]);
    expect(await quota(1)).toEqual({ active: false, dailyVotes: 70, updatedBy: 5 });
    expect(deps.invalidateSession.mock.calls).toEqual([[1], [2]]);
  });

  it('refuses to remove someone not on the roster', async () => {
    await pg.exec(`INSERT INTO "User" VALUES (1, 'ana', true)`);
    const deps = busted();
    expect(await removeFromRoster({ userId: 1, updatedBy: 5 }, deps)).toEqual({
      ok: false,
      reason: 'not-on-roster',
    });
    expect(deps.invalidateSession).not.toHaveBeenCalled();
  });

  it('commits the roster and role change when the session bust fails', async () => {
    await pg.exec(`INSERT INTO "User" VALUES (1, 'ana', true)`);
    const failing = { invalidateSession: vi.fn(async () => Promise.reject(new Error('hub down'))) };
    expect(await add(1, failing)).toEqual({ ok: true, username: 'ana', sessionBusted: false });
    expect(await roles(1)).toHaveLength(1);
    expect(await quota(1)).toMatchObject({ active: true });

    expect(await removeFromRoster({ userId: 1, updatedBy: 9 }, failing)).toMatchObject({
      ok: true,
      sessionBusted: false,
    });
    expect(await roles(1)).toEqual([]);
    expect(await quota(1)).toMatchObject({ active: false });
    expect(failing.invalidateSession).toHaveBeenCalledTimes(2);
  });

  it('refuses to add anyone while the role is missing, writing nothing', async () => {
    await pg.exec(`INSERT INTO "User" VALUES (1, 'ana', true)`);
    await pg.exec(`DELETE FROM "Role"`);
    expect(await add(1)).toEqual({ ok: false, reason: 'no-role' });
    expect(await quota(1)).toBeUndefined();
  });

  it('rolls the quota back when the role grant fails', async () => {
    await pg.exec(`INSERT INTO "User" VALUES (1, 'ana', true)`);
    await pg.exec(`
      CREATE FUNCTION refuse() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'refused'; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER refuse BEFORE INSERT ON "UserRole" FOR EACH ROW EXECUTE FUNCTION refuse();
    `);
    await expect(add(1)).rejects.toThrow('refused');
    expect(await quota(1)).toBeUndefined();
  });
});

describe('ScanLabelExport', () => {
  it('lists decided items only, with every flag', async () => {
    const decided = await seedItem(1);
    const open = await seedItem(2);
    await pg.query(
      `INSERT INTO "ScanLabelFlag" ("itemId", "source", "flaggerVersion", "workflowId", "flaggedAt")
       VALUES ($1, 'xguard-prompt', 'prompt@1', 'wf-1b', '2026-10-13T09:00:00Z')`,
      [decided]
    );
    for (const u of [11, 12, 13]) await vote(decided, u, true);
    await vote(open, 11, false);

    const { rows } = await pg.query<Record<string, unknown>>(`SELECT * FROM "ScanLabelExport"`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      itemId: decided,
      imageId: 1,
      mediaKey: 'key-1',
      outcome: 'block',
      votes: 3,
      blockVotes: 3,
      unanimous: true,
      workflowIds: ['wf-1', 'wf-1b'],
    });
    expect([...(rows[0].flaggerVersions as string[])].sort()).toEqual(['prompt@1', 'scan@1']);
    expect((rows[0].flags as { snapshot: unknown }[])[0].snapshot).toEqual({ k: 1 });
  });
});
