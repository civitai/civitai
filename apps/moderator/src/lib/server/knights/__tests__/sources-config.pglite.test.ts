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

const { dbHandle, redisStore, beforeSwap } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  redisStore: new Map<string, string>(),
  // Runs inside the compare-and-set, before the compare: a write landing between the read and the write.
  beforeSwap: { current: null as null | (() => void) },
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
    // The compare-and-set script: ARGV = [present ? '1' : '0', expected raw, new raw].
    eval: async (
      _script: string,
      { keys, arguments: args }: { keys: string[]; arguments: string[] }
    ) => {
      beforeSwap.current?.();
      const current = redisStore.get(keys[0]);
      const matches = args[0] === '0' ? current === undefined : current === args[1];
      if (!matches) return 0;
      redisStore.set(keys[0], args[2]);
      return 1;
    },
  }),
}));

const {
  getLastSourcesChange,
  getSourcesContext,
  getSourcesSettings,
  saveGameSettings,
  saveModTagReview,
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
  beforeSwap.current = null;
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

  it('keeps a stored maxOpen when the form leaves it out', async () => {
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

  it('stores the open-item cap the form sends, and keeps the stored one when it sends none', async () => {
    redisStore.set(
      KEY,
      JSON.stringify({ enabled: true, sfwRate: 0.5, nsfwRate: 0.25, maxOpen: 18300 })
    );

    await saveSourcesConfig({ enabled: true, sfwRate: 1, nsfwRate: 0.3, maxOpen: 60000 }, MOD);
    expect(JSON.parse(redisStore.get(KEY)!)).toMatchObject({ maxOpen: 60000 });

    await saveSourcesConfig({ enabled: true, sfwRate: 1, nsfwRate: 0.5 }, MOD);
    expect(JSON.parse(redisStore.get(KEY)!)).toMatchObject({ nsfwRate: 0.5, maxOpen: 60000 });
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['over the limit', 1_000_001],
    ['text', '60000'],
  ])('refuses an open-item cap that is %s and changes nothing', async (_label, maxOpen) => {
    expect(
      await saveSourcesConfig({ enabled: true, sfwRate: 1, nsfwRate: 0.3, maxOpen }, MOD)
    ).toEqual({ ok: false, error: expect.stringContaining('open-item cap') });
    expect(redisStore.has(KEY)).toBe(false);
  });

  it('stores a yes/no share, 0 included, in the shape Knights reads', async () => {
    await saveSourcesConfig({ enabled: true, sfwRate: 1, nsfwRate: 0.3, yesNoShare: 0 }, MOD);

    expect(JSON.parse(redisStore.get(KEY)!)).toEqual({
      enabled: true,
      sfwRate: 1,
      nsfwRate: 0.3,
      yesNoShare: 0,
    });
    expect(parseKnightsSourcesConfig(redisStore.get(KEY)!).yesNoShare).toBe(0);
  });

  it.each([
    ['above 1', 1.2],
    ['negative', -0.1],
    ['a string', '0.5'],
  ])('refuses a yes/no share that is %s and changes nothing', async (_label, yesNoShare) => {
    expect(
      await saveSourcesConfig({ enabled: true, sfwRate: 1, nsfwRate: 0.3, yesNoShare }, MOD)
    ).toMatchObject({ ok: false });
    expect(redisStore.has(KEY)).toBe(false);
  });

  it('keeps a stored yes/no share when a save leaves it out, so saving the rates never turns yes/no back on', async () => {
    redisStore.set(
      KEY,
      JSON.stringify({ enabled: true, sfwRate: 1, nsfwRate: 0.3, yesNoShare: 0 })
    );

    expect(await saveSourcesConfig({ enabled: true, sfwRate: 0.5, nsfwRate: 0.3 }, MOD)).toEqual({
      ok: true,
      changed: true,
    });
    expect(JSON.parse(redisStore.get(KEY)!).yesNoShare).toBe(0);
  });

  it('clears a stored yes/no share on request, so Knights falls back to its default, and audits it', async () => {
    redisStore.set(
      KEY,
      JSON.stringify({ enabled: true, sfwRate: 1, nsfwRate: 0.3, yesNoShare: 0 })
    );

    expect(
      await saveSourcesConfig({ enabled: true, sfwRate: 1, nsfwRate: 0.3, yesNoShare: null }, MOD)
    ).toEqual({ ok: true, changed: true });
    expect(JSON.parse(redisStore.get(KEY)!)).toEqual({ enabled: true, sfwRate: 1, nsfwRate: 0.3 });
    const [row] = await activity();
    expect(JSON.parse(row.activity.slice(SOURCES_AUDIT_ACTIVITY.length + 1))).toEqual({
      before: { enabled: true, sfwRate: 1, nsfwRate: 0.3, yesNoShare: 0 },
      after: { enabled: true, sfwRate: 1, nsfwRate: 0.3 },
    });
  });

  it('records nothing when clearing a share that is not stored', async () => {
    redisStore.set(KEY, JSON.stringify({ enabled: true, sfwRate: 1, nsfwRate: 0.3 }));
    expect(
      await saveSourcesConfig({ enabled: true, sfwRate: 1, nsfwRate: 0.3, yesNoShare: null }, MOD)
    ).toEqual({ ok: true, changed: false });
  });

  it('records a change of the yes/no share alone', async () => {
    await saveSourcesConfig({ enabled: true, sfwRate: 1, nsfwRate: 0.3, yesNoShare: 0.7 }, MOD);
    expect(
      await saveSourcesConfig({ enabled: true, sfwRate: 1, nsfwRate: 0.3, yesNoShare: 0 }, MOD)
    ).toEqual({ ok: true, changed: true });
    expect(await activity()).toHaveLength(2);
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

describe('saveSourcesConfig and game settings', () => {
  it('keeps every stored game setting when the sources are saved', async () => {
    const game = { hiddenCheckRate: 0, shopDisabled: true };
    redisStore.set(KEY, JSON.stringify({ enabled: true, sfwRate: 1, nsfwRate: 0.3, game }));
    await saveSourcesConfig({ enabled: false, sfwRate: 0.5, nsfwRate: 0.3 }, MOD);
    expect(JSON.parse(redisStore.get(KEY)!)).toEqual({
      enabled: false,
      sfwRate: 0.5,
      nsfwRate: 0.3,
      game,
    });
  });
});

describe('saveGameSettings', () => {
  const stored = {
    enabled: true,
    sfwRate: 0.4,
    nsfwRate: 0.2,
    maxOpen: 1200,
    yesNoShare: 0.5,
    game: { hiddenCheckRate: 0.1, yesNoStretch: 4 },
  };
  const audit = async () =>
    (await activity()).map((r) => JSON.parse(r.activity.slice(SOURCES_AUDIT_ACTIVITY.length + 1)));

  it('writes only the fields it changes and carries every other stored field over', async () => {
    redisStore.set(KEY, JSON.stringify(stored));
    expect(await saveGameSettings({ yesNoMaxAgeDays: 21, apprenticeSmites: false }, MOD)).toEqual({
      ok: true,
      changed: true,
    });
    expect(JSON.parse(redisStore.get(KEY)!)).toEqual({
      ...stored,
      game: { hiddenCheckRate: 0.1, yesNoStretch: 4, yesNoMaxAgeDays: 21, apprenticeSmites: false },
    });
    expect(parseKnightsSourcesConfig(redisStore.get(KEY)!).game?.yesNoMaxAgeDays).toBe(21);
  });

  it('clears one stored field on request, so Knights uses its default for it, and audits it', async () => {
    redisStore.set(KEY, JSON.stringify(stored));
    await saveGameSettings({ hiddenCheckRate: null }, MOD);
    expect(JSON.parse(redisStore.get(KEY)!).game).toEqual({ yesNoStretch: 4 });
    const [row] = await audit();
    expect(row.before.game).toEqual(stored.game);
    expect(row.after.game).toEqual({ yesNoStretch: 4 });
  });

  it('leaves game out once its last field is cleared', async () => {
    redisStore.set(KEY, JSON.stringify({ ...stored, game: { yesNoStretch: 4 } }));
    await saveGameSettings({ yesNoStretch: null }, MOD);
    expect(JSON.parse(redisStore.get(KEY)!)).not.toHaveProperty('game');
  });

  it.each([
    ['a rate above 1', { hiddenCheckRate: 1.5 }],
    ['a fractional distance', { hiddenCheckSevereDistance: 1.5 }],
    ['a zero window', { hiddenCheckFailureWindowHours: 0 }],
    ['a string number', { yesNoStretch: '4' }],
    ['a string toggle', { apprenticeSmites: 'off' }],
    ['an unknown setting', { yesNoShare: 0.2 }],
    ['no object', 'x'],
  ])('refuses %s and changes nothing', async (_label, input) => {
    redisStore.set(KEY, JSON.stringify(stored));
    expect(await saveGameSettings(input, MOD)).toMatchObject({ ok: false });
    expect(JSON.parse(redisStore.get(KEY)!)).toEqual(stored);
    expect(await activity()).toEqual([]);
  });

  it('refuses a kill switch change that was not confirmed, and saves it once confirmed', async () => {
    redisStore.set(KEY, JSON.stringify(stored));
    expect(await saveGameSettings({ shopDisabled: true, yesNoStretch: 2 }, MOD)).toMatchObject({
      ok: false,
    });
    expect(JSON.parse(redisStore.get(KEY)!)).toEqual(stored);
    expect(
      await saveGameSettings({ conversionDisabled: true }, MOD, { killSwitchesConfirmed: true })
    ).toEqual({ ok: true, changed: true });
    expect(JSON.parse(redisStore.get(KEY)!).game.conversionDisabled).toBe(true);
  });

  it('needs no confirmation when a kill switch is posted at the value it already has', async () => {
    redisStore.set(KEY, JSON.stringify({ ...stored, game: { shopDisabled: true } }));
    expect(await saveGameSettings({ shopDisabled: true, yesNoStretch: 2 }, MOD)).toEqual({
      ok: true,
      changed: true,
    });
  });

  it('records nothing when nothing changes', async () => {
    redisStore.set(KEY, JSON.stringify(stored));
    expect(await saveGameSettings({ yesNoStretch: 4, yesNoMaxAgeDays: null }, MOD)).toEqual({
      ok: true,
      changed: false,
    });
    expect(await activity()).toEqual([]);
  });

  it('keeps the sources off when nothing was stored before', async () => {
    await saveGameSettings({ yesNoStretch: 2 }, MOD);
    expect(parseKnightsSourcesConfig(redisStore.get(KEY)!)).toEqual({
      enabled: false,
      sfwRate: 1,
      nsfwRate: 0.3,
      game: { yesNoStretch: 2 },
    });
    expect((await audit())[0].before).toBeNull();
  });
});

describe('saveGameSettings harvest fields', () => {
  const stored = {
    enabled: true,
    sfwRate: 0.4,
    nsfwRate: 0.2,
    maxOpen: 1200,
    yesNoShare: 0.5,
    game: { shopDisabled: true },
  };

  it('stores an explicit harvest off and a share, carrying every other field over, with no kill switch confirmation', async () => {
    redisStore.set(KEY, JSON.stringify(stored));
    expect(await saveGameSettings({ harvest: false, harvestHiddenCheckShare: 0 }, MOD)).toEqual({
      ok: true,
      changed: true,
    });
    expect(JSON.parse(redisStore.get(KEY)!)).toEqual({
      ...stored,
      game: { shopDisabled: true, harvest: false, harvestHiddenCheckShare: 0 },
    });
  });

  it('clears each harvest field on request', async () => {
    redisStore.set(
      KEY,
      JSON.stringify({ ...stored, game: { harvest: true, harvestHiddenCheckShare: 0.3 } })
    );
    await saveGameSettings({ harvest: null }, MOD);
    expect(JSON.parse(redisStore.get(KEY)!).game).toEqual({ harvestHiddenCheckShare: 0.3 });
    await saveGameSettings({ harvestHiddenCheckShare: null }, MOD);
    expect(JSON.parse(redisStore.get(KEY)!)).not.toHaveProperty('game');
  });

  it.each([
    ['a share above 1', { harvestHiddenCheckShare: 1.5 }],
    ['a negative share', { harvestHiddenCheckShare: -0.1 }],
    ['a string share', { harvestHiddenCheckShare: '0.3' }],
    ['a string switch', { harvest: 'on' }],
  ])('refuses %s and changes nothing', async (_label, input) => {
    redisStore.set(KEY, JSON.stringify(stored));
    expect(await saveGameSettings(input, MOD)).toMatchObject({ ok: false });
    expect(JSON.parse(redisStore.get(KEY)!)).toEqual(stored);
  });

  it('keeps stored harvest fields when the sources are saved', async () => {
    const game = { harvest: false, harvestHiddenCheckShare: 0.2 };
    redisStore.set(KEY, JSON.stringify({ ...stored, game }));
    await saveSourcesConfig({ enabled: false, sfwRate: 0.4, nsfwRate: 0.2 }, MOD);
    expect(JSON.parse(redisStore.get(KEY)!).game).toEqual(game);
  });
});

describe('saveModTagReview', () => {
  it('turns the tag review source on and off, carrying every other field over, and audits each change', async () => {
    redisStore.set(
      KEY,
      JSON.stringify({ enabled: true, sfwRate: 0.5, nsfwRate: 0.2, game: { shopDisabled: true } })
    );
    expect(await saveModTagReview(true, MOD)).toEqual({ ok: true, changed: true });
    expect(parseKnightsSourcesConfig(redisStore.get(KEY) ?? null)).toEqual({
      enabled: true,
      sfwRate: 0.5,
      nsfwRate: 0.2,
      game: { shopDisabled: true },
      modTagReview: true,
    });
    expect(await saveModTagReview(true, MOD)).toEqual({ ok: true, changed: false });
    expect(await saveModTagReview(false, MOD)).toEqual({ ok: true, changed: true });
    expect(parseKnightsSourcesConfig(redisStore.get(KEY) ?? null).modTagReview).toBe(false);
    expect(
      (await activity()).filter((a) => a.activity.startsWith(SOURCES_AUDIT_ACTIVITY))
    ).toHaveLength(2);
  });

  it('keeps the switch when the sources or the game settings are saved', async () => {
    await saveModTagReview(true, MOD);
    await saveSourcesConfig({ enabled: true, sfwRate: 1, nsfwRate: 0.3 }, MOD);
    await saveGameSettings({ yesNoStretch: 4 }, MOD);
    expect(parseKnightsSourcesConfig(redisStore.get(KEY) ?? null).modTagReview).toBe(true);
  });
});

describe('concurrent saves', () => {
  it('does not overwrite a write that lands between the read and the write, and applies on top of it', async () => {
    redisStore.set(KEY, JSON.stringify({ enabled: true, sfwRate: 1, nsfwRate: 0.3 }));
    let raced = false;
    beforeSwap.current = () => {
      if (raced) return;
      raced = true;
      redisStore.set(
        KEY,
        JSON.stringify({ enabled: true, sfwRate: 1, nsfwRate: 0.3, game: { shopDisabled: true } })
      );
    };
    expect(await saveGameSettings({ yesNoStretch: 2 }, MOD)).toEqual({ ok: true, changed: true });
    expect(JSON.parse(redisStore.get(KEY)!).game).toEqual({ shopDisabled: true, yesNoStretch: 2 });
    const rows = await activity();
    expect(rows).toHaveLength(1);
    expect(
      JSON.parse(rows[0].activity.slice(SOURCES_AUDIT_ACTIVITY.length + 1)).before.game
    ).toEqual({
      shopDisabled: true,
    });
  });

  it('treats a key created between the read and the write as a conflict', async () => {
    let raced = false;
    beforeSwap.current = () => {
      if (raced) return;
      raced = true;
      redisStore.set(KEY, JSON.stringify({ enabled: true, sfwRate: 0.2, nsfwRate: 0.1 }));
    };
    await saveGameSettings({ yesNoStretch: 2 }, MOD);
    expect(JSON.parse(redisStore.get(KEY)!)).toEqual({
      enabled: true,
      sfwRate: 0.2,
      nsfwRate: 0.1,
      game: { yesNoStretch: 2 },
    });
  });

  it('gives up with a clear error when every attempt conflicts, leaving the other write in place', async () => {
    let n = 0;
    beforeSwap.current = () => {
      n++;
      redisStore.set(KEY, JSON.stringify({ enabled: true, sfwRate: 1, nsfwRate: n / 100 }));
    };
    const result = await saveSourcesConfig({ enabled: false, sfwRate: 0.5, nsfwRate: 0.5 }, MOD);
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/at the same time/) });
    expect(JSON.parse(redisStore.get(KEY)!).enabled).toBe(true);
    expect(await activity()).toEqual([]);
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
