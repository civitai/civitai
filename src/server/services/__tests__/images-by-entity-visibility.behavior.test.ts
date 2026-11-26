import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

/**
 * Runs `getImagesByEntity`'s real query, which backs the bounty and bounty-entry image reads,
 * against an in-process Postgres: which of an entity's images each viewer is served.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));

import { getImagesByEntity } from '../image.service';

const OWNER = 10;
const viewers = {
  anonymous: {},
  stranger: { userId: 20 },
  owner: { userId: OWNER, ownerSeesHeld: true },
  ownerOnScopedKey: { userId: OWNER },
  moderator: { userId: 30, isModerator: true },
  moderatorWithGrant: { userId: 31, isModerator: true, seesReportListed: true },
};

// One image per bounty entry, so each entry's result is that image or nothing.
const RATED = 101;
const UNRATED = 102;
const UNRATED_PENDING = 103;
const MINOR_R = 104; // minor-flagged, rated R: restricted by the minor content rule
const UNFLAGGED_R = 105;
const HELD_CSAM = 106;
const HELD_MINOR = 107;
const OTHER_REVIEW = 108;
const ACCEPTABLE_MINOR = 9001;
const TOS_VIOLATION = 9002;
// Listed on a report and not blocked, as an image unblocked after its filing is.
const REPORT_LISTED = 9003;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, name text, url text, "nsfwLevel" int DEFAULT 1, width int, height int,
      hash text, "hideMeta" boolean DEFAULT false, meta jsonb, "createdAt" timestamp DEFAULT now(),
      "mimeType" text, type text DEFAULT 'image', metadata jsonb, "scannedAt" timestamp,
      "needsReview" text, "blockedFor" text, "userId" int DEFAULT ${OWNER}, index int DEFAULT 0,
      poi boolean, minor boolean, ingestion "ImageIngestionStatus" DEFAULT 'Scanned',
      "modelRestricted" boolean NOT NULL DEFAULT false,
      "acceptableMinor" boolean NOT NULL DEFAULT false,
      "tosViolation" boolean NOT NULL DEFAULT false
    );
    CREATE TABLE "ImageConnection" ("imageId" int, "entityId" int, "entityType" text);
    CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int, images jsonb);
    INSERT INTO "Image" (id, "nsfwLevel", ingestion) VALUES
      (${RATED}, 1, 'Scanned'), (${UNRATED}, 0, 'Scanned'), (${UNRATED_PENDING}, 0, 'Pending');
    INSERT INTO "Image" (id, "nsfwLevel", minor) VALUES (${MINOR_R}, 4, true), (${UNFLAGGED_R}, 4, false);
    INSERT INTO "Image" (id, "needsReview") VALUES
      (${HELD_CSAM}, 'csam'), (${HELD_MINOR}, 'minor'), (${OTHER_REVIEW}, 'poi');
    INSERT INTO "ImageConnection" VALUES
      (${RATED}, 1, 'BountyEntry'), (${UNRATED}, 2, 'BountyEntry'), (${UNRATED_PENDING}, 3, 'BountyEntry'),
      (${MINOR_R}, 4, 'BountyEntry'), (${UNFLAGGED_R}, 5, 'BountyEntry'),
      (${HELD_CSAM}, 6, 'BountyEntry'), (${HELD_MINOR}, 7, 'BountyEntry'), (${OTHER_REVIEW}, 8, 'BountyEntry'),
      (${ACCEPTABLE_MINOR}, 9, 'BountyEntry'), (${TOS_VIOLATION}, 10, 'BountyEntry');
    INSERT INTO "Image" (id, "acceptableMinor") VALUES (${ACCEPTABLE_MINOR}, true);
    INSERT INTO "Image" (id, "tosViolation") VALUES (${TOS_VIOLATION}, true);
    INSERT INTO "Image" (id) VALUES (${REPORT_LISTED});
    INSERT INTO "ImageConnection" VALUES (${REPORT_LISTED}, 11, 'BountyEntry');
    INSERT INTO "CsamReport" ("userId", images) VALUES (${OWNER}, '[{"id": ${REPORT_LISTED}}]');
  `);
  const raw = pgliteRaw(db);
  (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(raw.queryRaw);
});

async function imageOf(entryId: number, viewer: (typeof viewers)[keyof typeof viewers]) {
  const images = await getImagesByEntity({
    id: entryId,
    type: 'BountyEntry',
    seesReportListed: false,
    ...viewer,
  });
  return images.map((image) => image.id);
}

describe('getImagesByEntity', () => {
  it.each(Object.keys(viewers) as (keyof typeof viewers)[])(
    'serves a rated image to the %s',
    async (who) => {
      expect(await imageOf(1, viewers[who])).toEqual([RATED]);
    }
  );

  it.each(['anonymous', 'stranger'] as const)(
    'withholds an unrated image from the %s',
    async (who) => {
      expect(await imageOf(2, viewers[who])).toEqual([]);
    }
  );

  it.each(['owner', 'moderator'] as const)('serves an unrated image to the %s', async (who) => {
    expect(await imageOf(2, viewers[who])).toEqual([UNRATED]);
  });

  it.each(['anonymous', 'stranger'] as const)(
    'withholds an unscanned image from the %s',
    async (who) => {
      expect(await imageOf(3, viewers[who])).toEqual([]);
    }
  );

  it.each(['anonymous', 'stranger'] as const)(
    'withholds a minor-flagged image rated R from the %s',
    async (who) => {
      expect(await imageOf(4, viewers[who])).toEqual([]);
    }
  );

  it.each(['owner', 'moderator'] as const)(
    'serves the minor-flagged R image to the %s (control)',
    async (who) => {
      expect(await imageOf(4, viewers[who])).toEqual([MINOR_R]);
    }
  );

  it('serves an unflagged R image to a stranger (control)', async () => {
    expect(await imageOf(5, viewers.stranger)).toEqual([UNFLAGGED_R]);
  });

  it.each([
    ['held for csam review', 6],
    ['held for minor review', 7],
  ])('serves the owner their own image %s, and a moderator; nobody else', async (_l, entry) => {
    expect(await imageOf(entry, viewers.owner)).toHaveLength(1);
    expect(await imageOf(entry, viewers.ownerOnScopedKey)).toEqual([]);
    expect(await imageOf(entry, viewers.moderator)).toHaveLength(1);
    expect(await imageOf(entry, viewers.stranger)).toEqual([]);
    expect(await imageOf(entry, viewers.anonymous)).toEqual([]);
  });

  it.each(['anonymous', 'stranger'] as const)(
    'withholds an image marked acceptable-minor from the %s',
    async (who) => {
      expect(await imageOf(9, viewers[who])).toEqual([]);
    }
  );

  it.each(['owner', 'moderator'] as const)(
    'serves an image marked acceptable-minor to the %s',
    async (who) => {
      expect(await imageOf(9, viewers[who])).toEqual([ACCEPTABLE_MINOR]);
    }
  );

  it.each(['anonymous', 'stranger'] as const)(
    'withholds an image removed for a ToS violation from the %s',
    async (who) => {
      expect(await imageOf(10, viewers[who])).toEqual([]);
    }
  );

  it.each(['owner', 'moderator'] as const)(
    'serves an image removed for a ToS violation to the %s',
    async (who) => {
      expect(await imageOf(10, viewers[who])).toEqual([TOS_VIOLATION]);
    }
  );

  it('serves the owner their own image under another review', async () => {
    expect(await imageOf(8, viewers.owner)).toEqual([OTHER_REVIEW]);
  });

  // Report-listed images follow the bounty search index's exclusion (#10483).
  it.each(['anonymous', 'stranger', 'ownerOnScopedKey', 'moderator'] as const)(
    'withholds an image listed on a report from the %s',
    async (who) => {
      expect(await imageOf(11, viewers[who])).toEqual([]);
    }
  );

  it.each(['owner', 'moderatorWithGrant'] as const)(
    'serves an image listed on a report to the %s',
    async (who) => {
      expect(await imageOf(11, viewers[who])).toEqual([REPORT_LISTED]);
    }
  );
});
