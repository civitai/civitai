import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * `image.getAppealState` decides whether the owner's page offers an appeal. It must agree with the
 * appeal endpoint's refusal, and answer only for the caller's own image. Its SQL runs on PGlite.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));

import { imageRouter } from '../image.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const OWNER = 10;
const OTHER = 12;
const FILED_ON_OWNER = 13;

function callerFor(user: { id: number } | undefined, features: Record<string, boolean> = {}) {
  return imageRouter.createCaller({
    user: user && {
      ...user,
      tier: 'free',
      username: `u${user.id}`,
      muted: false,
      onboarding: 0xff,
    },
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features,
    track: { action: vi.fn(() => Promise.resolve(true)) },
  } as never);
}

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int NOT NULL, "blockedFor" text, "needsReview" text);
    CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int, images jsonb NOT NULL DEFAULT '[]');
    CREATE TABLE "Report" (id int PRIMARY KEY, reason text NOT NULL);
    CREATE TABLE "UserReport" ("userId" int NOT NULL, "reportId" int NOT NULL);
    INSERT INTO "Image" VALUES
      (1, ${OWNER}, 'moderated', NULL),     -- ordinary moderator block
      (4, ${OWNER}, 'moderated', 'appeal'), -- already under appeal
      (5, ${OWNER}, 'AiNotVerified', NULL), -- not a moderator block
      (6, ${OWNER}, 'moderated', NULL),     -- named in a CSAM report
      (7, ${FILED_ON_OWNER}, 'moderated', NULL); -- owner a CSAM report is filed on
    INSERT INTO "CsamReport" (images) VALUES ('[{"id": 6}]');
    INSERT INTO "CsamReport" ("userId") VALUES (${FILED_ON_OWNER});
  `);
});

beforeEach(() => {
  dbMock.dbWrite.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const flat = Prisma.sql(strings, ...(values as never[]));
    const { rows } = await holder.db.query(flat.text, flat.values as unknown[]);
    return rows;
  }) as never);
});

describe('image.getAppealState', () => {
  it('offers the appeal on the owner’s ordinary moderator block, and returns nothing else', async () => {
    await expect(callerFor({ id: OWNER }).getAppealState({ id: 1 })).resolves.toStrictEqual({
      canAppeal: true,
    });
  });

  it.each([
    ['an image a CSAM report names', OWNER, 6],
    ['an image of an owner a CSAM report is filed on', FILED_ON_OWNER, 7],
    ['an image already under appeal', OWNER, 4],
    ['an image not blocked by a moderator', OWNER, 5],
    ['another user’s appealable image', OTHER, 1],
    ['an image that does not exist', OWNER, 99],
  ])('refuses %s', async (_, userId, id) => {
    await expect(callerFor({ id: userId }).getAppealState({ id })).resolves.toStrictEqual({
      canAppeal: false,
    });
  });

  it('fails rather than answering when the check throws', async () => {
    dbMock.dbWrite.$queryRaw.mockRejectedValueOnce(new Error('db down'));
    await expect(callerFor({ id: OWNER }).getAppealState({ id: 1 })).rejects.toThrow();
  });

  it('is refused when signed out', async () => {
    await expect(callerFor(undefined).getAppealState({ id: 1 })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});

describe('image.rescan', () => {
  const db2 = { db: null as unknown as PGlite };
  const sent: number[] = [];

  beforeAll(async () => {
    db2.db = new PGlite();
    await db2.db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
    CREATE TABLE "User" (id int PRIMARY KEY, "bannedAt" timestamp(3), "deletedAt" timestamp(3));
    CREATE TABLE "ModActivity" (id serial PRIMARY KEY, "entityType" text, "entityId" int, activity text, "createdAt" timestamp(3) DEFAULT now());
    CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int NOT NULL, ingestion "ImageIngestionStatus", "blockedFor" text,
      "nsfwLevel" int NOT NULL DEFAULT 0, "nsfwLevelLocked" boolean NOT NULL DEFAULT false, "needsReview" text,
      minor boolean NOT NULL DEFAULT false, metadata jsonb, "scanJobs" jsonb, url text, type text NOT NULL DEFAULT 'image',
      width int, height int, meta jsonb, "scanRequestedAt" timestamp(3));
    CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int, details jsonb NOT NULL DEFAULT '{}',
      images jsonb NOT NULL DEFAULT '[]', "reportSentAt" timestamp(3), "archivedAt" timestamp(3));
    CREATE TABLE "TagsOnImageDetails" ("imageId" int, "tagId" int, disabled boolean NOT NULL DEFAULT false);
    INSERT INTO "User" (id) VALUES (20), (22);`);
  });

  beforeEach(async () => {
    await db2.db.exec(`
    TRUNCATE "Image";
    INSERT INTO "Image" (id, "userId", ingestion, "blockedFor", "nsfwLevel", minor, url) VALUES
      (101, 20, 'Blocked', 'moderated', 32, false, 'https://example.invalid/101.jpeg'),
      (102, 20, 'Blocked', 'moderated', 32, true, 'https://example.invalid/102.jpeg'),
      (103, 22, 'Blocked', 'CSAM', 32, false, 'https://example.invalid/103.jpeg');`);
    sent.length = 0;
    const run = async (strings: TemplateStringsArray, values: unknown[]) => {
      const flat = Prisma.sql(strings, ...(values as never[]));
      const at = /WHERE id = \$(\d+)/.exec(flat.text);
      // The refused submit's own write: recorded, not applied.
      if (flat.text.includes('"scanRequestedAt" =') && at) {
        sent.push(flat.values[Number(at[1]) - 1] as number);
        return { rows: [], affectedRows: 1 };
      }
      return db2.db.query(flat.text, flat.values as unknown[]);
    };
    dbMock.dbWrite.$queryRaw.mockImplementation(
      (async (strings: TemplateStringsArray, ...values: unknown[]) =>
        (await run(strings, values)).rows) as never
    );
    dbMock.dbWrite.$executeRaw.mockImplementation(
      (async (strings: TemplateStringsArray, ...values: unknown[]) =>
        (await run(strings, values)).affectedRows ?? 0) as never
    );
  });

  const ingestion = async (id: number) =>
    (
      await db2.db.query<{ ingestion: string; blockedFor: string | null }>(
        'SELECT ingestion, "blockedFor" FROM "Image" WHERE id = $1',
        [id]
      )
    ).rows[0];
  // Holds the withheld-media grant, so these cases test the rescan itself, not the withheld gate.
  const moderator = () =>
    callerFor({ id: 1, isModerator: true } as { id: number }, { csamReports: true });

  it('case 1', async () => {
    await moderator().rescan({ id: 101 });
    expect(await ingestion(101)).toEqual({ ingestion: 'Rescan', blockedFor: 'moderated' });
    expect(sent).toEqual([101]);
  });

  it.each([
    ['1', 102],
    ['2', 103],
  ])('case 2.%s', async (_label, id) => {
    await moderator().rescan({ id });
    expect((await ingestion(id)).ingestion).toBe('Blocked');
    expect(sent).toEqual([id]);
  });

  it('case 3', async () => {
    await expect(callerFor({ id: 20 }).rescan({ id: 101 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect((await ingestion(101)).ingestion).toBe('Blocked');
  });
});
