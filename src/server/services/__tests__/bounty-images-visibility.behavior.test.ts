import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

/**
 * Which of a bounty's own images each viewer is served by `getBountyImages` (bounty page) and
 * `getImagesForBounties` (bounty list). Raw SQL runs on an in-process Postgres; the Prisma
 * `imageConnection.findMany` is answered by evaluating its `where` over the same rows, and throws
 * on any filter it cannot evaluate rather than ignoring it.
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

import { getBountyImages, getImagesForBounties } from '../bounty.service';

const OWNER = 10;
const OTHER_UPLOADER = 40;
const viewers = {
  anonymous: {},
  stranger: { userId: 20 },
  owner: { userId: OWNER, ownerSeesReportListed: true },
  moderator: { userId: 30, isModerator: true },
  grantHolder: { userId: 31, isModerator: true, seesReportListed: true },
};
type Viewer = (typeof viewers)[keyof typeof viewers];

type ImageRow = {
  id: number;
  userId: number;
  nsfwLevel: number;
  ingestion: string;
  needsReview: string | null;
  blockedFor: string | null;
  minor: boolean;
  modelRestricted: boolean;
  meta: Record<string, unknown> | null;
  hideMeta: boolean;
  acceptableMinor: boolean;
  tosViolation: boolean;
};
const image = (id: number, over: Partial<ImageRow> = {}): ImageRow => ({
  id,
  userId: OWNER,
  nsfwLevel: 1,
  ingestion: 'Scanned',
  needsReview: null,
  blockedFor: null,
  minor: false,
  modelRestricted: false,
  meta: { prompt: 'p' },
  hideMeta: false,
  acceptableMinor: false,
  tosViolation: false,
  ...over,
});

// One image per bounty (bounty id = image id), so each bounty's result is that image or nothing,
// except TWO_IMAGES, which holds two clean images.
const CLEAN = 1;
const BLOCKED_FOR = 2;
const UNRATED = 3;
const MINOR_R = 4; // minor-flagged, rated R: restricted by the minor content rule
const HELD = 5;
const UNSCANNED = 6;
const OTHERS_HELD = 7;
const RESTRICTED_R = 8; // rated R, made with a base model that restricts mature images
const HIDDEN_META = 9; // its uploader hid its generation data
const ACCEPTABLE_MINOR = 10;
const TOS_VIOLATION = 11;
const REPORT_LISTED = 12; // listed on a CsamReport, otherwise clean
const TWO_IMAGES = 20;
const FIRST_OF_TWO = 21;
const SECOND_OF_TWO = 22;
const images: ImageRow[] = [
  image(CLEAN),
  image(BLOCKED_FOR, { blockedFor: 'tos' }),
  image(UNRATED, { nsfwLevel: 0 }),
  image(MINOR_R, { nsfwLevel: 4, minor: true }),
  image(HELD, { needsReview: 'poi' }),
  image(UNSCANNED, { ingestion: 'Pending' }),
  image(OTHERS_HELD, { userId: OTHER_UPLOADER, needsReview: 'minor' }),
  image(RESTRICTED_R, { nsfwLevel: 4, modelRestricted: true }),
  image(HIDDEN_META, { hideMeta: true }),
  image(ACCEPTABLE_MINOR, { acceptableMinor: true }),
  image(TOS_VIOLATION, { tosViolation: true }),
  image(REPORT_LISTED),
  image(FIRST_OF_TWO),
  image(SECOND_OF_TWO),
];
const connections = images.map((i) => ({
  imageId: i.id,
  entityId: i.id > TWO_IMAGES ? TWO_IMAGES : i.id,
  entityType: 'Bounty',
  image: { ...i, tags: [] as never[] },
}));

// A Prisma `where`, evaluated over a plain row. Unknown operators throw.
function matches(where: Record<string, unknown>, row: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (cond === undefined) return true;
    if (key === 'AND') return ([] as unknown[]).concat(cond).every((w) => matches(w as never, row));
    if (key === 'OR') return (cond as unknown[]).some((w) => matches(w as never, row));
    if (key === 'NOT') return !([] as unknown[]).concat(cond).some((w) => matches(w as never, row));
    const value = row[key];
    if (cond === null || typeof cond !== 'object') return value === cond;
    if (value !== null && typeof value === 'object' && !Array.isArray(value))
      return matches(cond as never, value as never);
    return Object.entries(cond as Record<string, unknown>).every(([op, arg]) => {
      if (op === 'in') return (arg as unknown[]).includes(value);
      if (op === 'notIn') return !(arg as unknown[]).includes(value);
      if (op === 'equals') return value === arg;
      if (op === 'not') return value !== arg;
      throw new Error(`unsupported Prisma filter ${key}.${op}`);
    });
  });
}

beforeAll(async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int, "nsfwLevel" int, ingestion "ImageIngestionStatus",
      "needsReview" text, "blockedFor" text, minor boolean, "modelRestricted" boolean NOT NULL,
      "acceptableMinor" boolean NOT NULL, "tosViolation" boolean NOT NULL
    );
    CREATE TABLE "ImageConnection" ("imageId" int, "entityId" int, "entityType" text);
    CREATE TABLE "CsamReport" (id serial PRIMARY KEY, images jsonb NOT NULL DEFAULT '[]');
    INSERT INTO "CsamReport" (images) VALUES ('[{"id": ${REPORT_LISTED}}]'), ('[]');
  `);
  for (const i of images) {
    await db.query('INSERT INTO "Image" VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)', [
      i.id,
      i.userId,
      i.nsfwLevel,
      i.ingestion,
      i.needsReview,
      i.blockedFor,
      i.minor,
      i.modelRestricted,
      i.acceptableMinor,
      i.tosViolation,
    ]);
  }
  for (const c of connections) {
    await db.query('INSERT INTO "ImageConnection" VALUES ($1, $2, $3)', [
      c.imageId,
      c.entityId,
      c.entityType,
    ]);
  }
  const raw = pgliteRaw(db);
  (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(raw.queryRaw);
  (
    dbMock.dbRead.imageConnection.findMany as unknown as ReturnType<typeof vi.fn>
  ).mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
    connections.filter((c) => matches(where, c as never))
  );
});

const readers = {
  getBountyImages: async (bountyId: number, viewer: Viewer) =>
    (await getBountyImages({ id: bountyId, ...viewer })).map((i) => i.id),
  getImagesForBounties: async (bountyId: number, viewer: Viewer) =>
    ((await getImagesForBounties({ bountyIds: [bountyId], ...viewer }))[bountyId] ?? []).map(
      (i) => i.id
    ),
};

describe.each(Object.keys(readers) as (keyof typeof readers)[])('%s', (reader) => {
  const imagesOf = readers[reader];

  it.each(Object.keys(viewers) as (keyof typeof viewers)[])(
    'serves a clean rated image to the %s (control)',
    async (who) => {
      expect(await imagesOf(CLEAN, viewers[who])).toEqual([CLEAN]);
    }
  );

  describe.each([
    ['an image with a block reason', BLOCKED_FOR],
    ['an unrated image', UNRATED],
    ['a minor-flagged image rated R', MINOR_R],
    ['an image held for review', HELD],
    ['an unscanned image', UNSCANNED],
    ['an image marked acceptable-minor', ACCEPTABLE_MINOR],
    ['an image removed for a ToS violation', TOS_VIOLATION],
  ] as const)('%s', (_label, id) => {
    it.each(['anonymous', 'stranger'] as const)('is withheld from the %s', async (who) => {
      expect(await imagesOf(id, viewers[who])).toEqual([]);
    });
    it.each(['owner', 'moderator'] as const)('is served to the %s', async (who) => {
      expect(await imagesOf(id, viewers[who])).toEqual([id]);
    });
  });

  it.each(['anonymous', 'stranger', 'owner'] as const)(
    "withholds another uploader's held image from the %s",
    async (who) => {
      expect(await imagesOf(OTHERS_HELD, viewers[who])).toEqual([]);
    }
  );

  it("serves another uploader's held image to a moderator", async () => {
    expect(await imagesOf(OTHERS_HELD, viewers.moderator)).toEqual([OTHERS_HELD]);
  });

  it.each(['anonymous', 'stranger', 'moderator'] as const)(
    'withholds a base-model restricted mature image from the %s',
    async (who) => {
      expect(await imagesOf(RESTRICTED_R, viewers[who])).toEqual([]);
    }
  );

  // The bounty search index's exclusion; staff visibility follows the held-media grant.
  it.each(['anonymous', 'stranger', 'moderator'] as const)(
    'withholds an image listed on a report from the %s',
    async (who) => {
      expect(await imagesOf(REPORT_LISTED, viewers[who])).toEqual([]);
    }
  );

  it('withholds an image listed on a report from its uploader on a scoped credential', async () => {
    expect(await imagesOf(REPORT_LISTED, { userId: OWNER })).toEqual([]);
  });

  it.each(['owner', 'grantHolder'] as const)(
    'serves an image listed on a report to the %s',
    async (who) => {
      expect(await imagesOf(REPORT_LISTED, viewers[who])).toEqual([REPORT_LISTED]);
    }
  );

  it('serves a base-model restricted mature image to its owner', async () => {
    expect(await imagesOf(RESTRICTED_R, viewers.owner)).toEqual([RESTRICTED_R]);
  });

  it('serves every visible image of a bounty', async () => {
    expect((await imagesOf(TWO_IMAGES, viewers.stranger)).sort()).toEqual([
      FIRST_OF_TWO,
      SECOND_OF_TWO,
    ]);
  });
});

describe('getImagesForBounties over several bounties', () => {
  it("groups each bounty's visible images under its id", async () => {
    const grouped = await getImagesForBounties({
      bountyIds: [CLEAN, BLOCKED_FOR, HELD, TWO_IMAGES],
      ...viewers.stranger,
    });
    const ids = Object.fromEntries(
      Object.entries(grouped).map(([bountyId, list]) => [bountyId, list.map((i) => i.id).sort()])
    );
    expect(ids).toEqual({ [CLEAN]: [CLEAN], [TWO_IMAGES]: [FIRST_OF_TWO, SECOND_OF_TWO] });
  });
});

const metaReaders = {
  getBountyImages: async (bountyId: number, viewer: Viewer) =>
    (await getBountyImages({ id: bountyId, ...viewer }))[0]?.meta,
  getImagesForBounties: async (bountyId: number, viewer: Viewer) =>
    (await getImagesForBounties({ bountyIds: [bountyId], ...viewer }))[bountyId]?.[0]?.meta,
};

describe.each(Object.keys(metaReaders) as (keyof typeof metaReaders)[])(
  '%s generation data',
  (reader) => {
    const metaOf = metaReaders[reader];

    it.each(Object.keys(viewers) as (keyof typeof viewers)[])(
      'sends shown generation data to the %s (control)',
      async (who) => {
        expect(await metaOf(CLEAN, viewers[who])).toEqual({ prompt: 'p' });
      }
    );

    it.each(['anonymous', 'stranger'] as const)(
      'withholds hidden generation data from the %s',
      async (who) => {
        expect(await metaOf(HIDDEN_META, viewers[who])).toBeNull();
      }
    );

    it.each(['owner', 'moderator'] as const)(
      'sends hidden generation data to the %s',
      async (who) => {
        expect(await metaOf(HIDDEN_META, viewers[who])).toEqual({ prompt: 'p' });
      }
    );
  }
);
