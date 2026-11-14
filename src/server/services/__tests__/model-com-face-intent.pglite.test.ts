import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as DbLag from '~/server/db/db-lag-helpers';
import type * as TextScanPreview from '~/server/services/text-scan/preview';
import type { ModelMeta } from '~/server/schema/model.schema';

/** The listing intent lock's own SQL against PGlite: which rows it may lock. Ids are invented. */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { mockPreviewComFaceIntent } = vi.hoisted(() => ({ mockPreviewComFaceIntent: vi.fn() }));

vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLag>()),
  preventReplicationLag: vi.fn(async () => undefined),
}));
// The package's ESM build can't be loaded by `importOriginal` here; every suite fakes it whole.
vi.mock('@civitai/orchestration-client', () => ({
  createCivitaiClient: vi.fn(() => ({})),
  submitWorkflow: vi.fn(),
}));
vi.mock('~/server/services/text-scan/preview', async (importOriginal) => ({
  ...(await importOriginal<typeof TextScanPreview>()),
  previewComFaceIntent: mockPreviewComFaceIntent,
}));

const {
  comFaceIntentMetaAfterModeratorUnlock,
  comFaceIntentTextHash,
  lockForComFaceIntent,
  overturnComFaceIntentSql,
  recordComFaceIntent,
} = await import('~/server/services/model-com-face-intent.service');
const { assertComFaceAllowed } = await import('~/server/services/model-sfw-face.service');

const MODEL = 5;
let db: PGlite;
const activities: unknown[] = [];

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Model" (
      id int PRIMARY KEY,
      "lockedProperties" text[],
      nsfw boolean NOT NULL DEFAULT true,
      poi boolean NOT NULL DEFAULT false,
      minor boolean NOT NULL DEFAULT false,
      "sfwOnly" boolean NOT NULL DEFAULT false,
      meta jsonb,
      "userId" int NOT NULL DEFAULT 1,
      name text NOT NULL DEFAULT 'Model',
      description text
    );
  `);
  const raw = pgliteRaw(db);
  const tx = {
    $executeRaw: raw.executeRaw,
    modActivity: { create: async (args: unknown) => activities.push(args) },
  };
  dbMock.dbWrite.$transaction.mockImplementation(((fn: (t: typeof tx) => unknown) =>
    fn(tx)) as never);
  dbMock.dbWrite.$executeRaw.mockImplementation(raw.executeRaw as never);
  // The model the face check reads, from this table.
  dbMock.dbWrite.model.findUnique.mockImplementation(
    (async () =>
      (await db.query(`SELECT * FROM "Model" WHERE id = $1`, [MODEL])).rows[0] ?? null) as never
  );
});
afterAll(() => db.close());

beforeEach(async () => {
  activities.length = 0;
  await db.exec(`DELETE FROM "Model"`);
});

async function seed(fields: Record<string, unknown> = {}) {
  const row = { nsfw: true, poi: false, minor: false, sfwOnly: false, locked: null, ...fields };
  await db.query(
    `INSERT INTO "Model" (id, "lockedProperties", nsfw, poi, minor, "sfwOnly", meta) VALUES ($1, $2, $3, $4, $5, $6, '{}')`,
    [MODEL, row.locked, row.nsfw, row.poi, row.minor, row.sfwOnly]
  );
  await recordComFaceIntent(MODEL, { detected: true, textHash: 'h', reason: 'r' });
}

const row = async () =>
  (
    await db.query<{ lockedProperties: string[] | null; meta: Record<string, any> }>(
      `SELECT "lockedProperties", meta FROM "Model" WHERE id = $1`,
      [MODEL]
    )
  ).rows[0];

describe('lockForComFaceIntent', () => {
  it('locks a mature model on its stored detection, with the system marker and an activity', async () => {
    await seed();

    expect(await lockForComFaceIntent(MODEL, 'h')).toBe(true);

    const { lockedProperties, meta } = await row();
    expect(lockedProperties).toEqual(['nsfw']);
    expect(meta.systemNsfwLock.source).toBe('com-face-intent');
    expect(meta.comFaceIntent).toMatchObject({ detected: true, textHash: 'h', reason: 'r' });
    expect(activities).toHaveLength(1);
  });

  it("keeps the scan's rating marker it replaces on the verdict", async () => {
    await seed();
    const scan = { source: 'text-scan', at: '2026-01-01T00:00:00.000Z' };
    await db.query(
      `UPDATE "Model" SET meta = meta || jsonb_build_object('systemNsfwLock', $2::jsonb) WHERE id = $1`,
      [MODEL, JSON.stringify(scan)]
    );

    expect(await lockForComFaceIntent(MODEL, 'h')).toBe(true);

    const { meta } = await row();
    expect(meta.systemNsfwLock.source).toBe('com-face-intent');
    expect(meta.comFaceIntent.priorSystemNsfwLock).toEqual(scan);
  });

  it('keeps the replaced marker when a later verdict for other text is recorded', async () => {
    await seed();
    const scan = { source: 'text-scan', at: '2026-01-01T00:00:00.000Z' };
    await db.query(
      `UPDATE "Model" SET meta = meta || jsonb_build_object('systemNsfwLock', $2::jsonb) WHERE id = $1`,
      [MODEL, JSON.stringify(scan)]
    );
    await lockForComFaceIntent(MODEL, 'h');

    await recordComFaceIntent(MODEL, { detected: false, textHash: 'edited' });

    const { meta } = await row();
    expect(meta.comFaceIntent).toMatchObject({ detected: false, textHash: 'edited' });
    expect(meta.comFaceIntent.priorSystemNsfwLock).toEqual(scan);
  });

  it.each([
    ['not mature', { nsfw: false }],
    ['flagged a minor', { minor: true }],
    ['flagged a real person', { poi: true }],
    ['SFW-only', { sfwOnly: true }],
    ['already locked', { locked: ['nsfw'] }],
  ])('leaves a model that is %s alone', async (_, fields) => {
    await seed(fields);
    const before = await row();

    expect(await lockForComFaceIntent(MODEL, 'h')).toBe(false);

    expect((await row()).lockedProperties).toEqual(before.lockedProperties);
    expect(activities).toHaveLength(0);
  });

  it('does not lock for a verdict on other text, or one since overturned', async () => {
    await seed();
    expect(await lockForComFaceIntent(MODEL, 'other')).toBe(false);

    await db.query(
      `UPDATE "Model" SET meta = jsonb_set(meta, '{comFaceIntent,overturnedAt}', '"x"') WHERE id = $1`,
      [MODEL]
    );
    expect(await lockForComFaceIntent(MODEL, 'h')).toBe(false);
    expect((await row()).lockedProperties).toBeNull();
  });
});

describe('restoreReplacedRatingMarkerSql', () => {
  // The approving ruling logs its own unlock in the same transaction; that row must not read as a
  // moderator's ruling on the rating made after the marker (assertScanRatingKept).
  it('stamps the restored marker after the ruling, so its own logged unlock does not release it', async () => {
    const { restoreReplacedRatingMarkerSql } = await import(
      '~/server/services/model-com-face-intent.service'
    );
    const raw = pgliteRaw(db);
    await db.exec(`
      CREATE TABLE IF NOT EXISTS "ModActivity" (
        id serial PRIMARY KEY, activity text, "entityId" int,
        "createdAt" timestamp(3) NOT NULL DEFAULT now()
      );
      DELETE FROM "ModActivity";
    `);
    await db.query(`INSERT INTO "Model" (id, nsfw, meta) VALUES ($1, true, $2)`, [
      MODEL,
      {
        comFaceIntent: {
          priorSystemNsfwLock: { source: 'text-scan', at: '2026-01-01T00:00:00.000Z' },
        },
      },
    ]);

    await db.exec('BEGIN');
    await raw.executeRaw(restoreReplacedRatingMarkerSql(MODEL) as never);
    await db.query(
      `INSERT INTO "ModActivity" (activity, "entityId") VALUES ('unlockProperty:nsfw', $1)`,
      [MODEL]
    );
    await db.exec('COMMIT');

    const { meta } = await row();
    expect(meta.systemNsfwLock.source).toBe('text-scan');
    const since = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "ModActivity" WHERE "createdAt" > $1::timestamptz`,
      [meta.systemNsfwLock.at]
    );
    expect(since.rows[0].n).toBe(0);
  });
});

describe('the face check after a moderator lifted the intent lock', () => {
  const OWNER = 1;
  const stored = { name: 'Model', description: 'stored listing', triggerWords: [] };
  const storedHash = comFaceIntentTextHash(stored);
  const detects = (detected: boolean) => ({ status: 'ok', output: { detected, reason: 'r' } });
  const faceCheck = (listing: typeof stored) =>
    assertComFaceAllowed({ ...listing, modelId: MODEL, userId: OWNER });

  // The stored listing was detected and locked, then a moderator's approval lifted the lock and
  // overturned the detection, as `resolveLockReviewAppeal` does.
  async function lockedThenApproved() {
    await db.query(
      `INSERT INTO "Model" (id, "lockedProperties", nsfw, meta, description) VALUES ($1, NULL, true, '{}', $2)`,
      [MODEL, stored.description]
    );
    await recordComFaceIntent(MODEL, { detected: true, textHash: storedHash });
    expect(await lockForComFaceIntent(MODEL, storedHash)).toBe(true);
    await db.query(
      `UPDATE "Model" SET "lockedProperties" = '{}', meta = meta - 'systemNsfwLock' WHERE id = $1`,
      [MODEL]
    );
    await dbMock.dbWrite.$executeRaw(overturnComFaceIntentSql(MODEL, storedHash));
    activities.length = 0;
  }

  beforeEach(() => {
    mockPreviewComFaceIntent.mockReset();
    mockPreviewComFaceIntent.mockResolvedValue(detects(true));
  });

  it('does not re-lock the stored listing after a draft of other text was checked', async () => {
    await lockedThenApproved();

    // The draft is judged and refused, but its verdict is not stored over the ruled one.
    await expect(faceCheck({ ...stored, description: 'unsaved draft' })).rejects.toThrow();
    await faceCheck(stored);

    const after = await row();
    expect(after.lockedProperties).toEqual([]);
    expect(after.meta.comFaceIntent).toMatchObject({ textHash: storedHash });
    expect(after.meta.comFaceIntent.overturnedAt).toBeTruthy();
    expect(activities).toHaveLength(0);
  });

  it('locks again once the owner saves new text the check detects', async () => {
    await lockedThenApproved();
    const saved = { ...stored, description: 'new saved listing' };
    await db.query(`UPDATE "Model" SET description = $2 WHERE id = $1`, [MODEL, saved.description]);

    await expect(faceCheck(saved)).rejects.toThrow();

    const after = await row();
    expect(after.lockedProperties).toEqual(['nsfw']);
    expect(after.meta.comFaceIntent).toMatchObject({
      detected: true,
      textHash: comFaceIntentTextHash(saved),
    });
  });

  it('keeps an overturned verdict when a fresh one for the same text lands after the ruling', async () => {
    await lockedThenApproved();

    await recordComFaceIntent(MODEL, { detected: true, textHash: storedHash });

    expect((await row()).meta.comFaceIntent.overturnedAt).toBeTruthy();
    expect(await lockForComFaceIntent(MODEL, storedHash)).toBe(false);
  });
});

// What a moderator's unlock from the model form leaves, against the real lock SQL and face check.
describe('the face check after a moderator unlocked from the model form', () => {
  const OWNER = 1;
  const stored = { name: 'Model', description: 'stored listing', triggerWords: [] };
  const storedHash = comFaceIntentTextHash(stored);
  const detection = { detected: true, textHash: storedHash, at: '2026-01-01T00:00:00Z' };
  const faceCheck = (listing = stored) =>
    assertComFaceAllowed({ ...listing, modelId: MODEL, userId: OWNER });

  // The row as the save leaves it: lock gone, the system marker dropped, and the unlock's meta merged.
  async function unlockedByModerator(lockSource: string | null) {
    const before = {
      ...(lockSource && { systemNsfwLock: { source: lockSource, at: 'x' } }),
      comFaceIntent: detection,
    } as ModelMeta;
    const { systemNsfwLock: _marker, ...kept } = before;
    const meta = {
      ...kept,
      ...comFaceIntentMetaAfterModeratorUnlock(before, storedHash, new Date().toISOString()),
    };
    await db.query(
      `INSERT INTO "Model" (id, "lockedProperties", nsfw, meta, description) VALUES ($1, '{}', true, $2, $3)`,
      [MODEL, meta, stored.description]
    );
  }

  beforeEach(() => {
    mockPreviewComFaceIntent.mockReset();
    mockPreviewComFaceIntent.mockResolvedValue({
      status: 'ok',
      output: { detected: true, reason: 'r' },
    });
  });

  it.each([
    ['a text-scan lock', 'text-scan'],
    ['a lock with no system marker', null],
  ])('after lifting %s, still refuses the face and does not lock again', async (_, source) => {
    await unlockedByModerator(source);

    await expect(faceCheck()).rejects.toThrow();
    expect(await lockForComFaceIntent(MODEL, storedHash)).toBe(false);

    expect((await row()).lockedProperties).toEqual([]);
    expect(activities).toHaveLength(0);
  });

  it('locks again once the owner saves new text the check detects', async () => {
    await unlockedByModerator('text-scan');
    const saved = { ...stored, description: 'new saved listing' };
    await db.query(`UPDATE "Model" SET description = $2 WHERE id = $1`, [MODEL, saved.description]);

    await expect(faceCheck(saved)).rejects.toThrow();

    expect((await row()).lockedProperties).toEqual(['nsfw']);
  });

  it("clears the face and blocks a re-lock after lifting the intent check's own lock", async () => {
    await unlockedByModerator('com-face-intent');

    await faceCheck();
    await recordComFaceIntent(MODEL, { detected: true, textHash: storedHash });

    expect(await lockForComFaceIntent(MODEL, storedHash)).toBe(false);
    expect((await row()).meta.comFaceIntent.overturnedAt).toBeTruthy();
  });
});
