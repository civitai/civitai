import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';
import { REPORT_ENTITIES } from '../report-entities';

/**
 * Which reported models carry the "Owner flagged minor" badge, on the real SQL.
 *
 * Seeded so every way of getting it wrong marks a model it should not: one flagged by its owner, one
 * flagged and locked by a moderator, one locked on a different property, one not flagged, two carrying
 * an automated flag record without a lock, and an IMAGE whose id equals the owner-flagged model's.
 */

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
vi.mock('../mod-activity', () => ({ recordModActivity: vi.fn() }));
vi.mock('../rewards', () => ({ rewardReportReporters: vi.fn() }));
vi.mock('../redis', () => ({
  getRedis: () => ({ hmGet: async (_key: string, fields: string[]) => fields.map(() => null) }),
}));

const { getOwnerFlaggedMinorModelIds, getMostReported } = await import('../reports.service');

const OWNER_FLAGGED = 10;
const MOD_LOCKED = 11;
const OTHER_LOCK = 12;
const NOT_FLAGGED = 13;
const AUTO_SNAPSHOT = 14;
const TEXT_SCAN = 15;

const SCHEMA = `
CREATE TYPE "ReportStatus" AS ENUM ('Pending', 'Processing', 'Actioned', 'Unactioned');
CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "username" TEXT);
CREATE TABLE "Model" ("id" INTEGER PRIMARY KEY, "minor" BOOLEAN NOT NULL DEFAULT false, "lockedProperties" TEXT[] NOT NULL DEFAULT '{}', "meta" JSONB);
CREATE TABLE "Image" ("id" INTEGER PRIMARY KEY, "blockedFor" TEXT);
CREATE TABLE "Report" ("id" INTEGER PRIMARY KEY, "reason" TEXT NOT NULL DEFAULT 'TOSViolation', "status" "ReportStatus" NOT NULL DEFAULT 'Pending', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(), "userId" INTEGER NOT NULL DEFAULT 1, "details" JSONB, "alsoReportedBy" INTEGER[] NOT NULL DEFAULT '{2}');
CREATE TABLE "Comment" ("id" INTEGER PRIMARY KEY, "modelId" INTEGER, "parentId" INTEGER);
CREATE TABLE "Thread" ("id" INTEGER PRIMARY KEY, "rootThreadId" INTEGER, "commentId" INTEGER, "imageId" INTEGER, "postId" INTEGER, "articleId" INTEGER, "reviewId" INTEGER, "bountyEntryId" INTEGER, "bountyId" INTEGER, "challengeId" INTEGER, "modelId" INTEGER, "comicProjectId" INTEGER, "model3dId" INTEGER);
CREATE TABLE "CommentV2" ("id" INTEGER PRIMARY KEY, "threadId" INTEGER);
CREATE TABLE "BountyEntry" ("id" INTEGER PRIMARY KEY, "bountyId" INTEGER);
CREATE TABLE "Model3DReview" ("id" INTEGER PRIMARY KEY, "model3dId" INTEGER);
CREATE TABLE "Announcement" ("id" INTEGER PRIMARY KEY, "userId" INTEGER);
CREATE TABLE "GameFrameGame" ("id" INTEGER PRIMARY KEY, "url" TEXT);
CREATE TABLE "ServiceOffering" ("id" INTEGER PRIMARY KEY, "sellerId" INTEGER);
${REPORT_ENTITIES.map(
  ({ reportTable, fk }) =>
    `CREATE TABLE "${reportTable}" ("reportId" INTEGER NOT NULL, "${fk}" INTEGER NOT NULL);`
).join('\n')}

INSERT INTO "User" VALUES (1, 'reporter');
INSERT INTO "Model" VALUES
  (${OWNER_FLAGGED}, true, '{}', '{"unrelated": 1}'),
  (${MOD_LOCKED}, true, '{minor,nsfw,sfwOnly}', NULL),
  (${OTHER_LOCK}, true, '{nsfw}', NULL),
  (${NOT_FLAGGED}, false, '{}', NULL),
  (${AUTO_SNAPSHOT}, true, '{}', '{"minorFlagSnapshot": {"source": "auto"}}'),
  (${TEXT_SCAN}, true, '{}', '{"textScanFlags": {"minor": {"workflowId": "w"}}}');
INSERT INTO "Image" VALUES (${OWNER_FLAGGED}, NULL);
INSERT INTO "Report" ("id") VALUES (1), (2), (3), (4), (5), (6);
INSERT INTO "ModelReport" VALUES (1, ${OWNER_FLAGGED}), (2, ${MOD_LOCKED}), (3, ${OTHER_LOCK}), (4, ${NOT_FLAGGED}), (6, ${AUTO_SNAPSHOT});
INSERT INTO "ImageReport" VALUES (5, ${OWNER_FLAGGED});
`;

let pg: PGlite;

beforeEach(async () => {
  pg = await freshPglite();
  await pg.exec(SCHEMA);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(pg) });
});

afterEach(async () => {
  dbHandle.current = null;
  await pg.close();
});

describe('getOwnerFlaggedMinorModelIds', () => {
  it('returns models flagged by their owner, and not those a moderator locked or nobody flagged', async () => {
    const ids = await getOwnerFlaggedMinorModelIds([
      OWNER_FLAGGED,
      MOD_LOCKED,
      OTHER_LOCK,
      NOT_FLAGGED,
    ]);

    expect(ids.sort()).toEqual([OWNER_FLAGGED, OTHER_LOCK]);
  });

  it('does not mark a model flagged by automation, even with no lock', async () => {
    expect(await getOwnerFlaggedMinorModelIds([AUTO_SNAPSHOT, TEXT_SCAN])).toEqual([]);
  });

  it('answers only for the ids it was asked about', async () => {
    expect(await getOwnerFlaggedMinorModelIds([NOT_FLAGGED, MOD_LOCKED])).toEqual([]);
  });

  it('skips the query for an empty page', async () => {
    dbHandle.current = null;
    expect(await getOwnerFlaggedMinorModelIds([])).toEqual([]);
  });
});

describe('getMostReported', () => {
  it('marks the owner-flagged model row only, not an image with the same id', async () => {
    const rows = await getMostReported({ limit: 10 });

    const marked = Object.fromEntries(rows.map((r) => [r.id, r.ownerFlaggedMinor]));
    expect(marked).toEqual({ 1: true, 2: false, 3: true, 4: false, 5: false, 6: false });
    expect(rows.find((r) => r.id === 5)?.entity).toBe('image');
  });
});
