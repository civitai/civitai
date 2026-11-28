import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as HotReads6 from '@civitai/db-queries/hot-reads-6';
import type * as LagHelpers from '~/server/db/db-lag-helpers';
import type * as PromotionService from '~/server/services/promotion.service';
import type * as ArticleService from '~/server/services/article.service';
import type * as GenerationService from '~/server/services/generation/generation.service';

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(),
}));
vi.mock('@civitai/db-queries/hot-reads-6', async (importOriginal) => {
  const actual = await importOriginal<typeof HotReads6>();
  return Object.fromEntries(Object.keys(actual).map((name) => [name, vi.fn()]));
});
const { getDbWithoutLag, getKyselyWithoutLag } = vi.hoisted(() => ({
  getDbWithoutLag: vi.fn(),
  getKyselyWithoutLag: vi.fn(),
}));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof LagHelpers>()),
  getDbWithoutLag,
  getKyselyWithoutLag,
}));
const { getArticles, getSponsoredModel, resolveCanGenerateForVersions } = vi.hoisted(() => ({
  getArticles: vi.fn(),
  getSponsoredModel: vi.fn(),
  resolveCanGenerateForVersions: vi.fn(),
}));
vi.mock('~/server/services/article.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ArticleService>()),
  getArticles,
}));
vi.mock('~/server/services/promotion.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PromotionService>()),
  getSponsoredModel,
}));
vi.mock('~/server/services/generation/generation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof GenerationService>()),
  resolveCanGenerateForVersions,
}));

import * as queries from '@civitai/db-queries/hot-reads-6';
import { dbMock, resetSharedMocks } from '~/__tests__/mocks';
import { kyselyRead } from '~/server/db/kyselyDb';
import { isFlipt } from '~/server/flipt/client';

const flag = vi.mocked(isFlipt);
const q = vi.mocked(queries);
const kyselyReads = () => Object.values(q).filter((fn) => vi.isMockFunction(fn));

const ID = 8301;
const PRIMARY_USER = 8503;
const ARTICLE = 8705;

beforeEach(() => {
  resetSharedMocks();
  for (const fn of kyselyReads()) fn.mockReset();
  flag.mockReset().mockResolvedValue(false);
  getDbWithoutLag.mockReset().mockResolvedValue(dbMock.dbRead);
  getKyselyWithoutLag.mockReset().mockResolvedValue(kyselyRead);
  getArticles.mockReset().mockResolvedValue({ items: [] });
  getSponsoredModel.mockReset().mockResolvedValue(undefined);
  resolveCanGenerateForVersions.mockReset().mockResolvedValue({});
});

describe('getPostDetail', () => {
  it('a missing post is not found', async () => {
    const { getPostDetail } = await import('~/server/services/post.service');
    q.getPostDetailRow.mockResolvedValue(undefined as never);
    await expect(getPostDetail({ id: ID })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('findUserIdByUsername', () => {
  it('a replica miss falls back to the primary', async () => {
    const { findUserIdByUsername } = await import('~/server/services/image.service');
    q.getUserIdByUsername.mockResolvedValue(undefined as never);
    dbMock.dbWrite.user.findUnique.mockResolvedValue({ id: PRIMARY_USER });
    await expect(findUserIdByUsername('name')).resolves.toBe(PRIMARY_USER);
  });
});

describe('getAssociatedResourcesCardDataHandler', () => {
  async function cardRead(nsfwLevel: number, browsingLevel = 31) {
    const { getAssociatedResourcesCardDataHandler } = await import(
      '~/server/controllers/model.controller'
    );
    q.listModelAssociationTargets.mockResolvedValue([
      { toModelId: null, toArticleId: ARTICLE },
    ] as never);
    dbMock.dbRead.article.findMany.mockResolvedValue([
      {
        id: ARTICLE,
        userId: PRIMARY_USER,
        nsfwLevel,
        publishedAt: new Date('2026-01-01'),
        status: 'Published',
        ingestion: 'Scanned',
        availability: 'Public',
      },
    ] as never);
    dbMock.dbRead.imageConnection.findMany.mockResolvedValue([]);
    const cache = { edgeTTL: 60, browserTTL: 60, staleWhileRevalidate: 60 };
    await getAssociatedResourcesCardDataHandler({
      input: { fromId: ID, type: 'Suggested', browsingLevel } as never,
      ctx: { user: undefined, features: {}, cache, req: { headers: {} } } as never,
    });
    return { fetched: getArticles.mock.calls[0]?.[0].ids ?? [], edgeCached: cache.edgeTTL > 0 };
  }

  it('fetches an associated article as an article', async () => {
    expect(await cardRead(1)).toEqual({ fetched: [ARTICLE], edgeCached: true });
  });

  it('does not fetch an article above the browsing level', async () => {
    expect((await cardRead(4, 1)).fetched).toEqual([]);
  });

  it('keeps an answer with an article above SFW out of the edge cache', async () => {
    expect(await cardRead(4)).toEqual({ fetched: [ARTICLE], edgeCached: false });
  });
});
