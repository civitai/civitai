import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as ServerDomain from '~/server/utils/server-domain';

import { ActionType } from '~/server/clickhouse/tracker';
import { trackActionSchema } from '~/server/schema/track.schema';
import { getServerBrowsingLevel } from '~/server/utils/browsing-level';
import {
  resolveAppListingVisit,
  defaultAppVisitDeps,
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
 *   3. every hit is one raw `App_Visit` row and NO Postgres write (the count is derived later);
 *   4. recording failures never fail the redirect.
 */

// The real `recordEvent` dep is exercised against a mocked Tracker (as the App_Open service
// test does); every other case injects fakes.
const trackerMocks = vi.hoisted(() => ({
  action: vi.fn<(...a: any[]) => Promise<boolean>>(),
  ctor: vi.fn<(...a: any[]) => void>(),
}));
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    constructor(...args: any[]) {
      trackerMocks.ctor(...args);
    }
    action = trackerMocks.action;
  },
}));

// Which hosts are red-capable is deployment config; pinned here so the host → `redCapable`
// hand-off is observable with a host the real config may not list.
vi.mock('~/server/utils/server-domain', async (importOriginal) => ({
  ...(await importOriginal<typeof ServerDomain>()),
  isRedCapableHost: (host: string | null | undefined) => host === 'red.example',
}));

const STORED = 'https://ext.example/app';
const LISTING_ID = 'apl_01J9ZK3Q4R5S6T7V8W9X0Y1Z2A';

function makeDeps(over: Partial<AppVisitDeps> = {}) {
  const base = {
    resolveScope: vi.fn(async () => 'full' as const),
    resolveFloor: vi.fn(async () => 'public' as const),
    findDestination: vi.fn(async (id: string) => ({ id, url: STORED })),
    recordEvent: vi.fn(async (_details: unknown, _ctx?: unknown, _session?: unknown) => true),
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

    // …and a green host is not red-capable.
    deps.findDestination.mockClear();
    await resolveAppListingVisit(request(), deps);
    expect((deps.findDestination.mock.calls[0] as any)[1].redCapable).toBe(false);
  });
});

describe('resolveAppListingVisit — the browsing level handed to the gate', () => {
  // An NSFW-opted-in user whose saved level is distinct from both fallback levels, so each
  // input (the host's `canViewNsfw`, the session) moves the value.
  const NSFW_USER = { id: 7, showNsfw: true, browsingLevel: 28 };
  const levelFor = async (features: { canViewNsfw: boolean }, session: unknown) => {
    const deps = makeDeps();
    await resolveAppListingVisit(request({ features, session }), deps);
    return (deps.findDestination.mock.calls[0] as unknown as [string, any])[1].viewerBrowsingLevel;
  };

  it('follows canViewNsfw: each value equals getServerBrowsingLevel, and the two differ', async () => {
    const on = await levelFor({ canViewNsfw: true }, { user: NSFW_USER });
    const off = await levelFor({ canViewNsfw: false }, { user: NSFW_USER });
    expect(on).toBe(getServerBrowsingLevel({ canViewNsfw: true, user: NSFW_USER as never }));
    expect(off).toBe(getServerBrowsingLevel({ canViewNsfw: false, user: NSFW_USER as never }));
    // Hardcoding `canViewNsfw: false` (or `true`) would make these equal.
    expect(on).not.toBe(off);
  });

  it("follows the session: the signed-in user's level differs from the anonymous one", async () => {
    const signedIn = await levelFor({ canViewNsfw: true }, { user: NSFW_USER });
    const anonymous = await levelFor({ canViewNsfw: true }, null);
    expect(signedIn).toBe(getServerBrowsingLevel({ canViewNsfw: true, user: NSFW_USER as never }));
    expect(anonymous).toBe(getServerBrowsingLevel({ canViewNsfw: true, user: undefined }));
    // Ignoring the session would make these equal.
    expect(signedIn).not.toBe(anonymous);
  });
});

describe('resolveAppListingVisit — recording', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records one App_Visit row with exactly the listing id and the surface — no referrer', async () => {
    const deps = makeDeps();
    const visit = await resolveAppListingVisit(request(), deps);
    await visit?.recorded;
    expect(deps.recordEvent).toHaveBeenCalledTimes(1);
    expect(deps.recordEvent.mock.calls[0][0]).toEqual({
      listingId: LISTING_ID,
      surface: 'store_card',
    });
    // The request carried a referer; nothing of it (host or query) reaches the row.
    expect(JSON.stringify(deps.recordEvent.mock.calls[0][0])).not.toMatch(/search\.example|secret/);
  });

  it.each([
    'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
    'facebookexternalhit/1.1',
    'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
  ])('a crawler / link unfurler (%s) is REDIRECTED but records nothing', async (ua) => {
    const deps = makeDeps();
    const visit = await resolveAppListingVisit(
      request({
        ctx: { req: { headers: { host: 'civitai.com', 'user-agent': ua } }, res: {} },
      }),
      deps
    );
    expect(visit?.destination).toBe(STORED);
    await visit?.recorded;
    expect(deps.recordEvent).not.toHaveBeenCalled();
  });

  it('a browser user agent IS recorded (positive control for the bot skip)', async () => {
    const deps = makeDeps();
    const visit = await resolveAppListingVisit(
      request({
        ctx: {
          req: {
            headers: {
              host: 'civitai.com',
              'user-agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
            },
          },
          res: {},
        },
      }),
      deps
    );
    await visit?.recorded;
    expect(deps.recordEvent).toHaveBeenCalledTimes(1);
  });

  it('reads an unknown surface as `direct`', async () => {
    const deps = makeDeps();
    const visit = await resolveAppListingVisit(request({ query: { src: 'banner' } }), deps);
    await visit?.recorded;
    expect((deps.recordEvent.mock.calls[0][0] as any).surface).toBe('direct');
  });

  it("a refresh loop records one raw row per hit — the de-dupe is the metrics job's, at read time", async () => {
    const deps = makeDeps();
    for (let i = 0; i < 5; i++) await (await resolveAppListingVisit(request(), deps))?.recorded;
    expect(deps.recordEvent).toHaveBeenCalledTimes(5);
  });

  it('a synchronous tracker throw never fails the redirect', async () => {
    const deps = makeDeps({
      recordEvent: vi.fn(() => {
        throw new Error('sync boom');
      }),
    });
    const visit = await resolveAppListingVisit(request(), deps);
    expect(visit?.destination).toBe(STORED);
    await expect(visit?.recorded).resolves.toBeUndefined();
  });

  it('an async tracker rejection never fails the redirect', async () => {
    const deps = makeDeps({
      recordEvent: vi.fn(async () => {
        throw new Error('clickhouse down');
      }),
    });
    const visit = await resolveAppListingVisit(request(), deps);
    expect(visit?.destination).toBe(STORED);
    await expect(visit?.recorded).resolves.toBeUndefined();
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

describe('defaultAppVisitDeps.recordEvent — the real ClickHouse write', () => {
  beforeEach(() => {
    trackerMocks.action.mockReset();
    trackerMocks.action.mockResolvedValue(true);
    trackerMocks.ctor.mockReset();
  });

  it('writes exactly one App_Visit with the details, WITH actor metadata (no skipActorMeta)', async () => {
    const details = { listingId: LISTING_ID, surface: 'store_card' as const };
    const ctx = { req: { headers: {} }, res: {} };
    const session = { user: { id: 7 } } as any;
    await defaultAppVisitDeps.recordEvent(details, ctx, session);

    expect(trackerMocks.ctor).toHaveBeenCalledWith(ctx.req, ctx.res, session);
    expect(trackerMocks.action).toHaveBeenCalledTimes(1);
    expect(trackerMocks.action).toHaveBeenCalledWith({ type: 'App_Visit', details });
    // 🔴 The read-time de-dupe (one actor per listing per UTC day) falls back to `ip` for
    // anonymous visitors, so the row MUST carry actor metadata: no options argument at all.
    expect(trackerMocks.action.mock.calls[0]).toHaveLength(1);
  });
});
