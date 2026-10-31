import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as ImageService from '~/server/services/image.service';
import type * as UserService from '~/server/services/user.service';

/**
 * `orchestrator.mintPromptProvenance` refuses every image `image.get` refuses for the viewer,
 * decided by the real visibility SQL on real rows. It no longer goes through `getImage`, so each
 * refusal here is pinned against the check that replaced it.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: vi.fn(async () => {
    throw new Error('the prompt mint must not fetch an orchestrator token');
  }),
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getImage: vi.fn(async () => {
    throw new Error('the prompt mint must not load the full image');
  }),
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  amIBlockedByUser: vi.fn(),
}));

import { orchestratorRouter } from '~/server/routers/orchestrator.router';
import { OnboardingSteps } from '~/server/common/enums';
import { verifyProvenance } from '~/server/services/orchestrator/remix-provenance';
import { amIBlockedByUser } from '~/server/services/user.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const OWNER = 10;
const VIEWER = 20;

const caller = (userId = VIEWER) =>
  orchestratorRouter.createCaller({
    user: {
      id: userId,
      onboarding: OnboardingSteps.Buzz,
      emailVerified: new Date('2020-01-01'),
      muted: false,
      bannedAt: null,
      showNsfw: true,
    },
    domain: 'red',
    ip: '1.2.3.4',
    features: {},
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
  } as never);

const mint = (userId = VIEWER, imageId = 1) =>
  caller(userId)
    .mintPromptProvenance({ imageId })
    .then(
      (result) => ({ ok: true as const, token: result.provenance }),
      (error: { code?: string }) => ({ ok: false as const, code: error.code })
    );

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
  `);
  const raw = pgliteRaw(db);
  (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (first: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) =>
      Array.isArray(first)
        ? raw.queryRaw(first as TemplateStringsArray, ...values)
        : (await db.query((first as Prisma.Sql).text, (first as Prisma.Sql).values)).rows
  );
});

beforeEach(async () => {
  await db.exec(
    `TRUNCATE "Image", "Post", "CollectionContributor", "Article", "Bounty", "BountyEntry", "ImageConnection";`
  );
  vi.mocked(amIBlockedByUser).mockReset().mockResolvedValue(false);
});

/** Image 1, owned by OWNER, in OWNER's post 1 (published a day ago) unless `post` is null. */
async function seed({
  image = {},
  post = {},
}: {
  image?: Record<string, string>;
  post?: Record<string, string> | null;
} = {}) {
  const imageCols = {
    id: '1',
    '"userId"': String(OWNER),
    '"postId"': post ? '1' : 'NULL',
    ...image,
  };
  await db.exec(
    `INSERT INTO "Image" (${Object.keys(imageCols).join(', ')}) VALUES (${Object.values(
      imageCols
    ).join(', ')})`
  );
  if (!post) return;
  const postCols = {
    id: '1',
    '"userId"': String(OWNER),
    '"publishedAt"': `now() - interval '1 day'`,
    ...post,
  };
  await db.exec(
    `INSERT INTO "Post" (${Object.keys(postCols).join(', ')}) VALUES (${Object.values(
      postCols
    ).join(', ')})`
  );
}

describe('orchestrator.mintPromptProvenance', () => {
  it('mints a prompt token for a published image the viewer can open', async () => {
    await seed();

    const result = await mint();

    expect(result.ok).toBe(true);
    if (result.ok) expect(verifyProvenance(result.token, VIEWER, 'prompt')).toEqual([1]);
  });

  it('mints for the owner of an image that is not published yet', async () => {
    await seed({ post: { '"publishedAt"': 'NULL' } });

    expect((await mint(OWNER)).ok).toBe(true);
  });

  const refusals: [string, Parameters<typeof seed>[0]][] = [
    ['an image awaiting review', { image: { '"needsReview"': `'minor'` } }],
    ['an image not yet scanned', { image: { ingestion: `'Pending'` } }],
    ['an image in a post not yet published', { post: { '"publishedAt"': 'NULL' } }],
    [
      'an image in a post scheduled for later',
      { post: { '"publishedAt"': `now() + interval '1 day'` } },
    ],
    ['an image in a private post', { post: { availability: `'Private'` } }],
    ['someone else’s image that is in no post', { post: null }],
    ['an image rated Blocked', { image: { '"nsfwLevel"': '32' } }],
  ];
  for (const [what, rows] of refusals)
    it(`refuses ${what}`, async () => {
      await seed(rows);

      expect(await mint()).toEqual({ ok: false, code: 'NOT_FOUND' });
    });

  it('refuses an image whose owner has blocked the viewer', async () => {
    await seed();
    vi.mocked(amIBlockedByUser).mockResolvedValue(true);

    expect(await mint()).toEqual({ ok: false, code: 'NOT_FOUND' });
    // The mint is a write, so the block check confirms a cache "not blocked" on the primary.
    expect(amIBlockedByUser).toHaveBeenCalledWith({
      userId: VIEWER,
      targetUserId: OWNER,
      confirmOnPrimary: true,
    });
  });

  it('refuses an image that does not exist', async () => {
    expect(await mint(VIEWER, 999)).toEqual({ ok: false, code: 'NOT_FOUND' });
  });
});
