import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';
import { INQUISITOR_IMAGE_SCHEMA } from '../knights/__tests__/inquisitor-schema';
import {
  CSAM_RESTRICTION_CASES,
  csamCaseCleanupSql,
} from '../../../../../../packages/civitai-shared/src/__tests__/csam-restriction-cases';

/**
 * Which images a review batch may show on the general tier (`imageRoutesHeld`, shared with the main
 * app's mint): the retracted-media routes' rule for a moderator without the CSAM grant. Every image
 * this lets through is shown outside the held route, so the misses are the point: each CSAM leg is a
 * row that must route held, beside a twin that differs only in that leg and must not. A minor signal
 * alone stays general.
 */

vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../db', () => ({
  get dbRead() {
    throw new Error('routing must read the primary');
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
vi.mock('../redis', () => ({ getSysRedis: () => ({}) }));
const { scanner } = vi.hoisted(() => ({ scanner: { csamHit: new Set<string>() } }));
vi.mock('../clickhouse', () => ({
  getClickhouse: () => ({
    query: async ({ query_params }: { query_params: { hashes: string[] } }) => ({
      json: async () =>
        query_params.hashes.map((contentHash) => ({
          contentHash,
          hit: scanner.csamHit.has(contentHash) ? 1 : 0,
          csamHit: scanner.csamHit.has(contentHash) ? 1 : 0,
        })),
    }),
  }),
}));

process.env.REVIEW_SHEET_BLOCKEDFOR_PATTERNS = '# signal\n^sig.*$\n# known-non-minor\n^benign$';
const { getBatchMedia, routesHeldNow } = await import('../review-batch');
const { imageAuditContentHash } = await import('@civitai/shared/media-signals');

const CHILD_TAG = 5351;

const SCHEMA = INQUISITOR_IMAGE_SCHEMA.replace(
  'url TEXT NOT NULL,',
  "url TEXT NOT NULL DEFAULT 'key',"
).replace(
  'CREATE TABLE "ScanLabelVote" ("itemId" INTEGER, reason TEXT);',
  'CREATE TABLE "ScanLabelVote" ("itemId" INTEGER, "userId" INTEGER, reason TEXT);'
);

// Pairs: the first id carries one leg and must route held; the second differs only there.
const CASES: [string, number, number][] = [
  ['heldImageSql (needsReview csam)', 10, 11],
  ['a CSAM hash block', 40, 41],
  ['a scan flag reporting CSAM', 50, 51],
  ['a CSAM-realistic vote', 62, 61],
  ['a CSAM hold on the label item', 70, 71],
  ['a scan that has not finished', 80, 81],
  ['a blockedFor value matching no known-non-minor pattern', 90, 91],
  ['a blockedFor signal pattern', 92, 93],
  ['an image listed on a CsamReport about another user', 100, 101],
  ['an image listed by bare id on a CsamReport', 102, 101],
  ['a held row sharing its url', 120, 101],
  ['a row with a block-reason signal sharing its url', 130, 101],
];

// A minor signal alone: each stays general, as on the retracted-media routes.
const MINOR_ONLY: [string, number][] = [
  ['the minor flag', 20],
  ['the minor review queue', 12],
  ['an accepted minor', 22],
  ['a child-type tag on a mature image', 30],
  ['a child-type tag on an unrated image', 34],
  ['a scan flag reporting a minor', 52],
  ['a moderator vote naming a minor', 60],
];

let db: PGlite;

beforeAll(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  await db.exec(`
    INSERT INTO "Image" ("id", "needsReview", "minor", "nsfwLevel", "pHash", "ingestion", "blockedFor") VALUES
      (10, 'csam', FALSE, 1, NULL, 'Scanned', NULL), (11, 'poi', FALSE, 1, NULL, 'Scanned', NULL),
      (12, 'minor', FALSE, 1, NULL, 'Scanned', NULL),
      (20, NULL, TRUE, 1, NULL, 'Scanned', NULL), (21, NULL, FALSE, 1, NULL, 'Scanned', NULL),
      (22, NULL, FALSE, 1, NULL, 'Scanned', NULL),
      (30, NULL, FALSE, 8, NULL, 'Scanned', NULL), (31, NULL, FALSE, 1, NULL, 'Scanned', NULL),
      (32, NULL, FALSE, 4, NULL, 'Scanned', NULL), (33, NULL, FALSE, 4, NULL, 'Scanned', NULL),
      (34, NULL, FALSE, 0, NULL, 'Scanned', NULL),
      (40, NULL, FALSE, 1, 4000, 'Scanned', NULL), (41, NULL, FALSE, 1, 4100, 'Scanned', NULL),
      (50, NULL, FALSE, 1, NULL, 'Scanned', NULL), (51, NULL, FALSE, 1, NULL, 'Scanned', NULL),
      (52, NULL, FALSE, 1, NULL, 'Scanned', NULL),
      (60, NULL, FALSE, 1, NULL, 'Scanned', NULL), (61, NULL, FALSE, 1, NULL, 'Scanned', NULL),
      (62, NULL, FALSE, 1, NULL, 'Scanned', NULL),
      (70, NULL, FALSE, 1, NULL, 'Scanned', NULL), (71, NULL, FALSE, 1, NULL, 'Scanned', NULL),
      (80, NULL, FALSE, 1, NULL, 'Pending', NULL), (81, NULL, FALSE, 1, NULL, 'Blocked', 'moderated'),
      (90, NULL, FALSE, 1, NULL, 'Blocked', 'never seen'), (91, NULL, FALSE, 1, NULL, 'Blocked', 'benign'),
      (92, NULL, FALSE, 1, NULL, 'Blocked', 'signal word'), (93, NULL, FALSE, 1, NULL, 'Blocked', 'tos'),
      (100, NULL, FALSE, 1, NULL, 'Scanned', NULL), (101, NULL, FALSE, 1, NULL, 'Scanned', NULL),
      (102, NULL, FALSE, 1, NULL, 'Scanned', NULL),
      (120, NULL, FALSE, 1, NULL, 'Scanned', NULL), (121, 'csam', FALSE, 1, NULL, 'Scanned', NULL),
      (130, NULL, FALSE, 1, NULL, 'Scanned', NULL), (131, NULL, FALSE, 1, NULL, 'Blocked', 'signal word');
    -- Each image its own bytes, so no row is another's url sibling.
    UPDATE "Image" SET url = 'key-' || id;
    -- Except these, each a copy of the row before it.
    UPDATE "Image" SET url = 'key-120' WHERE id = 121;
    UPDATE "Image" SET url = 'key-130' WHERE id = 131;
    -- The report names user 999, not the images' owner (1), so only the listing can hold them.
    INSERT INTO "CsamReport" ("userId", "details", "images") VALUES
      (999, '{}', '[{"id": 100}, {"id": 7}]'), (999, '{}', '[102]');
    UPDATE "Image" SET "acceptableMinor" = TRUE WHERE id = 22;
    INSERT INTO "TagsOnImageDetails" ("imageId", "tagId", "disabled") VALUES
      (30, ${CHILD_TAG}, FALSE), (31, ${CHILD_TAG}, FALSE),
      (32, ${CHILD_TAG}, FALSE), (33, ${CHILD_TAG}, TRUE), (34, ${CHILD_TAG}, FALSE);
    INSERT INTO "BlockedImage" ("hash", "reason") VALUES (4000, 'CSAM'), (4100, 'TOS');
    INSERT INTO "ScanLabelItem" ("id", "imageId", "voidReason") VALUES
      (500, 50, NULL), (510, 51, NULL), (520, 52, NULL), (600, 60, NULL), (610, 61, NULL),
      (620, 62, NULL), (700, 70, 'csam-hold'), (710, 71, 'other');
    INSERT INTO "ScanLabelFlag" ("itemId", "snapshot") VALUES
      (500, '{"csam": true, "minorDetected": false}'),
      (510, '{"csam": false, "minorDetected": false}'),
      (520, '{"csam": null, "minorDetected": true}');
    INSERT INTO "ScanLabelVote" ("itemId", "userId", "reason") VALUES
      (600, 9, 'minor-sexual'), (610, 9, 'real-person'), (620, 9, 'csam-realistic');
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterAll(async () => {
  dbHandle.current = null;
  await db.close();
});

const batchOf = (id: number) => ({
  ids: [id],
  tier: 'general' as const,
  declared: false,
  viewer: 1,
  createdBy: 2,
  keyId: 3,
  seat: null,
  createdAt: 0,
});
const routesHeld = async (id: number) => {
  const media = await getBatchMedia(batchOf(id), 0);
  return media ? routesHeldNow(media.signals) : undefined;
};

describe('review batch routing', () => {
  it.each(CASES)('%s routes held; its twin does not', async (_leg, held, twin) => {
    expect({ id: held, held: await routesHeld(held) }).toEqual({ id: held, held: true });
    expect({ id: twin, held: await routesHeld(twin) }).toEqual({ id: twin, held: false });
  });

  it.each(MINOR_ONLY)('%s stays general', async (_leg, id) => {
    expect({ id, held: await routesHeld(id) }).toEqual({ id, held: false });
  });

  // civitai/civitai#10202: the review batch keeps a held account's media on the held tier, where
  // each serve is a held view.
  it('an image of a held account routes held', async () => {
    await db.exec(`INSERT INTO "Image" (id, "userId", ingestion) VALUES (140, 990100140, 'Scanned');
      INSERT INTO "CsamReport" ("userId", details, images) VALUES (990100140, '{}', '[]')`);
    try {
      expect(await routesHeld(140)).toBe(true);
    } finally {
      await db.exec(
        `DELETE FROM "Image" WHERE id = 140; DELETE FROM "CsamReport" WHERE "userId" = 990100140`
      );
    }
  });

  it("a CSAM label in the scanner's rows routes held", async () => {
    expect(await routesHeld(21)).toBe(false);
    scanner.csamHit.add(imageAuditContentHash(21));
    try {
      expect(await routesHeld(21)).toBe(true);
    } finally {
      scanner.csamHit.clear();
    }
  });

  it('an image that is gone, or an index past the batch, gives nothing to serve', async () => {
    expect(await getBatchMedia(batchOf(999), 0)).toBeNull();
    expect(await getBatchMedia(batchOf(21), 1)).toBeNull();
  });
});

// civitai/civitai#10377 narrowed the moderator view's rule; the review batch keeps
// `csamRestrictedSql`, so the shared cases run against it here with that rule's answers.
describe('review batch routing, by rows sharing its url, its post text and its articles', () => {
  const target = { id: 990900000, url: 'key-990900000' };
  beforeAll(async () => {
    await db.exec(
      `INSERT INTO "Image" (id, url, "userId", ingestion, "blockedFor") VALUES (${target.id}, '${target.url}', 990910000, 'Blocked', 'moderated')`
    );
  });
  afterEach(async () => {
    await db.exec(csamCaseCleanupSql(target));
  });

  it.each(CSAM_RESTRICTION_CASES)('$label', async (c) => {
    await db.exec(c.mark(target));
    const expected = !!c.held || (c.csamRestricted ?? c.restricts);
    expect({ held: await routesHeld(target.id) }).toEqual({ held: expected });
  });
});
