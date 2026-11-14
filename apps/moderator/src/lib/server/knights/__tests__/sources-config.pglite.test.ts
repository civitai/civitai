import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { REDIS_SYS_KEYS } from '@civitai/redis';
import { parseKnightsSourcesConfig } from '@civitai/shared/new-order';
import { freshPglite } from '../../../../test/pglite';
import { pgliteDialect } from '../../__tests__/abuse-detection-pglite.harness';

vi.setConfig({ hookTimeout: 60_000 });

const KEY = REDIS_SYS_KEYS.SYSTEM.KNIGHTS_V2_SOURCES;

const { dbHandle, redisStore } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  redisStore: new Map<string, string>(),
}));

vi.mock('../../db', () => ({
  get dbRead() {
    return dbHandle.current;
  },
  get dbWrite() {
    return dbHandle.current;
  },
}));
vi.mock('../../image-nsfw-level', () => ({ updateImageNsfwLevel: vi.fn() }));
vi.mock('../../redis', () => ({
  getSysRedis: () => ({
    get: async (key: string) => redisStore.get(key) ?? null,
    set: async (key: string, value: string) => {
      redisStore.set(key, value);
      return 'OK';
    },
  }),
}));

const {
  getLastSourcesChange,
  getSourcesContext,
  getSourcesSettings,
  saveSourcesConfig,
  SOURCES_AUDIT_ACTIVITY,
} = await import('../sources-config.service');

const MIGRATIONS = path.resolve(
  __dirname,
  '../../../../../../../packages/civitai-db-schema/prisma/migrations'
);

const Q = 'knights.image.nsfwLevel';
const MOD = 7;

let db: PGlite;

const insertItem = (
  id: number,
  source: string,
  status: string,
  minRank: string,
  createdAt: string,
  questionKey = Q
) =>
  db.query(
    `INSERT INTO "KnightsQueueItem" ("id","questionKey","imageId","source","minRank","votesNeeded","status","createdAt")
     VALUES ($1,$2,$1,$3,$4,5,$5,$6::timestamp)`,
    [id, questionKey, source, minRank, status, createdAt]
  );

const activity = async () =>
  (
    await db.query<{ userId: number; activity: string }>(
      `SELECT "userId","activity" FROM "ModActivity" ORDER BY "id"`
    )
  ).rows;

beforeAll(async () => {
  db = await freshPglite();
  await db.exec(`
    CREATE TABLE "Image" (
      "id" INTEGER PRIMARY KEY, "url" TEXT NOT NULL DEFAULT 'u', "name" TEXT, "type" TEXT NOT NULL DEFAULT 'image',
      "nsfwLevel" INTEGER NOT NULL DEFAULT 0, "nsfwLevelLocked" BOOLEAN NOT NULL DEFAULT false,
      "ingestion" TEXT NOT NULL DEFAULT 'Scanned', "blockedFor" TEXT
    );
    CREATE TABLE "User" (
      "id" INTEGER PRIMARY KEY, "username" TEXT, "bannedAt" TIMESTAMP, "muted" BOOLEAN NOT NULL DEFAULT false,
      "deletedAt" TIMESTAMP, "isModerator" BOOLEAN NOT NULL DEFAULT false
    );
    CREATE TABLE "ModActivity" (
      "id" SERIAL PRIMARY KEY, "userId" INTEGER, "activity" TEXT NOT NULL, "entityType" TEXT,
      "entityId" INTEGER, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "host" TEXT
    );
  `);
  await db.exec(
    readFileSync(path.join(MIGRATIONS, '20261210120000_knights_v2_tables', 'migration.sql'), 'utf8')
  );
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  redisStore.clear();
  await db.exec(
    `DELETE FROM "KnightsQueueItem"; DELETE FROM "ModActivity"; DELETE FROM "User"; DELETE FROM "Image";
     INSERT INTO "User" ("id","username") VALUES (${MOD},'mod-seven');`
  );
});

describe('getSourcesSettings', () => {
  it('reads an absent key as off and not stored', async () => {
    expect(await getSourcesSettings()).toEqual({
      stored: false,
      config: { enabled: false, sfwRate: 1, nsfwRate: 0.3 },
    });
  });

  it.each(['not json', '[]', '"on"'])('reads %j as off and not stored', async (raw) => {
    redisStore.set(KEY, raw);
    const settings = await getSourcesSettings();
    expect(settings.stored).toBe(false);
    expect(settings.config.enabled).toBe(false);
  });

  it('reads a stored value', async () => {
    redisStore.set(KEY, JSON.stringify({ enabled: true, sfwRate: 0.05, nsfwRate: 0.1 }));
    expect(await getSourcesSettings()).toEqual({
      stored: true,
      config: { enabled: true, sfwRate: 0.05, nsfwRate: 0.1 },
    });
  });
});

describe('saveSourcesConfig', () => {
  it.each([
    ['a string switch', { enabled: 'true', sfwRate: 0.1, nsfwRate: 0.1 }],
    ['a missing switch', { sfwRate: 0.1, nsfwRate: 0.1 }],
    ['a rate above 1', { enabled: true, sfwRate: 1.5, nsfwRate: 0.1 }],
    ['a negative rate', { enabled: true, sfwRate: 0.1, nsfwRate: -0.01 }],
    ['a string rate', { enabled: true, sfwRate: '0.1', nsfwRate: 0.1 }],
    ['a NaN rate', { enabled: true, sfwRate: Number.NaN, nsfwRate: 0.1 }],
    ['a missing rate', { enabled: true, sfwRate: 0.1 }],
  ])('refuses %s and changes nothing', async (_label, input) => {
    expect(await saveSourcesConfig(input, MOD)).toMatchObject({ ok: false });
    expect(redisStore.has(KEY)).toBe(false);
    expect(await activity()).toEqual([]);
  });

  it('accepts the bounds 0 and 1', async () => {
    expect(await saveSourcesConfig({ enabled: false, sfwRate: 0, nsfwRate: 1 }, MOD)).toEqual({
      ok: true,
      changed: true,
    });
  });

  it('stores all three fields in the shape the main app reads', async () => {
    await saveSourcesConfig({ enabled: true, sfwRate: 0.05, nsfwRate: 0.25 }, MOD);

    expect(JSON.parse(redisStore.get(KEY)!)).toEqual({
      enabled: true,
      sfwRate: 0.05,
      nsfwRate: 0.25,
    });
    expect(parseKnightsSourcesConfig(redisStore.get(KEY)!)).toEqual({
      enabled: true,
      sfwRate: 0.05,
      nsfwRate: 0.25,
    });
  });

  it('keeps a stored maxOpen, which the page does not edit', async () => {
    redisStore.set(
      KEY,
      JSON.stringify({ enabled: true, sfwRate: 1, nsfwRate: 0.3, maxOpen: 1200 })
    );

    await saveSourcesConfig({ enabled: true, sfwRate: 0.5, nsfwRate: 0.2 }, MOD);

    expect(JSON.parse(redisStore.get(KEY)!)).toEqual({
      enabled: true,
      sfwRate: 0.5,
      nsfwRate: 0.2,
      maxOpen: 1200,
    });
  });

  it('records who changed it with the value before and after', async () => {
    await saveSourcesConfig({ enabled: true, sfwRate: 0.05, nsfwRate: 0.05 }, MOD);
    await saveSourcesConfig({ enabled: false, sfwRate: 0.05, nsfwRate: 0.1 }, 8);

    const rows = await activity();
    expect(rows.map((r) => r.userId)).toEqual([MOD, 8]);
    expect(rows.every((r) => r.activity.startsWith(`${SOURCES_AUDIT_ACTIVITY} `))).toBe(true);
    expect(JSON.parse(rows[0].activity.slice(SOURCES_AUDIT_ACTIVITY.length + 1))).toEqual({
      before: null,
      after: { enabled: true, sfwRate: 0.05, nsfwRate: 0.05 },
    });
    expect(JSON.parse(rows[1].activity.slice(SOURCES_AUDIT_ACTIVITY.length + 1))).toEqual({
      before: { enabled: true, sfwRate: 0.05, nsfwRate: 0.05 },
      after: { enabled: false, sfwRate: 0.05, nsfwRate: 0.1 },
    });
  });

  it('writes and records nothing when the saved value is already what was asked for', async () => {
    const input = { enabled: true, sfwRate: 0.05, nsfwRate: 0.05 };
    await saveSourcesConfig(input, MOD);
    expect(await saveSourcesConfig(input, MOD)).toEqual({ ok: true, changed: false });
    expect(await activity()).toHaveLength(1);
  });
});

describe('getLastSourcesChange', () => {
  it('is null before anything was saved, and ignores other audit rows', async () => {
    await db.query(
      `INSERT INTO "ModActivity" ("userId","activity","entityType","entityId") VALUES (7,'other','KnightsSources',2)`
    );
    expect(await getLastSourcesChange()).toBeNull();
  });

  it('returns the newest change with the moderator name', async () => {
    await saveSourcesConfig({ enabled: true, sfwRate: 0.05, nsfwRate: 0.05 }, MOD);
    await db.query(`UPDATE "ModActivity" SET "createdAt" = now() - interval '1 hour'`);
    await saveSourcesConfig({ enabled: true, sfwRate: 0.1, nsfwRate: 0.05 }, MOD);

    expect(await getLastSourcesChange()).toMatchObject({
      moderatorId: MOD,
      moderatorUsername: 'mod-seven',
      before: { enabled: true, sfwRate: 0.05, nsfwRate: 0.05 },
      after: { enabled: true, sfwRate: 0.1, nsfwRate: 0.05 },
    });
  });
});

describe('getSourcesContext', () => {
  const NOW = new Date('2026-12-28T12:00:00Z');

  it('counts open Knight-stage items, the Inquisitor queue, and the last 24 h by source', async () => {
    await db.exec(`INSERT INTO "Image" ("id") VALUES (1),(2),(3),(4),(5),(6),(7),(8)`);
    await db.query(
      `INSERT INTO "KnightsQuestion" ("key","kind","prompt","options") VALUES ('yes.no','bool','Is it?','[]'::jsonb)
       ON CONFLICT DO NOTHING`
    );
    await insertItem(1, 'scan-sample', 'Open', 'Knight', '2026-12-20 00:00:00');
    await insertItem(2, 'scan-sample', 'Open', 'Templar', '2026-12-27 11:00:00');
    await insertItem(3, 'scan-sample', 'Resolved', 'Knight', '2026-12-27 13:00:00');
    await insertItem(4, 'owner-rating', 'Inquisitor', 'Inquisitor', '2026-12-28 09:00:00');
    await insertItem(5, 'scan-sample', 'Open', 'Knight', '2026-12-28 10:00:00');
    await insertItem(6, 'scan-sample', 'Open', 'Knight', '2026-12-28 11:00:00');
    await insertItem(7, 'other', 'Open', 'Knight', '2026-12-28 11:30:00', 'yes.no');

    const context = await getSourcesContext(NOW);

    expect(context.openKnightItems).toBe(4);
    expect(context.inquisitorQueue).toBe(1);
    expect(context.last24h).toEqual([
      { source: 'owner-rating', count: 1 },
      { source: 'scan-sample', count: 3 },
    ]);
  });

  it('is empty on an empty table', async () => {
    expect(await getSourcesContext(NOW)).toEqual({
      openKnightItems: 0,
      inquisitorQueue: 0,
      last24h: [],
    });
  });
});
