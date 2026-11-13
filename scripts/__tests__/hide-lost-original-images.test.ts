import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as LegalHold from '~/server/services/legal-hold.service';

// The real hold predicates have their own suites; here a held image is one listed in "ImageHeld",
// a held owner one listed in "OwnerHeld".
const realHold = vi.hoisted(() => ({ on: false }));

vi.mock('~/server/services/legal-hold.service', async (importOriginal) => {
  const actual = await importOriginal<typeof LegalHold>();
  return {
    ...actual,
    // An image on post 777 stands for a predicate that comes back NULL: read that as held.
    // `realHold.on` swaps in the real predicate, for the tests of what it covers.
    captureImageHeldSql: (alias: string) => {
      if (realHold.on) return actual.captureImageHeldSql(alias);
      const a = Prisma.raw(alias);
      return Prisma.sql`(CASE WHEN ${a}."postId" = 777 THEN NULL ELSE ${a}.id IN (SELECT "imageId" FROM "ImageHeld") END)`;
    },
    // Owner 13 stands for a predicate that comes back NULL: the script must read that as held.
    ownerHeldSql: (owner: Prisma.Sql) =>
      Prisma.sql`(CASE WHEN ${owner} = 13 THEN NULL ELSE ${owner} IN (SELECT "userId" FROM "OwnerHeld") END)`,
  };
});

import {
  actedOn,
  appendDurable,
  keyShape,
  CROSS_CHECK_EXPIRES,
  assertIdsSha,
  idsSha,
  parseArgs,
  readIds,
  siblingLogs,
  readLog,
  rebust,
  run,
  undo,
  type Deps,
  type RunOptions,
} from '../oneoffs/hide-lost-original-images';

// Written out by hand from schema.full.prisma (every relation to Image that shows it as a display
// asset), NOT derived from the script's own list: deleting a surface from the script must fail here.
const EXPECTED_REFS: [reason: string, table: string, column: string][] = [
  ['user-picture', 'User', 'profilePictureId'],
  ['profile-cover', 'UserProfile', 'coverImageId'],
  ['profile-cover', 'UserProfile', 'sfwCoverImageId'],
  ['app-sub-listing-asset', 'app_sub_listings', 'image_id'],
  ['app-sub-listing-asset', 'app_sub_listings', 'pending_image_id'],
  ['announcement-cover', 'Announcement', 'coverId'],
  ['cosmetic-shop-section', 'CosmeticShopSection', 'imageId'],
  ['collection-cover', 'Collection', 'imageId'],
  ['club-image', 'Club', 'coverImageId'],
  ['club-image', 'Club', 'headerImageId'],
  ['club-image', 'Club', 'avatarId'],
  ['club-tier-cover', 'ClubTier', 'coverImageId'],
  ['club-post-cover', 'ClubPost', 'coverImageId'],
  ['reward-cover', 'PurchasableReward', 'coverImageId'],
  ['challenge-cover', 'Challenge', 'coverImageId'],
  ['challenge-winner', 'ChallengeWinner', 'imageId'],
  ['challenge-event-cover', 'ChallengeEvent', 'coverImageId'],
  ['comic-project-image', 'ComicProject', 'coverImageId'],
  ['comic-project-image', 'ComicProject', 'heroImageId'],
  ['comic-reference-image', 'ComicReferenceImage', 'imageId'],
  ['comic-panel', 'ComicPanel', 'imageId'],
  ['model3d-image', 'Model3D', 'thumbnailImageId'],
  ['model3d-image', 'Model3D', 'sourceImageId'],
  ['storyline-image', 'Storyline', 'coverImageId'],
  ['storyline-image', 'Storyline', 'heroImageId'],
  ['storyline-image', 'Storyline', 'sparkImageId'],
  ['storyline-cover-upload', 'StorylineCoverUpload', 'imageId'],
  ['model-cover', 'Model', 'coverImageId'],
  ['model-cover', 'Model', 'sfwCoverImageId'],
  ['service-offering-cover', 'ServiceOffering', 'coverImageId'],
  ['service-deal-file', 'ServiceDealFile', 'imageId'],
  ['service-deal-file-entry', 'ServiceDealFileEntry', 'imageId'],
  ['version-showcase-item', 'ModelVersionShowcaseItem', 'imageId'],
  ['challenge-entry-standing', 'ChallengeEntryStanding', 'imageId'],
  ['event-turf-sticker', 'EventTurfSticker', 'imageId'],
  ['event-turf-flag-sticker', 'EventTurfFlagSticker', 'imageId'],
  ['challenge-entry-comparison', 'ChallengeEntryComparison', 'imageIdA'],
  ['challenge-entry-comparison', 'ChallengeEntryComparison', 'imageIdB'],
  ['challenge-entry-comparison', 'ChallengeEntryComparison', 'firstSeatImageId'],
  ['challenge-entry-comparison', 'ChallengeEntryComparison', 'winnerImageId'],
  ['csam-queue-set-aside', 'CsamQueueSetAside', 'imageId'],
  ['image-removal-confirmation', 'ImageRemovalConfirmation', 'imageId'],
  ['scan-label-item', 'ScanLabelItem', 'imageId'],
  ['image-rating-request', 'ImageRatingRequest', 'imageId'],
  ['image-connection', 'ImageConnection', 'imageId'],
];
const REF_TABLES = [...new Set(EXPECTED_REFS.map(([, table]) => table))];

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM
      ('Pending','Scanned','Error','Blocked','NotFound','PendingManualAssignment','Rescan');
    CREATE TABLE "ImageHeld" ("imageId" int);
    CREATE TABLE "OwnerHeld" ("userId" int);
    CREATE TABLE "Image" (
      id int PRIMARY KEY, url text NOT NULL, "userId" int NOT NULL, "postId" int,
      ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned',
      "needsReview" text, "blockedFor" text, "tosViolation" boolean NOT NULL DEFAULT false,
      minor boolean NOT NULL DEFAULT false, poi boolean NOT NULL DEFAULT false,
      "scanJobs" jsonb, "scanRequestedAt" timestamp, "scannedAt" timestamp
    );
    CREATE TABLE "CollectionItem" ("imageId" int, status text NOT NULL);
    CREATE TABLE "Report" (id int PRIMARY KEY, status text NOT NULL);
    CREATE TABLE "ImageReport" ("imageId" int, "reportId" int);
    CREATE TABLE "PostReport" ("postId" int, "reportId" int);
    CREATE TABLE "Article" ("coverId" int, "bannerId" int);
    CREATE TABLE app_listings (icon_id int, cover_id int);
    CREATE TABLE app_listing_screenshots (image_id int);
    CREATE TABLE "Crucible" ("imageId" int, "heroImageId" int);
    CREATE TABLE "CrucibleEntry" ("imageId" int);
    CREATE TABLE "CsamReport" (images jsonb NOT NULL DEFAULT '[]');
    CREATE TABLE "EvidenceHoldImage" ("imageId" int);
  `);
});

const GONE = [1, 2, 3];

beforeAll(async () => {
  for (const table of REF_TABLES) {
    const columns = EXPECTED_REFS.filter(([, t]) => t === table).map(([, , c]) => `"${c}" int`);
    await db.exec(`CREATE TABLE "${table}" (${columns.join(', ')})`);
  }
});

beforeEach(async () => {
  await db.exec(`
    TRUNCATE "Image", "ImageHeld", "OwnerHeld", "CollectionItem", "Crucible", "CrucibleEntry", "CsamReport", "EvidenceHoldImage", "Report", "ImageReport", "PostReport", "Article", app_listings, app_listing_screenshots;
    INSERT INTO "Image" (id, url, "userId", "postId") VALUES
      (1,'00000001-0000-4000-8000-000000000000',10,100),(2,'00000002-0000-4000-8000-000000000000',10,100),(3,'00000003-0000-4000-8000-000000000000',11,101),
      (900,'f0000900-0000-4000-8000-000000000000',12,102),(901,'f0000901-0000-4000-8000-000000000000',12,102);
  `);
  for (const table of REF_TABLES) await db.exec(`TRUNCATE "${table}"`);
});

const query: Deps['query'] = async <T>(sql: Prisma.Sql) => {
  const r = await db.query(sql.text, sql.values as unknown[]);
  return r.rows as T[];
};
const ingestion = async (id: number) =>
  (
    (await db.query(`SELECT ingestion::text AS i FROM "Image" WHERE id=${id}`)).rows[0] as {
      i: string;
    }
  ).i;

const options = (over: Partial<RunOptions> = {}): RunOptions => ({
  apply: true,
  undo: false,
  idsFile: 'ids',
  logFile: 'log',
  limit: Number.MAX_SAFE_INTEGER,
  chunk: 200,
  concurrency: 4,
  pauseMs: 0,
  recheckMs: 0,
  idsSha: null,
  crossCheckRerun: false,
  rebust: null,
  includeUnconfirmed: false,
  ...over,
});

function makeDeps(over: Partial<Deps> = {}) {
  const logged: { id: number; prior: string }[] = [];
  const propagated: { ids: number[]; action: string }[] = [];
  const lines: string[] = [];
  const deps: Deps = {
    query,
    head: async (url) => {
      if (url.startsWith('0000000')) return 'missing';
      return 'present';
    },
    isExternal: (url) => url.startsWith('http'),
    propagate: async (touched, action) => {
      propagated.push({ ids: touched.map((t) => t.id), action });
    },
    appendLog: (e) => logged.push(...e),
    sleep: async () => undefined,
    log: (l) => lines.push(l),
    now: () => CROSS_CHECK_EXPIRES - 1000,
    ...over,
  };
  return { deps, logged, propagated, lines };
}

describe('hide-lost-original-images', () => {
  it('hides only ids that still 404, logs the prior value, and propagates them', async () => {
    const { deps, logged, propagated } = makeDeps({
      head: async (url) =>
        url === '00000002-0000-4000-8000-000000000000'
          ? 'present'
          : url.startsWith('0000000')
          ? 'missing'
          : 'present',
    });
    const counts = await run(options(), GONE, deps);
    expect([await ingestion(1), await ingestion(2), await ingestion(3)]).toEqual([
      'NotFound',
      'Scanned',
      'NotFound',
    ]);
    expect(logged).toEqual([
      { id: 1, prior: 'Scanned' },
      { id: 3, prior: 'Scanned' },
      { id: 1, prior: 'Scanned', hidden: true },
      { id: 3, prior: 'Scanned', hidden: true },
    ]);
    expect(propagated).toEqual([{ ids: [1, 3], action: 'hide' }]);
    expect(counts['skipped:now-200']).toBe(1);
    expect(counts.hidden).toBe(2);
  });

  it('skips an id whose HEAD errors rather than hiding it', async () => {
    const { deps } = makeDeps({
      head: async (url) => {
        if (url === '00000001-0000-4000-8000-000000000000') throw new Error('throttled');
        return url.startsWith('0000000') ? 'missing' : 'present';
      },
    });
    const counts = await run(options(), GONE, deps);
    expect(await ingestion(1)).toBe('Scanned');
    expect(counts['skipped:head-error']).toBe(1);
  });

  it('leaves held, in-review and non-Scanned rows alone and says why', async () => {
    await db.exec(`
      INSERT INTO "ImageHeld" VALUES (1);
      INSERT INTO "OwnerHeld" VALUES (11);
      UPDATE "Image" SET "needsReview" = 'minor' WHERE id = 2;
    `);
    const { deps } = makeDeps();
    const counts = await run(options(), GONE, deps);
    expect([await ingestion(1), await ingestion(2), await ingestion(3)]).toEqual([
      'Scanned',
      'Scanned',
      'Scanned',
    ]);
    expect(counts['skipped:image-hold']).toBe(1);
    expect(counts['skipped:needs-review']).toBe(1);
    expect(counts['skipped:owner-hold']).toBe(1);
  });

  it('a hold placed after the check still stops the write', async () => {
    const { deps } = makeDeps({
      head: async (url) => {
        if (url === '00000001-0000-4000-8000-000000000000')
          await db.exec(`INSERT INTO "ImageHeld" VALUES (1)`);
        return url.startsWith('0000000') ? 'missing' : 'present';
      },
    });
    const counts = await run(options(), GONE, deps);
    expect(await ingestion(1)).toBe('Scanned');
    expect(counts['raced-out']).toBe(1);
  });

  it('logs a confirmation only for rows the UPDATE returned, and undo acts on those alone', async () => {
    const { deps, logged } = makeDeps({
      head: async (url) => {
        if (url === '00000001-0000-4000-8000-000000000000')
          await db.exec(`INSERT INTO "ImageHeld" VALUES (1)`);
        return url.startsWith('0000000') ? 'missing' : 'present';
      },
    });
    await run(options(), GONE, deps);
    expect(
      logged
        .filter((e) => e.hidden)
        .map((e) => e.id)
        .sort()
    ).toEqual([2, 3]);
    expect(actedOn(logged, false).map((e) => e.id)).toEqual([2, 3]);
    expect(actedOn(logged, true).map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it('leaves a crucible cover, hero or entry image alone', async () => {
    await db.exec(`
      INSERT INTO "Crucible" VALUES (1, NULL);
      INSERT INTO "Crucible" VALUES (NULL, 2);
      INSERT INTO "CrucibleEntry" VALUES (3);
    `);
    const { deps } = makeDeps();
    const counts = await run(options(), GONE, deps);
    expect([await ingestion(1), await ingestion(2), await ingestion(3)]).toEqual([
      'Scanned',
      'Scanned',
      'Scanned',
    ]);
    expect(counts['skipped:crucible-image']).toBe(3);
  });

  it('logs the intent before the UPDATE runs', async () => {
    const { deps, logged } = makeDeps({
      query: async <T>(sql: Prisma.Sql) => {
        if (sql.text.includes(`SET ingestion = 'NotFound'`)) throw new Error('crash before write');
        return query<T>(sql);
      },
    });
    await expect(run(options(), GONE, deps)).rejects.toThrow('crash before write');
    expect(logged.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(logged.some((e) => e.hidden)).toBe(false);
    expect(await ingestion(1)).toBe('Scanned');
  });

  it.each([
    ['blocked-for', `"blockedFor" = 'CSAM'`],
    ['tos', `"tosViolation" = true`],
    ['minor', `minor = true`],
    ['poi', `poi = true`],
    ['needs-review', `"needsReview" = 'minor'`],
  ])('leaves a row alone for %s', async (reason, set) => {
    await db.exec(`UPDATE "Image" SET ${set} WHERE id = 1`);
    const { deps } = makeDeps();
    const counts = await run(options(), GONE, deps);
    expect(await ingestion(1)).toBe('Scanned');
    expect(counts[`skipped:${reason}`]).toBe(1);
    expect(counts.hidden).toBe(2);
  });

  it('leaves an image alone whose post has an open report, not one with a closed report', async () => {
    await db.exec(`INSERT INTO "Report" VALUES (1,'Pending'),(2,'Actioned')`);
    await db.exec(`INSERT INTO "PostReport" VALUES (100,1),(101,2)`);
    const { deps } = makeDeps();
    const counts = await run(options(), GONE, deps);
    expect(await ingestion(1)).toBe('Scanned');
    expect(await ingestion(2)).toBe('Scanned');
    expect(await ingestion(3)).toBe('NotFound');
    expect(counts['skipped:open-post-report']).toBe(2);
  });

  it('reads an image-hold predicate that comes back NULL as held', async () => {
    await db.exec(`UPDATE "Image" SET "postId" = 777 WHERE id = 1`);
    const { deps } = makeDeps();
    const counts = await run(options(), GONE, deps);
    expect(await ingestion(1)).toBe('Scanned');
    expect(counts['skipped:image-hold']).toBe(1);
  });

  it('reads a hold predicate that comes back NULL as held', async () => {
    await db.exec(`UPDATE "Image" SET "userId" = 13 WHERE id = 1`);
    const { deps } = makeDeps();
    const counts = await run(options(), GONE, deps);
    expect(await ingestion(1)).toBe('Scanned');
    expect(counts['skipped:owner-hold']).toBe(1);
  });

  it('writes nothing on a dry run', async () => {
    const { deps, logged, propagated } = makeDeps();
    const counts = await run(options({ apply: false }), GONE, deps);
    expect(await ingestion(1)).toBe('Scanned');
    expect(logged).toEqual([]);
    expect(propagated).toEqual([]);
    expect(counts['would-hide']).toBe(3);
  });

  it('a second run changes nothing', async () => {
    const first = makeDeps();
    await run(options(), GONE, first.deps);
    const second = makeDeps();
    const counts = await run(options(), GONE, second.deps);
    expect(second.logged).toEqual([]);
    expect(counts.hidden).toBe(0);
    expect(counts['skipped:not-scanned']).toBe(3);
  });

  it('--limit 1 hides exactly one', async () => {
    const { deps } = makeDeps();
    const counts = await run(options({ limit: 1 }), GONE, deps);
    expect(counts.hidden).toBe(1);
    expect([await ingestion(1), await ingestion(2), await ingestion(3)]).toEqual([
      'NotFound',
      'Scanned',
      'Scanned',
    ]);
  });

  it('refuses to trust a 404 when the control images do not HEAD present', async () => {
    const { deps } = makeDeps({ head: async () => 'missing' });
    await expect(run(options(), GONE, deps)).rejects.toThrow(/control failed/);
    expect(await ingestion(1)).toBe('Scanned');
  });

  it('refuses a write after the cross-check expires unless it was re-run', async () => {
    const { deps } = makeDeps({ now: () => CROSS_CHECK_EXPIRES + 1 });
    await expect(run(options(), GONE, deps)).rejects.toThrow(/expired/);
    await expect(run(options({ crossCheckRerun: true }), GONE, deps)).resolves.toBeDefined();
  });

  it('undo restores the prior value only where the row is still NotFound', async () => {
    const { deps, propagated } = makeDeps();
    await run(options(), GONE, deps);
    await db.exec(`UPDATE "Image" SET ingestion = 'Blocked' WHERE id = 3`);
    const restored = await undo(
      GONE.map((id) => ({ id, prior: 'Scanned' })),
      options({ undo: true }),
      deps
    );
    expect(restored).toBe(2);
    expect([await ingestion(1), await ingestion(2), await ingestion(3)]).toEqual([
      'Scanned',
      'Scanned',
      'Blocked',
    ]);
    expect(propagated.at(-1)?.action).toBe('undo');
  });

  it('leaves an image alone while it is a pending item in a collection', async () => {
    await db.exec(`INSERT INTO "CollectionItem" VALUES (1, 'REVIEW'), (2, 'ACCEPTED')`);
    const { deps } = makeDeps();
    const counts = await run(options(), GONE, deps);
    expect([await ingestion(1), await ingestion(2)]).toEqual(['Scanned', 'NotFound']);
    expect(counts['skipped:pending-collection-item']).toBe(1);
  });

  it('skips an external url without a HEAD', async () => {
    await db.exec(`UPDATE "Image" SET url = 'http://elsewhere/x' WHERE id = 1`);
    const heads: string[] = [];
    const { deps } = makeDeps({
      head: async (u) => {
        heads.push(u);
        return u.startsWith('0000000') ? 'missing' : 'present';
      },
    });
    const counts = await run(options(), GONE, deps);
    expect(heads).not.toContain('http://elsewhere/x');
    expect(counts['skipped:external-url']).toBe(1);
  });

  it('--limit holds across chunks', async () => {
    const { deps } = makeDeps();
    const counts = await run(options({ limit: 2, chunk: 1 }), GONE, deps);
    expect(counts.hidden).toBe(2);
    expect(await ingestion(3)).toBe('Scanned');
  });

  it('reports scan-in-flight by both signals and their overlap, without writing', async () => {
    await db.exec(`
      UPDATE "Image" SET "scanJobs" = '{"workflowId":"w"}' WHERE id IN (1, 2);
      UPDATE "Image" SET "scannedAt" = '2024-01-01', "scanRequestedAt" = '2024-02-01' WHERE id IN (2, 3);
    `);
    const { deps } = makeDeps();
    const counts = await run(options({ apply: false }), GONE, deps);
    expect(counts['scan-in-flight:workflow-present']).toBe(2);
    expect(counts['scan-in-flight:requested-after-scanned']).toBe(2);
    expect(counts['scan-in-flight:both']).toBe(1);
  });

  it('undo leaves a row that was held while hidden', async () => {
    const { deps } = makeDeps();
    await run(options(), GONE, deps);
    await db.exec(`INSERT INTO "ImageHeld" VALUES (1)`);
    const restored = await undo(
      GONE.map((id) => ({ id, prior: 'Scanned' })),
      options({ undo: true }),
      deps
    );
    expect(restored).toBe(2);
    expect(await ingestion(1)).toBe('NotFound');
  });

  it('a failed cache update stops the run, and --rebust catches the rows up', async () => {
    let fail = true;
    const calls: number[][] = [];
    const { deps, lines } = makeDeps({
      propagate: async (t) => {
        if (fail) throw new Error('redis down');
        calls.push(t.map((x) => x.id));
      },
    });
    await expect(run(options(), GONE, deps)).rejects.toThrow('redis down');
    expect(lines.join('\n')).toMatch(/run --rebust hide/);
    expect(await ingestion(1)).toBe('NotFound');
    fail = false;
    const n = await rebust(
      GONE.map((id) => ({ id, prior: 'Scanned' })),
      'hide',
      options(),
      deps
    );
    expect(n).toBe(3);
    expect(calls.flat().sort()).toEqual([1, 2, 3]);
  });

  it('--rebust without --apply writes nothing', async () => {
    const { deps, propagated } = makeDeps();
    await run(options(), GONE, deps);
    propagated.length = 0;
    const n = await rebust(
      GONE.map((id) => ({ id, prior: 'Scanned' })),
      'hide',
      options({ apply: false }),
      deps
    );
    expect(n).toBe(0);
    expect(propagated).toEqual([]);
  });

  it('appendDurable writes the whole line when the disk takes a short write', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hide-test-'));
    const log = path.join(dir, 'log');
    const real = fs.writeSync;
    let first = true;
    const spy = vi.spyOn(fs, 'writeSync').mockImplementation(((
      fd: number,
      buf: Uint8Array,
      offset?: number
    ) => {
      if (first) {
        first = false;
        return real(fd, buf, offset ?? 0, Math.ceil((buf.length - (offset ?? 0)) / 2));
      }
      return real(fd, buf, offset ?? 0);
    }) as never);
    try {
      appendDurable(log, '{"id":1,"prior":"Scanned"}\n');
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(log, 'utf8')).toBe('{"id":1,"prior":"Scanned"}\n');
  });

  it('refuses a log line that is not an entry, unless it is the torn last line', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hide-test-'));
    const log = path.join(dir, 'log');
    fs.writeFileSync(log, 'not a log');
    expect(() => readLog(log)).toThrow();
    fs.writeFileSync(log, 'null\n{"id":2,"prior":"Scanned"}\n');
    expect(() => readLog(log)).toThrow();
    fs.writeFileSync(log, '{"id":2,"prior":"Blocked"}\n{"id":3,"prior":"Scanned"}\n');
    expect(() => readLog(log)).toThrow();
    fs.writeFileSync(log, '{"id":2,"prior":"Scanned"}\nnull\n');
    expect(readLog(log).map((e) => e.id)).toEqual([2]);
  });

  it('reads the log with a torn last line, and the ids file strictly', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hide-test-'));
    const log = path.join(dir, 'log');
    appendDurable(log, '{"id":1,"prior":"Scanned"}\n{"id":2,"prior":"Sca');
    expect(readLog(log)).toEqual([{ id: 1, prior: 'Scanned' }]);
    // The next append must not be swallowed by the torn line.
    appendDurable(log, '{"id":3,"prior":"Scanned"}\n{"id":4,"prior":"Scanned"}\n');
    expect(readLog(log).map((e) => e.id)).toEqual([1, 3, 4]);
    fs.writeFileSync(log, '{"id":1\n{"id":2,"prior":"Scanned"}\n');
    expect(() => readLog(log)).toThrow();
    const ids = path.join(dir, 'ids');
    fs.writeFileSync(ids, '3\n1\n3\n');
    expect(readIds(ids)).toEqual([1, 3]);
    fs.writeFileSync(ids, '9999999999\n');
    expect(() => readIds(ids)).toThrow(/not an id/);
  });

  it('aborts when a quantile of the targets has no live image to vouch for it', async () => {
    const { deps } = makeDeps();
    await expect(run(options(), [...GONE, 1000], deps)).rejects.toThrow(/control failed/);
    expect(await ingestion(1)).toBe('Scanned');
  });

  it('refuses to trust the HEADs when one control image is missing and another present', async () => {
    await db.exec(
      `INSERT INTO "Image" (id, url, "userId") VALUES (950, 'f0000950-0000-4000-8000-000000000000', 12)`
    );
    const { deps } = makeDeps({
      head: async (url) =>
        url === 'f0000950-0000-4000-8000-000000000000' || url.startsWith('0000000')
          ? 'missing'
          : 'present',
    });
    // Targets spread over the id range, so the control samples f0000900-0000-4000-8000-000000000000 (present) and f0000950-0000-4000-8000-000000000000 (missing).
    await expect(run(options(), [...GONE, 940], deps)).rejects.toThrow(/control failed/);
    expect(await ingestion(1)).toBe('Scanned');
  });

  it('stops before writing a chunk when the control fails mid-run', async () => {
    let controlHeads = 0;
    const { deps } = makeDeps({
      head: async (url) => {
        if (url.startsWith('f0000')) {
          controlHeads += 1;
          // The first chunk's three controls (start, before its HEADs, before its write) pass; later fail.
          return controlHeads > 15 ? 'missing' : 'present';
        }
        return 'missing';
      },
    });
    await expect(run(options({ chunk: 1 }), GONE, deps)).rejects.toThrow(/mid-run/);
    expect(await ingestion(1)).toBe('NotFound');
    expect(await ingestion(2)).toBe('Scanned');
  });

  it('skips a non-uuid url whose shape matches the controls, without a HEAD', async () => {
    // keyShape collapses runs, so five hyphenated words share the uuid shape; the key itself is no uuid.
    await db.exec(`UPDATE "Image" SET url = 'ab-cd-ef-gh-ij' WHERE id = 1`);
    const heads: string[] = [];
    const { deps } = makeDeps({
      head: async (u) => {
        heads.push(u);
        return u.startsWith('0000000') ? 'missing' : 'present';
      },
    });
    const counts = await run(options(), GONE, deps);
    expect(heads).not.toContain('ab-cd-ef-gh-ij');
    expect(counts['skipped:odd-url']).toBe(1);
    expect(await ingestion(1)).toBe('Scanned');
  });

  it('skips a url with whitespace without a HEAD', async () => {
    await db.exec(`UPDATE "Image" SET url = '00000001-0000-4000-8000-000000000000 ' WHERE id = 1`);
    const heads: string[] = [];
    const { deps } = makeDeps({
      head: async (u) => {
        heads.push(u);
        return u.startsWith('0000000') ? 'missing' : 'present';
      },
    });
    const counts = await run(options(), GONE, deps);
    expect(heads).not.toContain('00000001-0000-4000-8000-000000000000 ');
    expect(counts['skipped:odd-url']).toBe(1);
  });

  it('skips a target whose key is not a bare uuid, without a HEAD', async () => {
    await db.exec(`
      UPDATE "Image" SET url = '/00000001-0000-4000-8000-000000000000' WHERE id = 1;
      UPDATE "Image" SET url = '00000002-0000-4000-8000-000000000000.jpg' WHERE id = 2;
    `);
    const heads: string[] = [];
    const { deps } = makeDeps({
      head: async (u) => {
        heads.push(u);
        return u.startsWith('0000000') ? 'missing' : 'present';
      },
    });
    const counts = await run(options(), GONE, deps);
    expect(heads).not.toContain('/00000001-0000-4000-8000-000000000000');
    expect(heads).not.toContain('00000002-0000-4000-8000-000000000000.jpg');
    expect(counts['skipped:odd-url']).toBe(2);
    expect(counts.hidden).toBe(1);
  });

  it('describes a key by its structure, not its characters', () => {
    expect(keyShape('3f2b9c1e-0a4d-4b7e-9c11-2f6d8a5e7b10')).toBe('a-a-a-a-a');
    expect(keyShape('3f2b9c1e-0a4d-4b7e-9c11-2f6d8a5e7b10.jpg')).toBe('a-a-a-a-a.a');
    expect(keyShape('/3f2b9c1e')).toBe('/a');
  });

  it('leaves an image alone while a report on it is open, but not once it is closed', async () => {
    await db.exec(`
      INSERT INTO "Report" VALUES (1, 'Pending'), (2, 'Processing'), (3, 'Actioned');
      INSERT INTO "ImageReport" VALUES (1, 1), (2, 2), (3, 3);
    `);
    const { deps } = makeDeps();
    const counts = await run(options(), GONE, deps);
    expect([await ingestion(1), await ingestion(2), await ingestion(3)]).toEqual([
      'Scanned',
      'Scanned',
      'NotFound',
    ]);
    expect(counts['skipped:open-report']).toBe(2);
  });

  it('leaves article covers and banners and app-listing assets alone', async () => {
    await db.exec(`
      INSERT INTO "Article" VALUES (1, NULL), (NULL, 2);
      INSERT INTO app_listing_screenshots VALUES (3);
    `);
    const { deps } = makeDeps();
    const counts = await run(options(), GONE, deps);
    expect(counts['skipped:article-image']).toBe(2);
    expect(counts['skipped:app-listing-asset']).toBe(1);
    expect(counts.hidden).toBe(0);
    await db.exec(
      `DELETE FROM "Article"; DELETE FROM app_listing_screenshots; INSERT INTO app_listings VALUES (1, 2)`
    );
    const again = await run(options(), GONE, makeDeps().deps);
    expect(again['skipped:app-listing-asset']).toBe(2);
    expect(again.hidden).toBe(1);
  });

  it('lists the other run logs beside the log, counts only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hide-test-'));
    fs.writeFileSync(
      path.join(dir, 'a.jsonl'),
      '{"id":1,"prior":"Scanned"}\n{"id":1,"prior":"Scanned","hidden":true}\n{"id":2,"prior":"Scanned"}\n'
    );
    fs.writeFileSync(path.join(dir, 'own.jsonl'), '{"id":9,"prior":"Scanned"}\n');
    fs.writeFileSync(path.join(dir, 'ids.txt'), '1\n');
    expect(siblingLogs(path.join(dir, 'own.jsonl'))).toEqual([
      { name: 'a.jsonl', entries: 3, unconfirmed: 1 },
    ]);
  });

  it('does not hide a row whose url changed after it was HEADed', async () => {
    const { deps } = makeDeps({
      head: async (url) => {
        if (url === '00000001-0000-4000-8000-000000000000')
          await db.exec(
            `UPDATE "Image" SET url = '0000000a-0000-4000-8000-000000000000' WHERE id = 1`
          );
        return url.startsWith('0000000') ? 'missing' : 'present';
      },
    });
    const counts = await run(options(), GONE, deps);
    expect(await ingestion(1)).toBe('Scanned');
    expect(counts['raced-out']).toBe(1);
  });

  it('stops before the HEADs of a chunk when the control is unhealthy at that point', async () => {
    let controlHeads = 0;
    const targetHeads: string[] = [];
    const { deps } = makeDeps({
      head: async (url) => {
        if (url.startsWith('f0000')) {
          controlHeads += 1;
          return controlHeads > 5 ? 'missing' : 'present';
        }
        targetHeads.push(url);
        return 'missing';
      },
    });
    await expect(run(options(), GONE, deps)).rejects.toThrow(/before this chunk was HEADed/);
    expect(targetHeads).toEqual([]);
  });

  it('undo restores a row that became an article cover or reported, but not one under a safety hold', async () => {
    const { deps } = makeDeps();
    await run(options(), GONE, deps);
    await db.exec(`
      INSERT INTO "Article" VALUES (1, NULL);
      INSERT INTO "Report" VALUES (1, 'Pending');
      INSERT INTO "ImageReport" VALUES (2, 1);
      UPDATE "Image" SET minor = true WHERE id = 3;
    `);
    const restored = await undo(
      GONE.map((id) => ({ id, prior: 'Scanned' })),
      options({ undo: true }),
      deps
    );
    expect(restored).toBe(2);
    expect([await ingestion(1), await ingestion(2), await ingestion(3)]).toEqual([
      'Scanned',
      'Scanned',
      'NotFound',
    ]);
  });

  it('hands the owner ids to the cache step, for hide and for undo', async () => {
    const seen: (number | undefined)[] = [];
    const { deps } = makeDeps({
      propagate: async (t) => {
        seen.push(...t.map((x) => x.userId));
      },
    });
    await run(options(), GONE, deps);
    expect(seen.sort()).toEqual([10, 10, 11]);
    seen.length = 0;
    await undo(
      GONE.map((id) => ({ id, prior: 'Scanned' })),
      options({ undo: true }),
      deps
    );
    expect(seen.sort()).toEqual([10, 10, 11]);
  });

  // One case per surface and per column: another entity shows the image, so a hide would break it
  // there without telling the owner (Moderation Lead's rule).
  it.each(EXPECTED_REFS)(
    'leaves an image alone that is shown as %s (%s.%s)',
    async (reason, table, column) => {
      await db.exec(`INSERT INTO "${table}" ("${column}") VALUES (1)`);
      const { deps } = makeDeps();
      const counts = await run(options(), GONE, deps);
      expect(await ingestion(1)).toBe('Scanned');
      expect(counts[`skipped:${reason}`]).toBe(1);
      expect(counts.hidden).toBe(2);
    }
  );

  // The real hold predicate, not the mock: a CsamReport that lists the image holds it. The real
  // predicate reads no status from the report, so whatever state the report is in, it holds.
  it.each([
    ['objects', [{ id: 1 }, { id: 2 }]],
    ['strings', ['1', '2']],
    ['numbers', [1, 2]],
  ])('leaves an image alone that a CsamReport lists as %s', async (_shape, listed) => {
    // The script builds its hold SQL when it loads, so load a copy with the real predicate.
    realHold.on = true;
    vi.resetModules();
    try {
      const real = await import('../oneoffs/hide-lost-original-images');
      await db.query(`INSERT INTO "CsamReport" (images) VALUES ($1::jsonb)`, [
        JSON.stringify(listed),
      ]);
      const { deps } = makeDeps();
      const counts = await real.run(options(), GONE, deps);
      expect(await ingestion(1)).toBe('Scanned');
      expect(await ingestion(2)).toBe('Scanned');
      expect(await ingestion(3)).toBe('NotFound');
      expect(counts['skipped:image-hold']).toBe(2);
    } finally {
      realHold.on = false;
      vi.resetModules();
    }
  });

  it('hides a row only if a second HEAD, after a wait, also reads missing', async () => {
    const seen = new Map<string, number>();
    const waits: number[] = [];
    const { deps } = makeDeps({
      head: async (url) => {
        const n = (seen.get(url) ?? 0) + 1;
        seen.set(url, n);
        if (url === '00000001-0000-4000-8000-000000000000') return n === 1 ? 'missing' : 'present';
        return url.startsWith('0000000') ? 'missing' : 'present';
      },
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    const counts = await run(options({ recheckMs: 7 }), GONE, deps);
    expect(await ingestion(1)).toBe('Scanned');
    expect(await ingestion(2)).toBe('NotFound');
    expect(counts['skipped:recheck-ok']).toBe(1);
    expect(waits).toContain(7);
  });

  it('counts a second HEAD that errors as head-error, not recheck-ok', async () => {
    const seen = new Map<string, number>();
    const { deps } = makeDeps({
      head: async (url) => {
        const n = (seen.get(url) ?? 0) + 1;
        seen.set(url, n);
        if (url === '00000001-0000-4000-8000-000000000000' && n === 2) throw new Error('throttled');
        return url.startsWith('0000000') ? 'missing' : 'present';
      },
    });
    const counts = await run(options(), GONE, deps);
    expect(await ingestion(1)).toBe('Scanned');
    expect(counts['skipped:head-error']).toBe(1);
    expect(counts['skipped:recheck-ok']).toBeUndefined();
  });

  it('assertIdsSha refuses an apply whose --ids-sha is not the hash of the ids', () => {
    const ids = [1, 2, 3];
    expect(() => assertIdsSha(options({ idsSha: null }), ids)).toThrow(/--ids-sha/);
    expect(() => assertIdsSha(options({ idsSha: idsSha([1, 2, 4]) }), ids)).toThrow(/--ids-sha/);
    expect(() => assertIdsSha(options({ idsSha: idsSha(ids) }), ids)).not.toThrow();
    // A dry run needs no hash: it is where the hash comes from.
    expect(() => assertIdsSha(options({ apply: false, idsSha: null }), ids)).not.toThrow();
  });

  it('does not call ids unread under --limit no-row', async () => {
    const { deps } = makeDeps();
    const counts = await run(options({ limit: 1, chunk: 1 }), GONE, deps);
    expect(counts['no-row']).toBeUndefined();
  });

  it('reports how many control images vouched for the HEADs', async () => {
    const { deps } = makeDeps();
    const counts = await run(options({ apply: false }), GONE, deps);
    expect(counts.controls).toBeGreaterThan(0);
  });

  it('--rebust hide skips a row that is no longer NotFound; --rebust undo covers restored rows', async () => {
    const calls: { ids: number[]; action: string }[] = [];
    const { deps } = makeDeps({
      propagate: async (t, action) => {
        calls.push({ ids: t.map((x) => x.id).sort(), action });
      },
    });
    await run(options(), GONE, deps);
    calls.length = 0;
    await db.exec(`UPDATE "Image" SET ingestion = 'Blocked' WHERE id = 3`);
    const entries = GONE.map((id) => ({ id, prior: 'Scanned' }));
    expect(await rebust(entries, 'hide', options(), deps)).toBe(2);
    expect(calls).toEqual([{ ids: [1, 2], action: 'hide' }]);

    calls.length = 0;
    await undo(entries, options({ undo: true }), deps);
    calls.length = 0;
    expect(await rebust(entries, 'undo', options(), deps)).toBe(2);
    expect(calls).toEqual([{ ids: [1, 2], action: 'undo' }]);
  });

  it('parseArgs refuses an unknown flag, so a typo cannot turn a canary into a full apply', () => {
    for (const bad of [
      ['--limt', '1'],
      ['--limit=1'],
      ['-limit', '1'],
      ['\u2013limit', '1'],
      ['stray'],
    ])
      expect(() => parseArgs(['--ids', 'a', '--log', 'l', '--apply', ...bad])).toThrow(
        /unknown argument/
      );
  });

  it('refuses to run when a control image is no bare uuid, even though it HEADs present', async () => {
    await db.exec(`UPDATE "Image" SET url = 'ab-cd-ef-gh-ij' WHERE id IN (900, 901)`);
    const { deps } = makeDeps();
    await expect(run(options(), GONE, deps)).rejects.toThrow(/control failed/);
    expect(await ingestion(1)).toBe('Scanned');
  });

  it('parseArgs refuses a repeated flag, so an appended --limit 1 cannot lose to an earlier --limit 50', () => {
    expect(() => parseArgs(['--ids', 'a', '--log', 'l', '--limit', '50', '--limit', '1'])).toThrow(
      /repeated argument/
    );
    expect(() => parseArgs(['--ids', 'a', '--log', 'l', '--apply', '--apply'])).toThrow(
      /repeated argument/
    );
  });

  it('parseArgs refuses --limit with --undo or --rebust, which would not honour it', () => {
    expect(() => parseArgs(['--log', 'l', '--undo', '--limit', '1'])).toThrow(/--limit/);
    expect(() => parseArgs(['--log', 'l', '--rebust', 'hide', '--limit', '1'])).toThrow(/--limit/);
  });

  it('parseArgs requires a log and, outside undo, an ids file', () => {
    expect(() => parseArgs(['--ids', 'a'])).toThrow(/--log/);
    expect(() => parseArgs(['--log', 'l'])).toThrow(/--ids/);
    expect(parseArgs(['--log', 'l', '--undo']).undo).toBe(true);
    expect(() => parseArgs(['--ids', 'same', '--log', 'same'])).toThrow(/ids file/);
    expect(() => parseArgs(['--ids', './same', '--log', 'same'])).toThrow(/ids file/);
  });
});
