import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';
import { quotaStatus } from '$lib/scan-labels';

/** The majority-block sweep, the quota report and the label view, against the real migrations. */

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

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

const { applyMajorityBlocks, castVote } = await import('../scan-label.service');
const { getQuotaReport, setQuota } = await import('../scan-label-metrics.service');

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
  pg = await PGlite.create();
  await pg.exec(`
    CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "username" TEXT);
    CREATE TABLE "Image" ("id" INTEGER PRIMARY KEY, "url" TEXT NOT NULL DEFAULT 'u', "pHash" BIGINT);
  `);
  await pg.exec(migration('20261022130000_scan_label_queue'));
  await pg.exec(migration('20261022140000_scan_label_export_view'));
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
  castVote({ itemId, userId, block, msOnItem: 1000 }, at(when));
const item = async (id: number) =>
  (await pg.query<Record<string, unknown>>(`SELECT * FROM "ScanLabelItem" WHERE id = $1`, [id]))
    .rows[0];

describe('applyMajorityBlocks', () => {
  it('blocks once a second block vote lands, as the moderator whose vote made the majority', async () => {
    const it1 = await seedItem(1);
    const block = vi.fn(async () => undefined);
    await vote(it1, 11, true, '2026-10-13T10:00:00Z');
    expect(await applyMajorityBlocks({}, block)).toEqual({ blocked: [], failed: [] });
    await vote(it1, 12, false, '2026-10-13T10:01:00Z');
    await vote(it1, 13, true, '2026-10-13T10:02:00Z');

    expect(await applyMajorityBlocks({ requester: 13, ip: '1.2.3.4' }, block)).toEqual({
      blocked: [it1],
      failed: [],
    });
    expect(block).toHaveBeenCalledExactlyOnceWith({
      imageId: 1,
      userId: 13,
      ip: '1.2.3.4',
      userAgent: undefined,
      violationDetails: 'Scan label majority',
    });
    expect((await item(it1)).actionedAt).not.toBeNull();
  });

  it('never blocks the same image twice', async () => {
    const it1 = await seedItem(1);
    await vote(it1, 11, true);
    await vote(it1, 12, true);
    const block = vi.fn(async () => undefined);
    await applyMajorityBlocks({}, block);
    await vote(it1, 13, true);
    await applyMajorityBlocks({}, block);
    expect(block).toHaveBeenCalledTimes(1);
  });

  it('blocks once when two sweeps run at the same time', async () => {
    const it1 = await seedItem(1);
    await vote(it1, 11, true);
    await vote(it1, 12, true);
    const block = vi.fn(async () => undefined);
    await Promise.all([applyMajorityBlocks({}, block), applyMajorityBlocks({}, block)]);
    expect(block).toHaveBeenCalledTimes(1);
  });

  it('leaves a clear majority alone', async () => {
    const it1 = await seedItem(1);
    await vote(it1, 11, true);
    await vote(it1, 12, false);
    await vote(it1, 13, false);
    const block = vi.fn(async () => undefined);
    await applyMajorityBlocks({}, block);
    expect(block).not.toHaveBeenCalled();
  });

  it('records a failure and retries it on the next sweep', async () => {
    const it1 = await seedItem(1);
    await vote(it1, 11, true);
    await vote(it1, 12, true);
    const failing = vi.fn(async () => {
      throw new Error('notifications down');
    });
    expect(await applyMajorityBlocks({}, failing)).toEqual({
      blocked: [],
      failed: [{ itemId: it1, error: 'notifications down' }],
    });
    expect(await item(it1)).toMatchObject({ actionedAt: null, actionError: 'notifications down' });

    const block = vi.fn(async () => undefined);
    expect((await applyMajorityBlocks({}, block)).blocked).toEqual([it1]);
    expect(await item(it1)).toMatchObject({ actionError: null });
  });

  it('passes the requester’s address only when the requester is the acting moderator', async () => {
    const it1 = await seedItem(1);
    await vote(it1, 11, true);
    await vote(it1, 12, true);
    const block = vi.fn(async () => undefined);
    await applyMajorityBlocks({ requester: 99, ip: '9.9.9.9', userAgent: 'x' }, block);
    expect(block).toHaveBeenCalledExactlyOnceWith({
      imageId: 1,
      userId: 12,
      violationDetails: 'Scan label majority',
    });
  });
});

describe('quota', () => {
  it('treats a day with no votes as a day off and a short day as a miss', () => {
    expect(quotaStatus(0, 50, true)).toBe('off');
    expect(quotaStatus(49, 50, true)).toBe('missed');
    expect(quotaStatus(50, 50, true)).toBe('met');
    expect(quotaStatus(10, 50, false)).toBe('unlisted');
  });

  it('reports each roster moderator per UTC day', async () => {
    await pg.exec(`INSERT INTO "User" VALUES (1, 'ana'), (2, 'bo'), (3, 'cy')`);
    expect(await setQuota({ userId: 1, dailyVotes: 50, active: true, updatedBy: 9 })).toBe(true);
    expect(await setQuota({ userId: 2, dailyVotes: 50, active: true, updatedBy: 9 })).toBe(true);
    expect(await setQuota({ userId: 404, dailyVotes: 50, active: true, updatedBy: 9 })).toBe(false);

    const ids: number[] = [];
    for (let i = 0; i < 55; i++) ids.push(await seedItem(100 + i));
    // ana: 50 on the 12th (the last at 23:59 UTC), 5 on the 13th. bo: nothing. cy: 3, not on the roster.
    for (let i = 0; i < 49; i++) await vote(ids[i], 1, false, '2026-10-12T10:00:00Z');
    await vote(ids[49], 1, false, '2026-10-12T23:59:59Z');
    for (let i = 50; i < 55; i++) await vote(ids[i], 1, false, '2026-10-13T00:00:00Z');
    for (let i = 0; i < 3; i++) await vote(ids[i], 3, false, '2026-10-12T10:00:00Z');

    const report = await getQuotaReport('2026-10-12', '2026-10-13');
    const byName = Object.fromEntries(report.map((r) => [r.username, r]));
    expect(byName.ana.days).toEqual([
      { day: '2026-10-12', votes: 50, status: 'met' },
      { day: '2026-10-13', votes: 5, status: 'missed' },
    ]);
    expect(byName.bo.days.map((d) => d.status)).toEqual(['off', 'off']);
    expect(byName.cy).toMatchObject({ onRoster: false });
    expect(byName.cy.days.map((d) => d.status)).toEqual(['unlisted', 'unlisted']);
  });

  it('drops a moderator taken off the roster unless they voted', async () => {
    await pg.exec(`INSERT INTO "User" VALUES (1, 'ana')`);
    await setQuota({ userId: 1, dailyVotes: 60, active: false, updatedBy: 9 });
    expect(await getQuotaReport('2026-10-12', '2026-10-12')).toEqual([]);
  });

  it('refuses a quota under the floor in the database too', async () => {
    await pg.exec(`INSERT INTO "User" VALUES (1, 'ana')`);
    await expect(
      setQuota({ userId: 1, dailyVotes: 49, active: true, updatedBy: 9 })
    ).rejects.toThrow();
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
