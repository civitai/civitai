import { describe, it, expect, vi, beforeEach } from 'vitest';
// Module scope, not a test body: the page transform is charged here once (see the run-page tests).
import '~/pages/apps/go/[listingId]';

/**
 * `/apps/go/<listingId>` — the page half of the off-site visit redirect. The decision lives in
 * `app-listing-visit.service` (its own unit test); this pins what the PAGE does with it:
 * the store page gate runs first, a refusal is a 404, an accepted visit is a 302 (never a
 * permanent redirect) to exactly the destination the service returned, and the request's own
 * query string is handed to the service untouched rather than used to build a destination.
 */

const { capturedResolver, mockResolveVisit } = vi.hoisted(() => ({
  capturedResolver: { fn: null as null | ((c: any) => Promise<any>) },
  mockResolveVisit: vi.fn<(...a: any[]) => Promise<any>>(),
}));

vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: (opts: { resolver: (c: any) => Promise<any> }) => {
    capturedResolver.fn = opts.resolver;
    return async () => ({ props: {} });
  },
}));
vi.mock('~/server/services/blocks/app-listing-visit.service', () => ({
  resolveAppListingVisit: mockResolveVisit,
}));

const STORE_ON = { appBlocks: true, appListings: true, canViewNsfw: false };

function args(over: { features?: any; query?: Record<string, unknown> } = {}) {
  return {
    features: over.features ?? STORE_ON,
    session: null,
    isClient: false,
    ctx: {
      params: { listingId: 'apl_1' },
      query: over.query ?? { src: 'store_card' },
      req: { headers: { host: 'civitai.com' } },
      res: {},
    },
  };
}

describe('/apps/go/<listingId> page', () => {
  beforeEach(() => mockResolveVisit.mockReset());

  it('302s (not permanent) to exactly the destination the service resolved', async () => {
    mockResolveVisit.mockResolvedValue({
      destination: 'https://ext.example/app',
      recorded: Promise.resolve(),
    });
    const result = await capturedResolver.fn!(args());
    expect(result).toEqual({
      redirect: { destination: 'https://ext.example/app', statusCode: 302 },
    });
  });

  it('hands the route param and the raw query to the service, and never builds a URL from it', async () => {
    mockResolveVisit.mockResolvedValue({
      destination: 'https://ext.example/app',
      recorded: Promise.resolve(),
    });
    const result = await capturedResolver.fn!(
      args({ query: { src: 'detail', url: 'https://evil.example' } })
    );
    const call = mockResolveVisit.mock.calls[0][0];
    expect(call.listingId).toBe('apl_1');
    expect(call.query).toEqual({ src: 'detail', url: 'https://evil.example' });
    expect(result.redirect.destination).toBe('https://ext.example/app');
  });

  it('404s when the service refuses the listing (hidden, on-site, missing)', async () => {
    mockResolveVisit.mockResolvedValue(null);
    expect(await capturedResolver.fn!(args())).toEqual({ notFound: true });
  });

  it('404s before any lookup when the viewer has no store access', async () => {
    const result = await capturedResolver.fn!(
      args({ features: { appBlocks: false, appListings: false } })
    );
    expect(result).toEqual({ notFound: true });
    expect(mockResolveVisit).not.toHaveBeenCalled();
  });
});
