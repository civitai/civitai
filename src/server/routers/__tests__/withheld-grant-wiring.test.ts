import { PGlite } from '@electric-sql/pglite';
import { TRPCError } from '@trpc/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteKysely } from '~/__tests__/pglite-kysely';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import {
  CSAM_LINK_TABLES_SQL,
  WITHHELD_TABLES_SQL,
} from '../../../../packages/civitai-shared/src/__tests__/csam-restriction-cases';

/**
 * The grant reaches a loosening writer from the caller, through the router. Where each entry point
 * may set `csamReview` from is the guard `no-hardcoded-withheld-grant`.
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
    ${WITHHELD_TABLES_SQL}
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
