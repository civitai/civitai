import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as ServerDomain from '~/server/utils/server-domain';

import { ActionType } from '~/server/clickhouse/tracker';
import { trackActionSchema } from '~/server/schema/track.schema';
import {
  appVisitDetails,
  resolveAppListingVisit,
  visitActorKey,
  visitDedupeKey,
  type AppVisitDeps,
} from '~/server/services/blocks/app-listing-visit.service';

/**
 * The off-site visit redirect's DECISION and RECORDING, driven through injected deps so every
 * branch is observable without a database, Redis or ClickHouse.
 *
 * Pinned, in the order a reviewer should care:
 *   1. the destination is ONLY ever the listing's stored URL — a URL anywhere in the request
 *      (`?url=`, `?to=`, `?next=`, a URL-shaped id) never reaches the redirect;
 *   2. a listing the gate refuses (missing, hidden, on-site, no https URL) is a 404 and records
 *      NOTHING;
 *   3. the counter is de-duped per actor per day; the event is not;
 *   4. recording failures never fail the redirect.
 */

// Which hosts are red-capable is deployment config; pinned here so the host → `redCapable`
// hand-off is observable with a host the real config may not list.
vi.mock('~/server/utils/server-domain', async (importOriginal) => ({
  ...(await importOriginal<typeof ServerDomain>()),
  isRedCapableHost: (host: string | null | undefined) => host === 'red.example',
}));

const STORED = 'https://ext.example/app';
const LISTING_ID = 'apl_01J9ZK3Q4R5S6T7V8W9X0Y1Z2A';

function makeDeps(over: Partial<AppVisitDeps> = {}) {
  const claimed = new Set<string>();
  const base = {
    resolveScope: vi.fn(async () => 'full' as const),
    resolveFloor: vi.fn(async () => 'public' as const),
    findDestination: vi.fn(async (id: string) => ({ id, url: STORED })),
    recordEvent: vi.fn(async (_details: unknown, _ctx?: unknown, _session?: unknown) => true),
    claimOnce: vi.fn(async (key: string) => {
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    }),
    incrementVisitCount: vi.fn(async (_listingId: string) => undefined),
    dedupePrefix: vi.fn(async () => 'system:blocks:app-visit'),
    now: () => new Date('2026-11-07T12:00:00Z'),
  };
  // Every override a test passes is itself a `vi.fn`, so the mock typing of `base` holds.
  return { ...base, ...over } as typeof base;
}

// `any`: tests deliberately feed shapes the route param / session types would not admit.
function request(over: Record<string, unknown> = {}): any {
  return {
    listingId: LISTING_ID,
    query: { src: 'store_card' } as Record<string, unknown>,
    session: null,
    features: { canViewNsfw: false },
    ctx: {
      req: {
        headers: {
          host: 'civitai.com',
          referer: 'https://www.search.example/results?q=secret+terms',
          'cf-connecting-ip': '203.0.113.5',
        } as Record<string, string>,
      },
      res: {},
    },
    ...over,
  };
}

describe('resolveAppListingVisit — the redirect target', () => {
  it('redirects to the listing STORED url', async () => {
    const deps = makeDeps();
    const visit = await resolveAppListingVisit(request(), deps);
    expect(visit?.destination).toBe(STORED);
    await visit?.recorded;
  });

  it('IGNORES every URL in the query string — not an open redirect', async () => {
    const deps = makeDeps();
    const visit = await resolveAppListingVisit(
      request({
        query: {
          src: 'store_card',
          url: 'https://evil.example/phish',
          to: 'https://evil.example/phish',
          next: '//evil.example',
          redirect: 'https://evil.example',
        },
      }),
      deps
    );
    expect(visit?.destination).toBe(STORED);
    // Positive control: the stored-URL source really is what decides it — move it and the
    // destination moves with it, so the assertion above is not a constant.
    const moved = makeDeps({
      findDestination: vi.fn(async (id: string) => ({ id, url: 'https://moved.example/' })),
    });
    const visit2 = await resolveAppListingVisit(
      request({ query: { url: 'https://evil.example/phish' } }),
      moved
    );
    expect(visit2?.destination).toBe('https://moved.example/');
  });

  it('looks the listing up by its id, never by anything URL-shaped', async () => {
    const deps = makeDeps();
    for (const listingId of [
      'https://evil.example',
      '//evil.example',
      '../../etc',
      'a b',
      '',
      ['apl_1', 'apl_2'],
      undefined,
      'x'.repeat(65),
    ]) {
      expect(await resolveAppListingVisit(request({ listingId }), deps)).toBeNull();
    }
    expect(deps.findDestination).not.toHaveBeenCalled();
    expect(deps.recordEvent).not.toHaveBeenCalled();
  });
});

describe('resolveAppListingVisit — refusals', () => {
  it('404s (null) a listing the gate refuses — missing, hidden, on-site or no https URL — and records nothing', async () => {
    // `findDestination` is the detail read's own gate plus the off-site / https checks
    // (`getStoreVisibleOffsiteDestination`); every refusal reaches this module as `null`.
    const deps = makeDeps({ findDestination: vi.fn(async () => null) });
    const visit = await resolveAppListingVisit(request(), deps);
    expect(visit).toBeNull();
    expect(deps.findDestination).toHaveBeenCalledTimes(1);
    expect(deps.recordEvent).not.toHaveBeenCalled();
    expect(deps.claimOnce).not.toHaveBeenCalled();
    expect(deps.incrementVisitCount).not.toHaveBeenCalled();
  });

  it('404s a viewer whose store scope is `none` without reading the listing', async () => {
    const deps = makeDeps({ resolveScope: vi.fn(async () => 'none' as const) });
    expect(await resolveAppListingVisit(request(), deps)).toBeNull();
    expect(deps.findDestination).not.toHaveBeenCalled();
    expect(deps.recordEvent).not.toHaveBeenCalled();
  });

  it('applies the viewer scope, floor, host and browsing level to the lookup', async () => {
    const deps = makeDeps({
      resolveScope: vi.fn(async () => 'public-external' as const),
      resolveFloor: vi.fn(async () => 'moderators' as const),
    });
    await resolveAppListingVisit(
      request({
        ctx: { req: { headers: { host: 'red.example' } }, res: {} },
        features: { canViewNsfw: true },
      }),
      deps
    );
    const [id, opts] = deps.findDestination.mock.calls[0] as unknown as [string, any];
    expect(id).toBe(LISTING_ID);
    expect(opts.scope).toBe('public-external');
    expect(opts.floor).toBe('moderators');
    expect(opts.redCapable).toBe(true);
    expect(typeof opts.viewerBrowsingLevel).toBe('number');

    // …and a green host is not red-capable.
    deps.findDestination.mockClear();
    await resolveAppListingVisit(request(), deps);
    expect((deps.findDestination.mock.calls[0] as any)[1].redCapable).toBe(false);
  });
});

describe('resolveAppListingVisit — recording', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records one App_Visit row with the listing id, the surface and the referrer HOST only', async () => {
    const deps = makeDeps();
    const visit = await resolveAppListingVisit(request(), deps);
    await visit?.recorded;
    expect(deps.recordEvent).toHaveBeenCalledTimes(1);
    expect(deps.recordEvent.mock.calls[0][0]).toEqual({
      listingId: LISTING_ID,
      surface: 'store_card',
      referrerHost: 'www.search.example',
    });
    // The search terms in the referrer's query never reach the row.
    expect(JSON.stringify(deps.recordEvent.mock.calls[0][0])).not.toContain('secret');
  });

  it('reads an unknown surface as `direct`', async () => {
    const deps = makeDeps();
    const visit = await resolveAppListingVisit(request({ query: { src: 'banner' } }), deps);
    await visit?.recorded;
    expect((deps.recordEvent.mock.calls[0][0] as any).surface).toBe('direct');
  });

  it('counts the FIRST visit per actor per day; a refresh loop adds rows, not counts', async () => {
    const deps = makeDeps();
    for (let i = 0; i < 5; i++) {
      const visit = await resolveAppListingVisit(request(), deps);
      await visit?.recorded;
    }
    expect(deps.recordEvent).toHaveBeenCalledTimes(5);
    expect(deps.incrementVisitCount).toHaveBeenCalledTimes(1);
    expect(deps.incrementVisitCount).toHaveBeenCalledWith(LISTING_ID);
  });

  it('a different IP, a signed-in user, or the next day each count again', async () => {
    const deps = makeDeps();
    const run = async (over: Record<string, unknown>) =>
      (await resolveAppListingVisit(request(over), deps))?.recorded;

    await run({});
    await run({
      ctx: {
        req: { headers: { host: 'civitai.com', 'cf-connecting-ip': '198.51.100.9' } },
        res: {},
      },
    });
    await run({ session: { user: { id: 42 } } });
    await run({ session: { user: { id: 42 } } }); // same user, same day: no count
    expect(deps.incrementVisitCount).toHaveBeenCalledTimes(3);

    deps.now = () => new Date('2026-11-08T00:00:01Z');
    await run({});
    expect(deps.incrementVisitCount).toHaveBeenCalledTimes(4);
  });

  it('never writes the raw IP into the de-dupe key', async () => {
    const deps = makeDeps();
    await (
      await resolveAppListingVisit(request(), deps)
    )?.recorded;
    const key = deps.claimOnce.mock.calls[0][0] as string;
    expect(key.startsWith(`system:blocks:app-visit:${LISTING_ID}:i`)).toBe(true);
    expect(key.endsWith(':2026-11-07')).toBe(true);
    expect(key).not.toContain('203.0.113.5');
  });

  it('fails CLOSED on a Redis error: no increment, and the redirect still happens', async () => {
    const deps = makeDeps({
      claimOnce: vi.fn(async () => {
        throw new Error('redis down');
      }),
    });
    const visit = await resolveAppListingVisit(request(), deps);
    expect(visit?.destination).toBe(STORED);
    await expect(visit?.recorded).resolves.toBeUndefined();
    expect(deps.incrementVisitCount).not.toHaveBeenCalled();
    expect(deps.recordEvent).toHaveBeenCalledTimes(1);
  });

  it('a tracker or DB failure never fails the redirect', async () => {
    const deps = makeDeps({
      recordEvent: vi.fn(() => {
        throw new Error('sync boom');
      }),
      incrementVisitCount: vi.fn(async () => {
        throw new Error('db down');
      }),
    });
    const visit = await resolveAppListingVisit(request(), deps);
    expect(visit?.destination).toBe(STORED);
    await expect(visit?.recorded).resolves.toBeUndefined();
  });
});

describe('pure helpers', () => {
  it('visitActorKey prefers the user and hashes the IP', () => {
    expect(visitActorKey(7, '203.0.113.5')).toBe('u7');
    const a = visitActorKey(null, '203.0.113.5');
    expect(a).toMatch(/^i[0-9a-f]{32}$/);
    expect(visitActorKey(undefined, '203.0.113.5')).toBe(a);
    expect(visitActorKey(null, '203.0.113.6')).not.toBe(a);
  });

  it('visitDedupeKey is per listing, actor and UTC day', () => {
    expect(visitDedupeKey('p', 'apl_1', 'u7', new Date('2026-11-07T23:59:59Z'))).toBe(
      'p:apl_1:u7:2026-11-07'
    );
  });

  it('appVisitDetails omits an unusable referrer', () => {
    expect(appVisitDetails({ listingId: 'apl_1', surface: 'detail', referer: undefined })).toEqual({
      listingId: 'apl_1',
      surface: 'detail',
    });
    expect(
      appVisitDetails({ listingId: 'apl_1', surface: 'detail', referer: 'javascript:alert(1)' })
    ).toEqual({ listingId: 'apl_1', surface: 'detail' });
  });
});

describe('App_Visit is server-only', () => {
  it('is a real ActionType but has NO trackActionSchema arm', () => {
    // Like `App_Open`: `/api/track/batch` accepts `trackActionSchema` from any browser, so an
    // arm here would let a script post visits for any listing.
    expect(ActionType).toContain('App_Visit');
    const schemaTypes = trackActionSchema.options.map(
      (option: any) => option.shape.type.value as string
    );
    expect(schemaTypes).not.toContain('App_Visit');
    expect(schemaTypes).toContain('AppStore_Action');
  });
});
