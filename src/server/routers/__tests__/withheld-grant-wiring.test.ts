import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { TRPCError } from '@trpc/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteKysely } from '~/__tests__/pglite-kysely';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { CSAM_LINK_TABLES_SQL } from '../../../../packages/civitai-shared/src/__tests__/csam-restriction-cases';

/**
 * Where a loosening writer's `csamReview` comes from. The services take it as an argument, so the
 * one line in each router, controller or endpoint that derives it from the caller decides whether
 * the withheld rule applies at all: a hard-coded `true` there would leave every service test green.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));
vi.mock('~/server/db/kyselyDb', () => {
  const db = pgliteKysely(() => holder.db);
  return { kyselyRead: db, kyselyWrite: db };
});

const WITHHELD = 101; // queued

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    ${CSAM_LINK_TABLES_SQL}
    CREATE TABLE "Image" (id int PRIMARY KEY, url text NOT NULL, ingestion text, "needsReview" text,
      "blockedFor" text, "userId" int, "pHash" bigint, "postId" int);
    CREATE TABLE "Post" (id int PRIMARY KEY, metadata jsonb, "modelVersionId" int, "userId" int, "publishedAt" timestamp);
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, meta jsonb, "modelId" int);
    CREATE TABLE "Model" (id int PRIMARY KEY, meta jsonb);
    CREATE TABLE "User" (id int PRIMARY KEY, meta jsonb);
    CREATE TABLE "ImageCdnModeratorDelete" ("imageId" int PRIMARY KEY, url text, "userId" int, "csamReview" boolean);
    CREATE TABLE "BlockedImage" (hash bigint, reason text);
    CREATE TABLE "ScanLabelItem" (id int PRIMARY KEY, "imageId" int, "voidReason" text);
    CREATE TABLE "ScanLabelFlag" ("itemId" int, snapshot jsonb);
    CREATE TABLE "ScanLabelVote" ("itemId" int, reason text);
    CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int, details jsonb, images jsonb, "reportSentAt" timestamp);
    CREATE TABLE "TextScanHold" (id SERIAL PRIMARY KEY, "entityType" TEXT NOT NULL, "entityId" INTEGER NOT NULL, label TEXT NOT NULL, status TEXT NOT NULL, "textHash" TEXT, meta JSONB);
    CREATE TABLE "TagsOnImageDetails" ("imageId" int, "tagId" int, disabled boolean NOT NULL DEFAULT false);
    CREATE TABLE "ImageCdnAccess" (url text PRIMARY KEY, state text NOT NULL, "deniedAt" timestamptz NOT NULL DEFAULT now(), "retractedAt" timestamptz DEFAULT now());
    CREATE TABLE "ImageCdnShopTakedown" (url text, "shopItemId" int, "userId" int);
    INSERT INTO "Image" (id, url, ingestion, "needsReview", "userId") VALUES (${WITHHELD}, 'key-a', 'Scanned', 'csam', 7);
  `);
});

beforeEach(() => {
  vi.clearAllMocks();
});

const { createCallerFactory } = await import('~/server/trpc');
const { imageRouter } = await import('~/server/routers/image.router');
const { tagRouter } = await import('~/server/routers/tag.router');
const createCaller = createCallerFactory(imageRouter);
const createTagCaller = createCallerFactory(tagRouter);

const moderatorCtx = (csamReports: boolean) =>
  ({
    user: {
      id: 1,
      isModerator: true,
      onboarding: 1 | 2 | 4 | 8,
      emailVerified: new Date('2026-01-01T00:00:00Z'),
      meta: {},
    },
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    features: { trpcFlagGuardPerRequest: true, csamReports },
    track: {},
    ip: '127.0.0.1',
    cache: {},
    req: { headers: {} },
    res: undefined,
  } as never);
const moderator = (csamReports: boolean) => createCaller(moderatorCtx(csamReports));

describe('image.toggleImageFlag, through the router', () => {
  it("refuses clearing a withheld image's flag for a moderator without the grant", async () => {
    dbMock.dbWrite.image.findUnique.mockResolvedValue({ minor: true } as never);
    await expect(
      moderator(false).toggleImageFlag({ id: WITHHELD, flag: 'minor' })
    ).rejects.toSatisfy((e) => e instanceof TRPCError && e.code === 'FORBIDDEN');
    expect(dbMock.dbWrite.image.update).not.toHaveBeenCalled();
  });

  it('clears it for a moderator with the grant', async () => {
    dbMock.dbWrite.image.findUnique.mockResolvedValue({ minor: true } as never);
    await moderator(true)
      .toggleImageFlag({ id: WITHHELD, flag: 'minor' })
      .catch(() => undefined);
    expect(dbMock.dbWrite.image.update).toHaveBeenCalledTimes(1);
  });
});

describe('tag.addTagVotes, through the router', () => {
  const downvote = (csamReports: boolean) =>
    createTagCaller(moderatorCtx(csamReports)).addTagVotes({
      type: 'image',
      id: WITHHELD,
      tags: [5],
      vote: -1,
    });

  it("refuses a moderator's downvote on a withheld image without the grant, as FORBIDDEN", async () => {
    await expect(downvote(false)).rejects.toSatisfy(
      (e) => e instanceof TRPCError && e.code === 'FORBIDDEN'
    );
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('records it with the grant', async () => {
    await downvote(true).catch(() => undefined);
    expect(dbMock.dbWrite.$executeRaw).toHaveBeenCalledTimes(1);
  });
});

/**
 * Every entry point that passes `csamReview` to a loosening writer, with how many times. Each
 * argument derives the grant from its caller, or is `false` where no grant reaches (a token naming
 * no moderator). A new entry point is added here with how it reads the grant.
 */
const ENTRY_POINTS: Record<string, number> = {
  'src/server/routers/image.router.ts': 2,
  'src/server/routers/games.router.ts': 1,
  'src/server/routers/challenge.router.ts': 2,
  'src/server/routers/article.router.ts': 3,
  'src/server/controllers/image.controller.ts': 3,
  'src/server/controllers/tag.controller.ts': 2,
  'src/server/api-routes/mod/set-image-nsfw-level.ts': 1,
  'src/server/api-routes/mod/image/set-nsfw-level.ts': 1,
  'src/server/api-routes/admin/rescan-images.ts': 1,
};
const FROM_CALLER = [
  '!!ctx.features?.csamReports',
  'ctx.user.isModerator && !!ctx.features?.csamReports',
  '!!getFeatureFlags({ user, req }).csamReports',
  '!!getFeatureFlags({ user: ctx.actor, req: ctx.req }).csamReports',
  'false',
];

describe('the grant each entry point passes', () => {
  const root = path.resolve(__dirname, '../../../..');
  it.each(Object.entries(ENTRY_POINTS))('%s reads it from the caller', (file, count) => {
    const source = readFileSync(path.join(root, file), 'utf8');
    const args = [...source.matchAll(/csamReview: /g)].map((m) =>
      source.slice(m.index + m[0].length)
    );
    expect(args).toHaveLength(count);
    for (const arg of args) expect(FROM_CALLER.some((form) => arg.startsWith(form))).toBe(true);
  });

  it('control: a hard-coded grant does not read as one from the caller', () => {
    expect(FROM_CALLER.some((form) => 'true })'.startsWith(form))).toBe(false);
  });
});
