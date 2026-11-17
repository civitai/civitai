import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const h = vi.hoisted(() => ({
  search: vi.fn(async (_args: unknown) => ({ items: [], nextCursor: undefined })),
  cap: undefined as number | undefined,
}));
vi.mock('~/server/services/semantic-crucible-search.service', () => ({
  searchSemanticCrucibles: h.search,
}));
vi.mock('~/server/utils/browsing-level', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestDomainBrowsingLevelCap: () => h.cap,
}));

const { createCallerFactory } = await import('~/server/trpc');
const { semanticCrucibleSearchRouter } = await import(
  '~/server/routers/semantic-crucible-search.router'
);

const callerWith = (features: Record<string, boolean>, tokenScope: bigint = TokenScope.Full) =>
  createCallerFactory(semanticCrucibleSearchRouter)({
    acceptableOrigin: true,
    tokenScope,
    features: { trpcFlagGuardPerRequest: true, crucible: true, ...features },
    track: { search: vi.fn(async () => undefined) },
    ip: '127.0.0.1',
    cache: {},
    req: { headers: {} },
    res: undefined,
  } as never);

beforeEach(() => h.search.mockClear());

describe('semanticCrucibleSearch.search', () => {
  const caller = callerWith({ semanticCrucibleSearch: true, isGreen: true });

  it.each([[1], [undefined]])("hands the service the site's cap (%s)", async (cap) => {
    h.cap = cap;
    await caller.search({ query: 'neon' });
    expect(h.search).toHaveBeenCalledTimes(1);
    expect(h.search).toHaveBeenCalledWith(expect.objectContaining({ browsingLevelCap: cap }));
  });

  it('tells the service which site it is on', async () => {
    await caller.search({ query: 'neon' });
    expect(h.search).toHaveBeenCalledTimes(1);
    expect(h.search).toHaveBeenCalledWith(expect.objectContaining({ isGreen: true }));
  });

  it('is closed while its flag is off', async () => {
    await expect(
      callerWith({ semanticCrucibleSearch: false }).search({ query: 'neon' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(h.search).not.toHaveBeenCalled();
  });

  it('answers an API key that holds only the media-read scope', async () => {
    await callerWith({ semanticCrucibleSearch: true }, TokenScope.MediaRead).search({
      query: 'neon',
    });
    expect(h.search).toHaveBeenCalledTimes(1);
  });

  it('is closed while crucibles are off, whatever the search flag says', async () => {
    await expect(
      callerWith({ crucible: false, semanticCrucibleSearch: true }).search({ query: 'neon' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(h.search).not.toHaveBeenCalled();
  });
});
