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
const HELD_OWNER = 11;
const OTHER = 12;

function callerFor(user: { id: number } | undefined) {
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
    features: {},
    track: { action: vi.fn(() => Promise.resolve(true)) },
  } as never);
}

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int NOT NULL, "blockedFor" text, "needsReview" text);
    -- Stand in for the hold-marker view and its kept-image record.
    CREATE TABLE "EvidenceHeldUser" ("userId" int PRIMARY KEY);
    CREATE TABLE "EvidenceHoldImage" ("imageId" int PRIMARY KEY, "userId" int NOT NULL);
    INSERT INTO "Image" VALUES
      (1, ${OWNER}, 'moderated', NULL),     -- ordinary moderator block
      (2, ${OWNER}, 'moderated', NULL),     -- kept by a hold
      (3, ${HELD_OWNER}, 'moderated', NULL),-- owner under a hold marker
      (4, ${OWNER}, 'moderated', 'appeal'), -- already under appeal
      (5, ${OWNER}, 'AiNotVerified', NULL); -- not a moderator block
    INSERT INTO "EvidenceHoldImage" VALUES (2, ${OWNER});
    INSERT INTO "EvidenceHeldUser" VALUES (${HELD_OWNER});
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
    ['an image a hold kept', OWNER, 2],
    ['an image of an owner under a hold marker', HELD_OWNER, 3],
    ['an image already under appeal', OWNER, 4],
    ['an image not blocked by a moderator', OWNER, 5],
    ['another user’s appealable image', OTHER, 1],
    ['an image that does not exist', OWNER, 99],
  ])('refuses %s', async (_, userId, id) => {
    await expect(callerFor({ id: userId }).getAppealState({ id })).resolves.toStrictEqual({
      canAppeal: false,
    });
  });

  it('refuses when the hold tables cannot be read', async () => {
    dbMock.dbWrite.$queryRaw
      .mockImplementationOnce((async () => [
        { blockedFor: 'moderated', needsReview: null },
      ]) as never)
      .mockImplementationOnce((async () => []) as never);
    await expect(callerFor({ id: OWNER }).getAppealState({ id: 1 })).resolves.toStrictEqual({
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
