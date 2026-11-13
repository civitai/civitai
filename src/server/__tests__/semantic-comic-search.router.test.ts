import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const h = vi.hoisted(() => ({
  search: vi.fn(async (_args: unknown) => ({ items: [], nextCursor: undefined })),
  cap: undefined as number | undefined,
}));
vi.mock('~/server/services/semantic-comic-search.service', () => ({
  searchSemanticComics: h.search,
}));
vi.mock('~/server/utils/browsing-level', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestDomainBrowsingLevelCap: () => h.cap,
}));

const { createCallerFactory } = await import('~/server/trpc');
const { semanticComicSearchRouter } = await import('~/server/routers/semantic-comic-search.router');

const caller = createCallerFactory(semanticComicSearchRouter)({
  acceptableOrigin: true,
  tokenScope: TokenScope.Full,
  features: { trpcFlagGuardPerRequest: true, semanticComicSearch: true },
  track: { search: vi.fn(async () => undefined) },
  ip: '127.0.0.1',
  cache: {},
  req: { headers: {} },
  res: undefined,
} as never);

beforeEach(() => h.search.mockClear());

describe('semanticComicSearch.search', () => {
  // The service applies the site's cover rule only with the cap it is handed.
  it.each([[1], [undefined]])("hands the service the site's cap (%s)", async (cap) => {
    h.cap = cap;
    await caller.search({ query: 'pirates' });
    expect(h.search).toHaveBeenCalledWith(expect.objectContaining({ browsingLevelCap: cap }));
  });
});
