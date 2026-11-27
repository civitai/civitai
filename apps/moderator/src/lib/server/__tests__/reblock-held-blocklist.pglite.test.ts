import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import {
  DEFERRED_BLOCK_EFFECT_TABLE_SQL,
  SET_ASIDE_TABLE_SQL,
} from '../../../test/held-image-tables';
import type * as Effects from '../image-moderation-effects';
import type * as ThumbnailCache from '../thumbnail-cache';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * A re-block of an image already removed for CSAM is how a moderator retries a CSAM blocklist entry
 * that failed (CSAM_BLOCKLIST_RETRY). It writes that entry to both stores and nothing else.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 20_000 });

const spies = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  /** When set, the replica: `dbRead` answers from it while `dbWrite` stays on the row. */
  replica: { current: null as unknown },
  ch: { inserts: [] as { table: string; values: unknown[] }[], fail: false },
  logToAxiom: vi.fn(async (_data: Record<string, unknown>) => undefined),
  logAxiomError: vi.fn(async (_error: unknown, _extra?: Record<string, unknown>) => undefined),
  applyBlockSideEffects: vi.fn(async (..._args: unknown[]) => undefined),
  recordModActivity: vi.fn(async () => undefined),
  recordLikenessRequest: vi.fn(async () => true),
  insertModActivity: vi.fn(async () => 1),
  syncSearchIndex: vi.fn(),
  invalidateThumbnails: vi.fn(async () => undefined),
  bustProfilePictures: vi.fn(async () => undefined),
}));
const { ch, logToAxiom } = spies;

vi.mock('../db', () => ({
  get dbRead() {
    return spies.replica.current ?? spies.dbHandle.current;
  },
  get dbWrite() {
    return spies.dbHandle.current;
  },
}));
vi.mock('../clickhouse', () => ({
  getClickhouse: () => ({
    query: async () => ({ json: async () => [] }),
    insert: async ({ table, values }: { table: string; values: unknown[] }) => {
      if (ch.fail && table === 'blocked_images')
        // A driver message that quotes the row, as ClickHouse's parse errors do.
        throw new Error(`Cannot parse input: ${JSON.stringify(values)}`);
      ch.inserts.push({ table, values });
    },
  }),
}));
vi.mock('../axiom', () => ({ logToAxiom: spies.logToAxiom, logAxiomError: spies.logAxiomError }));
vi.mock('../notifications', () => ({ getNotifications: vi.fn() }));
vi.mock('../redis', () => ({
  getSysRedis: () => ({ packed: { set: vi.fn(async () => undefined) } }),
  getRedis: vi.fn(),
}));
vi.mock('../buzz', () => ({ getBuzz: vi.fn() }));
vi.mock('../cache', () => ({ bustCacheTag: vi.fn(), bustCachedObject: vi.fn() }));
vi.mock('../search-index', () => ({ syncSearchIndex: spies.syncSearchIndex }));
vi.mock('../removal-hold', () => ({
  holdRemovals: vi.fn(async (requests: { imageId: number }[]) => ({
    held: [],
    proceed: requests.map((r) => r.imageId),
  })),
}));
vi.mock('../tags-on-image.service', () => ({ upsertTagsOnImageNew: vi.fn() }));
vi.mock('../mod-activity', () => ({
  recordModActivity: spies.recordModActivity,
  recordLikenessRequest: spies.recordLikenessRequest,
  insertModActivity: spies.insertModActivity,
  insertModActivityBatch: vi.fn(),
}));
vi.mock('../profile-picture-cache', () => ({ bustProfilePictures: spies.bustProfilePictures }));
vi.mock('../thumbnail-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof ThumbnailCache>()),
  invalidateThumbnails: spies.invalidateThumbnails,
}));
// A first block's effects run for real, through a spy that counts them; their own dependencies
// (ClickHouse, notifications, Redis, Axiom) are the fakes above.
vi.mock('../image-moderation-effects', async (importOriginal) => {
  const actual = await importOriginal<typeof Effects>();
  spies.applyBlockSideEffects.mockImplementation(
    actual.applyBlockSideEffects as (...args: unknown[]) => Promise<undefined>
  );
  return { ...actual, applyBlockSideEffects: spies.applyBlockSideEffects };
});

const { CsamBlocklistWriteError } = await import('../image-moderation-effects');
const { blockImage } = await import('../image-moderation.service');

// Past 2^53, so a copy that went through a JS number would land a different value.
const HASH = '-4276845791567733103';
const FLAGGED = 1; // under the review flag, not yet removed: removed for CSAM by its first block
const REMOVED = 2; // removed for CSAM, the review flag kept
const REMOVED_TOS = 3; // removed by a moderator, the review flag kept
const DISMISSED = 4; // removed with the flag kept, then dismissed from its queue: not held

const SCHEMA = `
CREATE TABLE "Image" (
  "id" INTEGER PRIMARY KEY,
  "type" TEXT,
  "needsReview" TEXT,
  "blockedFor" TEXT,
  "ingestion" TEXT,
  "metadata" JSONB,
  "pHash" BIGINT,
  "postId" INTEGER,
  "userId" INTEGER,
  "updatedAt" TIMESTAMP(3),
  "nsfwLevel" INTEGER NOT NULL DEFAULT 0,
  "nsfwLevelLocked" BOOLEAN NOT NULL DEFAULT FALSE
);
${SET_ASIDE_TABLE_SQL}
${DEFERRED_BLOCK_EFFECT_TABLE_SQL}
CREATE TABLE "Appeal" ("id" SERIAL PRIMARY KEY, "entityType" TEXT, "entityId" INTEGER, "status" TEXT);
CREATE TYPE "BlockImageReason" AS ENUM ('Ownership', 'CSAM', 'TOS');
CREATE TABLE "BlockedImage" ("hash" BIGINT PRIMARY KEY, "reason" "BlockImageReason" NOT NULL DEFAULT 'Ownership');
-- The first fail_first inserts into "BlockedImage" fail, with the hash in the message. A sequence
-- counts them, since the failing statement rolls back any table write.
CREATE TABLE copy_failures (fail_first INTEGER NOT NULL);
INSERT INTO copy_failures VALUES (0);
CREATE SEQUENCE copy_attempts;
CREATE FUNCTION fail_copy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF nextval('copy_attempts') <= (SELECT fail_first FROM copy_failures) THEN
    RAISE EXCEPTION 'copy failed for %', NEW.hash;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fail_copy BEFORE INSERT ON "BlockedImage" FOR EACH ROW EXECUTE FUNCTION fail_copy();
`;

let pg: PGlite;
/** Copies into "BlockedImage" never answer, as over a dead connection. PGlite runs a statement on
 *  this thread, so a pg_sleep would block the copy's timer rather than model a hang. */
let hangCopies = false;

/** `db`, with its executor's copy statements hanging while `hangCopies` is set. */
const withHangingCopies = (db: Kysely<unknown>) =>
  new Proxy(db, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (key !== 'getExecutor') return typeof value === 'function' ? value.bind(target) : value;
      return () => {
        const executor = target.getExecutor();
        return new Proxy(executor, {
          get(ex, k) {
            const v = Reflect.get(ex, k);
            if (k === 'executeQuery')
              return (query: { sql: string }, ...rest: unknown[]) =>
                hangCopies && query.sql.includes('"BlockedImage"')
                  ? new Promise(() => undefined)
                  : v.call(ex, query, ...rest);
            return typeof v === 'function' ? v.bind(ex) : v;
          },
        });
      };
    },
  });

beforeAll(async () => {
  pg = await freshPglite();
  await pg.exec(SCHEMA);
  spies.dbHandle.current = withHangingCopies(new Kysely({ dialect: pgliteDialect(pg) }));
});

afterAll(async () => {
  spies.dbHandle.current = null;
  await pg.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  ch.inserts = [];
  ch.fail = false;
  hangCopies = false;
  await pg.exec(`
    TRUNCATE "Image", "CsamQueueSetAside", "ImageDeferredBlockEffect", "BlockedImage";
    UPDATE copy_failures SET fail_first = 0;
  `);
  await pg.query(
    `INSERT INTO "Image" ("id", "userId", "needsReview", "blockedFor", "ingestion", "nsfwLevel", "pHash") VALUES
      ($1, 7, 'csam', 'CSAM', 'Scanned', 4, $5),
      ($2, 7, 'csam', 'CSAM', 'Blocked', 32, $5),
      ($3, 7, 'csam', 'moderated', 'Blocked', 32, $5),
      ($4, 7, 'csam', 'moderated', 'Blocked', 32, $5)`,
    [FLAGGED, REMOVED, REMOVED_TOS, DISMISSED, HASH]
  );
  await pg.query(
    `INSERT INTO "CsamQueueSetAside" ("imageId", "userId", outcome, "moderatorId") VALUES ($1, 7, 'Dismissed', 2)`,
    [DISMISSED]
  );
});

const failCopies = (n: number) =>
  pg.exec(`UPDATE copy_failures SET fail_first = ${n}; ALTER SEQUENCE copy_attempts RESTART;`);
const blocklistEntries = () =>
  ch.inserts.filter((i) => i.table === 'blocked_images').map((i) => i.values);
const pgRows = async () =>
  (await pg.query('SELECT hash::text AS hash, reason::text AS reason FROM "BlockedImage"')).rows;
const reblock = (imageId: number) => blockImage({ imageId, userId: 2 });
const failure = (imageId: number) =>
  reblock(imageId).then(
    () => expect.unreachable('the re-block reported success'),
    (e: unknown) => e as InstanceType<typeof CsamBlocklistWriteError>
  );

describe('a re-block of a removed, held image', () => {
  it('writes a CSAM entry that its first block failed to write, to both stores', async () => {
    ch.fail = true;
    expect(await failure(FLAGGED)).toBeInstanceOf(CsamBlocklistWriteError);
    expect(blocklistEntries()).toEqual([]);

    ch.fail = false;
    expect(await reblock(FLAGGED)).toEqual({ skipped: true });

    expect(blocklistEntries()).toEqual([[{ hash: HASH, reason: 'CSAM' }]]);
    expect(await pgRows()).toEqual([{ hash: HASH, reason: 'CSAM' }]);
  });

  it('writes the CSAM entry from the row when the replica read has no hash yet', async () => {
    const lagging = await freshPglite();
    await lagging.exec(SCHEMA);
    await lagging.query(
      `INSERT INTO "Image" ("id", "userId", "needsReview", "blockedFor", "ingestion", "nsfwLevel", "pHash")
        VALUES ($1, 7, 'csam', 'CSAM', 'Blocked', 32, NULL)`,
      [REMOVED]
    );
    spies.replica.current = new Kysely({ dialect: pgliteDialect(lagging) });
    try {
      await reblock(REMOVED);
    } finally {
      spies.replica.current = null;
      await lagging.close();
    }

    expect(blocklistEntries()).toEqual([[{ hash: HASH, reason: 'CSAM' }]]);
  });

  it('a first block passes on the hash read under the block when the replica has none yet', async () => {
    const lagging = await freshPglite();
    await lagging.exec(SCHEMA);
    await lagging.query(
      `INSERT INTO "Image" ("id", "userId", "needsReview", "blockedFor", "ingestion", "nsfwLevel", "pHash")
        VALUES ($1, 7, 'csam', 'CSAM', 'Scanned', 4, NULL)`,
      [FLAGGED]
    );
    spies.replica.current = new Kysely({ dialect: pgliteDialect(lagging) });
    try {
      await blockImage({ imageId: FLAGGED, userId: 2, skipAppealCheck: true });
    } finally {
      spies.replica.current = null;
      await lagging.close();
    }

    expect(spies.applyBlockSideEffects).toHaveBeenCalledWith(
      expect.objectContaining({ pHash: HASH }),
      expect.anything()
    );
  });

  it('a re-block with no hash on the row still succeeds, writes no entry, and logs only its id and step', async () => {
    await pg.query('UPDATE "Image" SET "pHash" = NULL WHERE id = $1', [REMOVED]);

    expect(await reblock(REMOVED)).toEqual({ skipped: true });

    expect(blocklistEntries()).toEqual([]);
    expect(
      logToAxiom.mock.calls
        .map(([e]) => e as { name?: string; payload?: unknown })
        .filter((e) => e.name === 'csam-blocklist-no-hash')
        .map((e) => e.payload)
    ).toEqual([{ imageId: REMOVED, step: 'block' }]);
  });

  it('adds no Postgres row when retried again, and appends the same ClickHouse entry', async () => {
    await reblock(REMOVED);
    await reblock(REMOVED);

    expect(await pgRows()).toEqual([{ hash: HASH, reason: 'CSAM' }]);
    expect(blocklistEntries()).toEqual([
      [{ hash: HASH, reason: 'CSAM' }],
      [{ hash: HASH, reason: 'CSAM' }],
    ]);
  });

  it('reports a blocklist write that fails again as a failure, never as a skip', async () => {
    ch.fail = true;
    const first = await failure(REMOVED);
    const second = await failure(REMOVED);

    for (const e of [first, second]) {
      expect(e).toBeInstanceOf(CsamBlocklistWriteError);
      expect(e).toMatchObject({ failedStore: 'blocklist', skipped: true, imageId: REMOVED });
    }
  });

  it('names the held-media copy when only the copy fails', async () => {
    await failCopies(10);

    expect(await failure(REMOVED)).toMatchObject({ failedStore: 'held-media-copy' });
    expect(blocklistEntries()).toEqual([[{ hash: HASH, reason: 'CSAM' }]]);
    expect(await pgRows()).toEqual([]);
  });

  it('gives up on a copy that hangs within its budget, naming the copy', async () => {
    hangCopies = true;
    // Past the 1.5 s budget, so only a copy that gives up on its own answers in time.
    const outcome = await Promise.race([
      failure(REMOVED),
      new Promise((resolve) => setTimeout(() => resolve('still waiting after 3 s'), 3_000)),
    ]);

    expect(outcome).toMatchObject({ failedStore: 'held-media-copy' });
  });

  it('retries a copy that fails once, and succeeds', async () => {
    await failCopies(1);

    expect(await reblock(REMOVED)).toEqual({ skipped: true });
    expect(await pgRows()).toEqual([{ hash: HASH, reason: 'CSAM' }]);
  });

  it('logs no hash when either store fails', async () => {
    ch.fail = true;
    await failure(REMOVED);
    ch.fail = false;
    await failCopies(10);
    await failure(REMOVED);

    const logged = JSON.stringify(logToAxiom.mock.calls);
    expect(logged).toContain('held-media-copy-failed');
    expect(logged).toContain('"failedStore":"blocklist"');
    expect(logged).toContain('"failedStore":"held-media-copy"');
    expect(logged).not.toContain(HASH.slice(1));
  });

  // A TOS entry is best-effort, with no retry message to honour; its write and logs stay with the
  // first block.
  it('writes nothing for one removed by a moderator under the flag', async () => {
    expect(await reblock(REMOVED_TOS)).toEqual({ skipped: true });

    expect(blocklistEntries()).toEqual([]);
    expect(await pgRows()).toEqual([]);
  });

  it('writes nothing for one dismissed from its queue, which is not held (control)', async () => {
    expect(await reblock(DISMISSED)).toEqual({});

    expect(blocklistEntries()).toEqual([]);
    expect(await pgRows()).toEqual([]);
  });

  it('runs nothing else: no notice, report action, activity, index, thumbnail or avatar work', async () => {
    await reblock(REMOVED);
    await reblock(REMOVED_TOS);

    expect(spies.applyBlockSideEffects).not.toHaveBeenCalled();
    expect(spies.insertModActivity).not.toHaveBeenCalled();
    expect(spies.syncSearchIndex).not.toHaveBeenCalled();
    expect(spies.invalidateThumbnails).not.toHaveBeenCalled();
    expect(spies.bustProfilePictures).not.toHaveBeenCalled();
    const deferred = await pg.query('SELECT "notifyOwner" FROM "ImageDeferredBlockEffect"');
    expect(deferred.rows).toEqual([{ notifyOwner: false }]);
  });

  it('a first block runs them (control: the spies see the calls)', async () => {
    await reblock(FLAGGED);

    expect(spies.applyBlockSideEffects).toHaveBeenCalledTimes(1);
    expect(spies.insertModActivity).toHaveBeenCalledTimes(1);
    expect(spies.syncSearchIndex).toHaveBeenCalledTimes(1);
    expect(spies.invalidateThumbnails).toHaveBeenCalledTimes(1);
    expect(spies.bustProfilePictures).toHaveBeenCalledTimes(1);
  });
});

// The main app's appeal-decision-records sweep deletes an image's appeal training copies by this mark.
describe('blockImage for a likeness request', () => {
  const FRESH = 5;

  it('marks an image already removed, whose re-block updates nothing', async () => {
    await blockImage({
      imageId: REMOVED_TOS,
      userId: 2,
      skipAppealCheck: true,
      violationType: 'likenessRequest',
    });

    expect(spies.applyBlockSideEffects).not.toHaveBeenCalled();
    expect(spies.recordLikenessRequest.mock.calls).toEqual([[2, REMOVED_TOS]]);
  });

  it('marks an already-removed image actioned from the reports queue', async () => {
    const REMOVED_PLAIN = 6;
    // The reports-queue read checks the owner's ban and rule blocks.
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS "User" ("id" INTEGER PRIMARY KEY, "bannedAt" TIMESTAMP(3));
      CREATE TABLE IF NOT EXISTS "ModerationRule" ("id" INTEGER PRIMARY KEY, "action" TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS "ModerationRuleVersion" ("ruleId" INTEGER NOT NULL, "action" TEXT NOT NULL);
    `);
    await pg.query(
      `INSERT INTO "Image" ("id", "userId", "blockedFor", "ingestion", "nsfwLevel") VALUES ($1, 7, 'moderated', 'Blocked', 4)`,
      [REMOVED_PLAIN]
    );

    const result = await blockImage({
      imageId: REMOVED_PLAIN,
      userId: 2,
      skipAppealCheck: true,
      skipModeratorRemoved: true,
      violationType: 'likenessRequest',
    });

    expect(result).toMatchObject({ alreadyRemoved: true });
    expect(spies.applyBlockSideEffects).not.toHaveBeenCalled();
    expect(spies.recordLikenessRequest.mock.calls).toEqual([[2, REMOVED_PLAIN]]);
  });

  it('marks a fresh block exactly once (control)', async () => {
    await pg.query(
      `INSERT INTO "Image" ("id", "userId", "ingestion", "nsfwLevel") VALUES ($1, 7, 'Scanned', 4)`,
      [FRESH]
    );

    await blockImage({
      imageId: FRESH,
      userId: 2,
      skipAppealCheck: true,
      violationType: 'likenessRequest',
    });

    expect(spies.applyBlockSideEffects).toHaveBeenCalledTimes(1);
    expect(spies.recordLikenessRequest.mock.calls).toEqual([[2, FRESH]]);
  });
});
