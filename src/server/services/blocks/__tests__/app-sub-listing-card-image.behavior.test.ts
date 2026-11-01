import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetSharedMocks } from '~/__tests__/mocks';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { OnboardingSteps } from '~/server/common/enums';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as AppListingService from '~/server/services/blocks/app-listing.service';
import type * as SharedContentSafety from '~/server/services/apps/shared-content-safety';
import type * as RateLimit from '~/server/utils/shared-storage-rate-limit';

/**
 * A store item's image, decided by the real SQL on real rows: `image.get`'s anonymous visibility
 * conditions and the card's published-post rule, through the catalog PUT.
 *
 * `getImage` also serves a postless image to anyone when it is the cover of a published article
 * or on a public bounty or bounty entry, but the store card only shows an image that is in a
 * published, non-private post. Each such image must be refused at publish rather than accepted
 * and then silently replaced by the parent's cover.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { mockTextSafe, mockSyncRate } = vi.hoisted(() => ({
  mockTextSafe: vi.fn(),
  mockSyncRate: vi.fn(),
}));

vi.mock('~/server/services/blocks/app-listing.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppListingService>()),
  bustAppListingCatalogCache: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/apps/shared-content-safety', async (importOriginal) => ({
  ...(await importOriginal<typeof SharedContentSafety>()),
  assertSharedTextSafe: mockTextSafe,
}));
vi.mock('~/server/utils/shared-storage-rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof RateLimit>()),
  checkSubListingSyncRateLimit: mockSyncRate,
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: {
    getSessionUserById: async (id: number) => ({
      id,
      isModerator: false,
      bannedAt: null,
      muted: false,
      onboarding: OnboardingSteps.Buzz,
      emailVerified: new Date('2020-01-01'),
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    }),
  },
}));
// `getImage` minus its cosmetics and metrics: the same visibility WHERE, on the same rows.
vi.mock('~/server/services/image.service', async () => {
  const { assertImageVisibleToViewer } = await import('~/server/services/image-visibility.service');
  return {
    getImage: async ({ id, isModerator }: { id: number; isModerator?: boolean }) => {
      const image = await assertImageVisibleToViewer({ id, isModerator });
      return { id, user: { id: image.userId } };
    },
  };
});

const { SubListingError, upsertCatalogSubListing } = await import(
  '~/server/services/blocks/app-sub-listing.service'
);

const OWNER = 12;
const PARENT = 'apl_GAMES';
const CLIENT = 'client-games';
const BODY = { title: 'Neon Drift', tagline: 'Arcade racer' };

/** Images 1–6, all the listing owner's, scanned and reviewed. */
const IN_PUBLIC_POST = 1;
const ARTICLE_COVER = 2;
const ON_BOUNTY = 3;
const ON_BOUNTY_ENTRY = 4;
const IN_PRIVATE_POST = 5;
const IN_SCHEDULED_POST = 6;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
    CREATE TYPE "CollectionContributorPermission" AS ENUM ('VIEW', 'ADD', 'ADD_REVIEW', 'MANAGE');
    CREATE TABLE "Image" (
      minor boolean DEFAULT false,
      id int PRIMARY KEY, "userId" int NOT NULL, "postId" int, "nsfwLevel" int DEFAULT 1,
      "needsReview" text, ingestion "ImageIngestionStatus" DEFAULT 'Scanned',
      "nsfwLevelLocked" boolean DEFAULT false, metadata jsonb NOT NULL DEFAULT '{}',
      "scanJobs" jsonb
    );
    CREATE TABLE "Post" (
      id int PRIMARY KEY, "userId" int NOT NULL, "publishedAt" timestamp,
      availability "Availability" DEFAULT 'Public', "collectionId" int
    );
    CREATE TABLE "Article" (
      id int PRIMARY KEY, "coverId" int, status text, "publishedAt" timestamp, ingestion text
    );
    CREATE TABLE "CollectionContributor" (
      "collectionId" int, "userId" int, permissions "CollectionContributorPermission"[]
    );
    CREATE TABLE "Bounty" (
      id int PRIMARY KEY, "userId" int, availability "Availability" DEFAULT 'Public'
    );
    CREATE TABLE "BountyEntry" (id int PRIMARY KEY, "bountyId" int NOT NULL, "userId" int);
    CREATE TABLE "ImageConnection" ("imageId" int, "entityId" int, "entityType" text);

    INSERT INTO "Post" (id, "userId", "publishedAt", availability) VALUES
      (1, ${OWNER}, now() - interval '1 day', 'Public'),
      (5, ${OWNER}, now() - interval '1 day', 'Private'),
      (6, ${OWNER}, now() + interval '1 day', 'Public');
    INSERT INTO "Image" (id, "userId", "postId") VALUES
      (${IN_PUBLIC_POST}, ${OWNER}, 1),
      (${ARTICLE_COVER}, ${OWNER}, NULL),
      (${ON_BOUNTY}, ${OWNER}, NULL),
      (${ON_BOUNTY_ENTRY}, ${OWNER}, NULL),
      (${IN_PRIVATE_POST}, ${OWNER}, 5),
      (${IN_SCHEDULED_POST}, ${OWNER}, 6);
    INSERT INTO "Article" (id, "coverId", status, "publishedAt", ingestion) VALUES
      (1, ${ARTICLE_COVER}, 'Published', now() - interval '1 day', 'Scanned');
    INSERT INTO "Bounty" (id, "userId") VALUES (1, ${OWNER});
    INSERT INTO "BountyEntry" (id, "bountyId", "userId") VALUES (1, 1, ${OWNER});
    INSERT INTO "ImageConnection" ("imageId", "entityId", "entityType") VALUES
      (${ON_BOUNTY}, 1, 'Bounty'), (${ON_BOUNTY_ENTRY}, 1, 'BountyEntry');
  `);
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  resetSharedMocks();
  const raw = pgliteRaw(db);
  // Tagged-template calls (`assertImageVisibleToViewer`) and prebuilt `Prisma.sql` arguments.
  dbMock.dbRead.$queryRaw.mockImplementation(
    async (first: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) =>
      Array.isArray(first)
        ? raw.queryRaw(first as TemplateStringsArray, ...values)
        : (await db.query((first as Prisma.Sql).text, (first as Prisma.Sql).values)).rows
  );
  dbMock.dbRead.appListing.findFirst.mockResolvedValue({
    id: PARENT,
    userId: OWNER,
    contentRating: 'pg',
    subListingParent: { maxPerAuthor: 20, linkTemplate: 'https://games.example.com/?game={id}' },
  });
  dbMock.dbRead.account.count.mockResolvedValue(0);
  dbMock.dbWrite.oauthConsent.findUnique.mockResolvedValue(null);
  dbMock.dbWrite.appSubListing.findUnique.mockResolvedValue(null);
  dbMock.dbWrite.appSubListing.count.mockResolvedValue(0);
  dbMock.dbWrite.appSubListing.create.mockImplementation(
    async ({ data }: { data: { id: string; status: string } }) => ({
      id: data.id,
      status: data.status,
    })
  );
  mockTextSafe
    .mockReset()
    .mockImplementation(async ({ title, body }: { title: string; body?: string }) => ({
      title,
      body,
    }));
  mockSyncRate.mockReset().mockResolvedValue({ allowed: true });
});

const put = (imageId: number) =>
  upsertCatalogSubListing({
    parentListingId: PARENT,
    clientId: CLIENT,
    externalId: 'neon-drift',
    body: { ...BODY, imageId },
  });

async function publishError(imageId: number) {
  return put(imageId).then(
    () => null,
    (e: unknown) => e
  );
}

/** `image.get`'s anonymous verdict on the same rows, independent of the publish path. */
async function servedAnonymously(imageId: number) {
  const { assertImageVisibleToViewer } = await import('~/server/services/image-visibility.service');
  return assertImageVisibleToViewer({ id: imageId, isModerator: false }).then(
    () => true,
    () => false
  );
}

describe('a store item image, executed against the real visibility SQL', () => {
  it('accepts an image in a published, public post', async () => {
    await expect(put(IN_PUBLIC_POST)).resolves.toMatchObject({ status: 'pending' });
    expect(dbMock.dbWrite.appSubListing.create.mock.calls[0][0].data.imageId).toBe(IN_PUBLIC_POST);
  });

  it.each([
    ['the cover of a published article', ARTICLE_COVER],
    ['on a public bounty', ON_BOUNTY],
    ['on an entry of a public bounty', ON_BOUNTY_ENTRY],
  ])(
    'refuses a postless image %s, which image.get serves but the card would not show',
    async (_name, imageId) => {
      // Reachability: the anonymous read admits this image, so the refusal below is the post rule.
      expect(await servedAnonymously(imageId)).toBe(true);
      const err = await publishError(imageId);
      expect(err).toBeInstanceOf(SubListingError);
      expect(err).toMatchObject({ status: 400, code: 'image_not_public' });
      expect(dbMock.dbWrite.appSubListing.create).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['private', IN_PRIVATE_POST],
    ['scheduled', IN_SCHEDULED_POST],
  ])('refuses an image in a %s post', async (_name, imageId) => {
    expect(await publishError(imageId)).toMatchObject({ status: 400, code: 'image_not_public' });
    expect(dbMock.dbWrite.appSubListing.create).not.toHaveBeenCalled();
  });
});
