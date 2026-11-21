/**
 * The listings read-model shadow (`app-listings-read-model-shadow.service.ts`): which pages are
 * shadowed, what is asked of the read model, how the two answers are compared, and that every
 * failure is an outcome rather than an error.
 *
 * Driven through `createListingsReadModelShadow` with the flag, clock, randomness, the read
 * model's HTTP answers and the database reads passed in; nothing of this repo is module-mocked. The
 * counters are the real ones, read as deltas from the registry `/api/metrics` scrapes.
 */
import { instrumentationRegistry } from '@civitai/telemetry/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ListAppListingsInput,
  ListingCard,
} from '~/server/schema/blocks/app-listing-read.schema';
import {
  createListingsReadModelShadow,
  rateLimited,
  readModelCursor,
  type DecodedDbCursor,
  type ListingsShadowDeps,
  type ReadModelCard,
  type ReadModelShadowConfig,
  type ShadowLogEntry,
} from '~/server/services/blocks/app-listings-read-model-shadow.service';
import { IndexBreaker } from '~/server/services/blocks/app-index-search.service';
import type { ListAvailableListingsOpts } from '~/server/services/blocks/app-listing.service';

const KEY = '0123456789abcdef0123456789abcdef';
const URL_BASE = 'http://read-model.invalid/base/';
const NOW_MS = 1_767_225_000_000;

function dbCard(slug: string, over: Partial<ListingCard> = {}): ListingCard {
  return {
    id: `al_${slug}`,
    slug,
    kind: 'onsite',
    name: `Name ${slug}`,
    tagline: `Tagline ${slug}`,
    category: 'utility',
    contentRating: 'pg',
    iconUrl: `https://img.invalid/${slug}/icon`,
    coverUrl: `https://img.invalid/${slug}/cover`,
    creator: { id: 42, username: 'maker', image: null },
    recommend: { recommendedCount: 3, notRecommendedCount: 1, recommendPct: 0.75 },
    reviewCount: 4,
    isBeta: false,
    isOfficial: false,
    openCount: 12,
    updatedAt: '2026-03-05T00:00:00.000Z',
    restrictedAudience: null,
    kindData: {
      kind: 'onsite',
      appBlockId: `ab_${slug}`,
      hasPage: true,
      liveUrl: `https://${slug}.apps.invalid`,
    },
    ...over,
  };
}

/** The read model's card for the same listing: no id, no appBlockId. */
function rmCard(card: ListingCard, over: Partial<ReadModelCard> = {}): ReadModelCard {
  const kindData =
    card.kindData.kind === 'onsite'
      ? { kind: 'onsite', hasPage: card.kindData.hasPage, liveUrl: card.kindData.liveUrl }
      : { kind: 'offsite', externalUrl: card.kindData.externalUrl };
  return {
    slug: card.slug,
    kind: card.kind,
    name: card.name,
    tagline: card.tagline,
    category: card.category,
    contentRating: card.contentRating,
    iconUrl: card.iconUrl,
    coverUrl: card.coverUrl,
    creator: card.creator,
    recommend: card.recommend,
    reviewCount: card.reviewCount,
    isBeta: card.isBeta,
    isOfficial: card.isOfficial ?? false,
    openCount: card.openCount,
    updatedAt: card.updatedAt,
    kindData,
    ...over,
  };
}

const INPUT: ListAppListingsInput = { kind: 'all', sort: 'top-rated', limit: 3 };
const OPTS: ListAvailableListingsOpts = {
  redCapable: true,
  scope: 'full',
  floor: 'public',
  viewerBrowsingLevel: 15,
};

type Call = { url: URL; headers: Record<string, string> };
type Reply = (call: Call) => Response | Promise<Response>;

let calls: Call[];
let reply: Reply;
let dbBySlugs: Map<string, ListingCard>;
let dbBySlugsCalls: string[][];
let logs: ShadowLogEntry[];
let config: ReadModelShadowConfig;
let flag: boolean;
let decoded: DecodedDbCursor;
let slugOf: Map<string, string>;

function makeShadow(over: Partial<ListingsShadowDeps> = {}) {
  const deps: ListingsShadowDeps = {
    enabled: () => flag,
    config: () => config,
    random: () => 0.5,
    nowMs: () => NOW_MS,
    fetch: async (url, init) => {
      const call = { url: new URL(url), headers: init.headers };
      calls.push(call);
      return reply(call);
    },
    decodeCursor: () => decoded,
    slugOfListing: async (id) => slugOf.get(id) ?? null,
    dbBySlugs: async (slugs) => {
      dbBySlugsCalls.push(slugs);
      return slugs.flatMap((s) => {
        const c = dbBySlugs.get(s);
        return c ? [c] : [];
      });
    },
    breaker: new IndexBreaker(
      () => ({ threshold: 2, cooldownMs: 60_000 }),
      () => NOW_MS,
      () => undefined
    ),
    log: (entry) => logs.push(entry),
    ...over,
  };
  return createListingsReadModelShadow(deps);
}

/** The read model answers `list` for a page and admits `admitted` when asked by slug. */
/**
 * The read model answers `list` for a page and, asked by slug, the `admitted` listings (a slug for
 * that listing's own card, or a card).
 */
function readModelAnswers(
  list: ReadModelCard[],
  nextCursor?: string,
  admitted: (string | ReadModelCard)[] = []
) {
  reply = ({ url }) => {
    const slugs = url.searchParams.get('slugs');
    if (slugs !== null) {
      const want = new Set(slugs.split(','));
      return Response.json({
        items: admitted
          .map((a) => (typeof a === 'string' ? rmCard(dbCard(a)) : a))
          .filter((c) => want.has(c.slug)),
      });
    }
    return Response.json(nextCursor ? { items: list, nextCursor } : { items: list });
  };
}

async function readCounter(name: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const metric = instrumentationRegistry.getSingleMetric(name);
  if (!metric) return out;
  for (const v of (await metric.get()).values) {
    const key = Object.values(v.labels).join('/');
    out.set(key, (out.get(key) ?? 0) + v.value);
  }
  return out;
}
const COUNTERS = [
  'app_listings_read_model_shadow_requests_total',
  'app_listings_read_model_mismatches_total',
  'app_listings_read_model_field_mismatches_total',
  'app_listings_read_model_order_mismatches_total',
  'app_listings_read_model_compared_slugs_total',
] as const;
let baseline: Map<string, Map<string, number>>;
/** Every counter series that moved since the test began, as `name{labels}:delta`. */
async function moved(): Promise<string[]> {
  const out: string[] = [];
  for (const name of COUNTERS) {
    const before = baseline.get(name) ?? new Map<string, number>();
    for (const [k, v] of await readCounter(name)) {
      const d = v - (before.get(k) ?? 0);
      if (d > 0) out.push(`${name.replace('app_listings_read_model_', '')}{${k}}:${d}`);
    }
  }
  return out.sort();
}

beforeEach(async () => {
  calls = [];
  dbBySlugs = new Map();
  dbBySlugsCalls = [];
  logs = [];
  flag = true;
  config = { url: URL_BASE, key: KEY, sample: 1, maxInFlight: 4, timeoutMs: 1000 };
  decoded = { cursorSortKey: null, cursorId: null, cursorMean: null };
  slugOf = new Map();
  readModelAnswers([]);
  baseline = new Map();
  for (const name of COUNTERS) baseline.set(name, await readCounter(name));
});
afterEach(() => {
  calls = [];
});

const A = dbCard('alpha');
const B = dbCard('bravo');
const C = dbCard('charlie');

describe('which pages are shadowed', () => {
  it('flag off, or sampled out: nothing is asked and nothing is counted', async () => {
    flag = false;
    expect(makeShadow().shadow('grid', INPUT, OPTS, { items: [A] })).toBeUndefined();
    flag = true;
    config.sample = 0.5; // random() is 0.5: not below the rate
    expect(makeShadow().shadow('grid', INPUT, OPTS, { items: [A] })).toBeUndefined();
    expect(calls).toEqual([]);
    expect(await moved()).toEqual([]);
  });

  it('a viewer or page the read model does not answer stays on the database', async () => {
    const shadow = makeShadow();
    shadow.shadow('grid', INPUT, { ...OPTS, floor: 'testers' }, { items: [A] });
    shadow.shadow('grid', INPUT, { ...OPTS, viewerBrowsingLevel: 64 }, { items: [A] });
    shadow.shadow('grid', INPUT, { ...OPTS, includeSubListings: true }, { items: [A] });
    shadow.shadow('grid', INPUT, OPTS, { items: [A], search: 'index' });
    config.key = KEY.slice(0, 31);
    shadow.shadow('rest_list', INPUT, OPTS, { items: [A] });
    expect(calls).toEqual([]);
    expect(await moved()).toEqual([
      'shadow_requests_total{grid/unsupported_input}:2',
      'shadow_requests_total{grid/unsupported_viewer}:2',
      'shadow_requests_total{rest_list/unconfigured}:1',
    ]);
  });
});

describe('what is asked', () => {
  it('the same query, with the viewer the database read was answered for, signed', async () => {
    readModelAnswers([rmCard(A)]);
    await makeShadow().shadow(
      'grid',
      { kind: 'onsite', category: 'utility', sort: 'newest', limit: 3, userId: 42, query: 'x' },
      OPTS,
      { items: [A] }
    );
    expect(calls).toHaveLength(1);
    const { url, headers } = calls[0];
    expect(`${url.origin}${url.pathname}`).toBe('http://read-model.invalid/base/listings');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      sort: 'newest',
      limit: '3',
      kind: 'onsite',
      category: 'utility',
      userId: '42',
    });
    const [, payload] = headers['X-App-Index-Viewer'].split('.');
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))).toEqual({
      host: 'red',
      level: 15,
      scope: 'full',
      exp: NOW_MS / 1000 + 60,
    });
  });

  it("page 2: the database cursor's position in the read model's terms, its mean pinned", async () => {
    decoded = {
      cursorSortKey: '00000700000000000000000000120',
      cursorId: 'al_paint',
      cursorMean: 0.625,
    };
    slugOf.set('al_paint', 'paint');
    readModelAnswers([rmCard(A)]);
    await makeShadow().shadow('grid', { ...INPUT, cursor: 'db-cursor' }, OPTS, { items: [A] });
    // The literal is the read model's own EncodeCursor output (rank_test.go TestCursorVector).
    expect(calls[0].url.searchParams.get('cursor')).toBe(
      'cm0xHzAwMDAwNzAwMDAwMDAwMDAwMDAwMDAwMDAwMTIwH3BhaW50HzAuNjI1'
    );
    expect(readModelCursor('paint', 'paint', null)).toBe('cm0xH3BhaW50H3BhaW50');
  });

  it("a cursor whose listing is gone, or a sub-listing's, is not shadowed", async () => {
    decoded = { cursorSortKey: 'k', cursorId: 'al_gone', cursorMean: null };
    await makeShadow().shadow('grid', { ...INPUT, cursor: 'db-cursor' }, OPTS, { items: [A] });
    decoded = { cursorSortKey: 'k', cursorId: 'asl_01ARZ3NDEKTSV4RRFFQ69G5FAV', cursorMean: null };
    await makeShadow().shadow('grid', { ...INPUT, cursor: 'db-cursor' }, OPTS, { items: [A] });
    expect(calls).toEqual([]);
    expect(await moved()).toEqual(['shadow_requests_total{grid/unsupported_input}:2']);
  });
});

describe('the comparison', () => {
  it('the same page: compared, nothing differs, nothing logged', async () => {
    readModelAnswers([rmCard(A), rmCard(B)], 'rm-next');
    await makeShadow().shadow('grid', INPUT, OPTS, { items: [A, B], nextCursor: 'db-next' });
    expect(await moved()).toEqual([
      'compared_slugs_total{grid}:2',
      'shadow_requests_total{grid/compared}:1',
    ]);
    expect(logs).toEqual([]);
    expect(dbBySlugsCalls).toEqual([]);
  });

  it('a listing the read model shows that the database does not show this viewer: visibility_extra', async () => {
    // The read model answers C where the database answered B. Asked by slug, the read model does
    // show B (so B is only paged differently) but the database does not show C at all.
    readModelAnswers([rmCard(A), rmCard(C)], undefined, ['bravo']);
    await makeShadow().shadow('rest_list', INPUT, OPTS, { items: [A, B] });
    expect(dbBySlugsCalls).toEqual([['charlie']]);
    expect(await moved()).toEqual([
      'compared_slugs_total{rest_list}:3',
      'mismatches_total{rest_list/visibility_extra}:1',
      // B is on the database page only (and admitted by the read model): a paging difference.
      'order_mismatches_total{rest_list}:1',
      'shadow_requests_total{rest_list/compared}:1',
    ]);
    expect(logs).toEqual([
      {
        surface: 'rest_list',
        visibilityMissing: [],
        visibilityExtra: ['charlie'],
        fields: {},
        order: true,
      },
    ]);
  });

  it('a listing the database shows that the read model does not: visibility_missing, not order', async () => {
    readModelAnswers([rmCard(A)], undefined, []);
    await makeShadow().shadow('grid', INPUT, OPTS, { items: [A, B] });
    expect(await moved()).toEqual([
      'compared_slugs_total{grid}:2',
      'mismatches_total{grid/visibility_missing}:1',
      'shadow_requests_total{grid/compared}:1',
    ]);
    expect(logs[0]).toMatchObject({ visibilityMissing: ['bravo'], order: false });
  });

  it('a page boundary on a tie (each side admits the other): order only, never visibility', async () => {
    readModelAnswers([rmCard(A), rmCard(C)], undefined, ['bravo']);
    dbBySlugs.set('charlie', C);
    await makeShadow().shadow('grid', INPUT, OPTS, { items: [A, B] });
    expect(await moved()).toEqual([
      'compared_slugs_total{grid}:3',
      'order_mismatches_total{grid}:1',
      'shadow_requests_total{grid/compared}:1',
    ]);
  });

  it('with the developer filter, a listing the database admits by slug but of another developer is extra', async () => {
    readModelAnswers([rmCard(A), rmCard(C)], undefined, ['bravo']);
    dbBySlugs.set(
      'charlie',
      dbCard('charlie', { creator: { id: 7, username: 'owl', image: null } })
    );
    await makeShadow().shadow('grid', { ...INPUT, userId: 42 }, OPTS, { items: [A, B] });
    expect(await moved()).toContain('mismatches_total{grid/visibility_extra}:1');
  });

  it('the same order with one side having a next page is an order mismatch', async () => {
    readModelAnswers([rmCard(A)]);
    await makeShadow().shadow('grid', INPUT, OPTS, { items: [A], nextCursor: 'db-next' });
    expect(await moved()).toContain('order_mismatches_total{grid}:1');
  });

  it('media and other fields are counted apart, per listing and per field', async () => {
    readModelAnswers([
      rmCard(A, { coverUrl: 'https://img.invalid/alpha/red-cover' }),
      rmCard(B, { name: 'Renamed', recommend: { ...B.recommend, recommendPct: 0.5 } }),
      rmCard(C),
    ]);
    await makeShadow().shadow('grid', INPUT, OPTS, { items: [A, B, C] });
    expect(await moved()).toEqual([
      'compared_slugs_total{grid}:3',
      'field_mismatches_total{grid/coverUrl}:1',
      'field_mismatches_total{grid/name}:1',
      'field_mismatches_total{grid/recommendPct}:1',
      'mismatches_total{grid/identity_field}:1',
      'mismatches_total{grid/media}:1',
      'mismatches_total{grid/stats_field}:1',
      'shadow_requests_total{grid/compared}:1',
    ]);
    // Slugs and field names only, never a value.
    expect(logs).toEqual([
      {
        surface: 'grid',
        visibilityMissing: [],
        visibilityExtra: [],
        fields: { alpha: ['coverUrl'], bravo: ['name', 'recommendPct'] },
        order: false,
      },
    ]);
  });

  // The serving gate's classes (LISTINGS-READ-MODEL.md, "Go / no-go for serving"; decided with the
  // operator: identity fields gate with visibility and media, stats fields are report-only). One
  // field differs per case, so the kind it lands in is that field's class alone.
  it.each([
    ['iconUrl', 'media', { iconUrl: 'https://img.invalid/other/icon' }],
    ['coverUrl', 'media', { coverUrl: null }],
    ['name', 'identity_field', { name: 'Other' }],
    ['tagline', 'identity_field', { tagline: null }],
    ['category', 'identity_field', { category: 'games' }],
    ['contentRating', 'identity_field', { contentRating: 'pg13' }],
    ['creator', 'identity_field', { creator: { id: 43, username: 'maker', image: null } }],
    ['isBeta', 'identity_field', { isBeta: true }],
    ['isOfficial', 'identity_field', { isOfficial: true }],
    ['kindData', 'identity_field', { kindData: { kind: 'onsite', hasPage: false, liveUrl: null } }],
    [
      'recommendedCount',
      'stats_field',
      { recommend: { recommendedCount: 9, notRecommendedCount: 1, recommendPct: 0.75 } },
    ],
    [
      'notRecommendedCount',
      'stats_field',
      { recommend: { recommendedCount: 3, notRecommendedCount: 9, recommendPct: 0.75 } },
    ],
    [
      'recommendPct',
      'stats_field',
      { recommend: { recommendedCount: 3, notRecommendedCount: 1, recommendPct: 0.5 } },
    ],
    ['reviewCount', 'stats_field', { reviewCount: 99 }],
    ['openCount', 'stats_field', { openCount: 99 }],
    ['updatedAt', 'stats_field', { updatedAt: '2027-01-01T00:00:00.000Z' }],
  ] as [string, string, Partial<ReadModelCard>][])('%s counts as %s', async (field, kind, over) => {
    readModelAnswers([rmCard(A, over)]);
    await makeShadow().shadow('grid', INPUT, OPTS, { items: [A] });
    expect(await moved()).toEqual([
      'compared_slugs_total{grid}:1',
      `field_mismatches_total{grid/${field}}:1`,
      `mismatches_total{grid/${kind}}:1`,
      'shadow_requests_total{grid/compared}:1',
    ]);
  });

  it('with the developer filter, a listing the read model admits by slug but of another developer is missing', async () => {
    readModelAnswers([rmCard(A)], undefined, [
      rmCard(dbCard('bravo', { creator: { id: 7, username: 'owl', image: null } })),
    ]);
    await makeShadow().shadow('grid', { ...INPUT, userId: 42 }, OPTS, { items: [A, B] });
    // The slug lookup carries no developer filter (the read model refuses one there).
    expect(calls[1].url.searchParams.get('userId')).toBeNull();
    expect(await moved()).toContain('mismatches_total{grid/visibility_missing}:1');
    expect(await moved()).not.toContain('order_mismatches_total{grid}:1');
  });

  it('values that only differ in representation are the same', async () => {
    const off = dbCard('offsite', {
      kind: 'offsite',
      isOfficial: undefined,
      openCount: null,
      updatedAt: undefined,
      kindData: { kind: 'offsite', externalUrl: null },
    });
    readModelAnswers([
      rmCard(A, { updatedAt: '2026-03-05T00:00:00Z' }),
      rmCard(off, { isOfficial: false, kindData: { kind: 'offsite', externalUrl: null } }),
    ]);
    await makeShadow().shadow('grid', INPUT, OPTS, { items: [A, off] });
    expect(logs).toEqual([]);
  });
});

describe('failures', () => {
  it.each([
    [
      'a timeout',
      () => Promise.reject(Object.assign(new Error('t'), { name: 'TimeoutError' })),
      'timeout',
    ],
    ['a connection error', () => Promise.reject(new TypeError('fetch failed')), 'error'],
    ['a 503', () => new Response('{}', { status: 503 }), 'not_ready'],
    ['a 401', () => new Response('{}', { status: 401 }), 'error'],
    ['a body that is not a page', () => Response.json({ results: [] }), 'bad_response'],
  ] as const)('%s is an outcome, and never rejects', async (_name, r, outcome) => {
    reply = r;
    await expect(makeShadow().shadow('grid', INPUT, OPTS, { items: [A] })).resolves.toBeUndefined();
    expect(await moved()).toEqual([`shadow_requests_total{grid/${outcome}}:1`]);
  });

  it('a run of failures opens the breaker: the read model is no longer asked', async () => {
    reply = () => new Response('{}', { status: 500 });
    const shadow = makeShadow();
    await shadow.shadow('grid', INPUT, OPTS, { items: [A] });
    await shadow.shadow('grid', INPUT, OPTS, { items: [A] });
    await shadow.shadow('grid', INPUT, OPTS, { items: [A] });
    expect(calls).toHaveLength(2);
    expect(await moved()).toEqual([
      'shadow_requests_total{grid/breaker_open}:1',
      'shadow_requests_total{grid/error}:2',
    ]);
  });

  it('a database failure checking a difference is db_error and does not move the breaker', async () => {
    readModelAnswers([rmCard(A), rmCard(C)]);
    const breaker = new IndexBreaker(
      () => ({ threshold: 1, cooldownMs: 60_000 }),
      () => NOW_MS,
      () => undefined
    );
    const shadow = makeShadow({
      breaker,
      dbBySlugs: () => Promise.reject(new Error('db down')),
    });
    await shadow.shadow('grid', INPUT, OPTS, { items: [A] });
    expect(breaker.allow()).toBe(true);
    expect(await moved()).toEqual(['shadow_requests_total{grid/db_error}:1']);
  });

  it('a database read of the shadow that stalls is db_timeout, and frees the slot', async () => {
    config.timeoutMs = 20;
    readModelAnswers([rmCard(A), rmCard(C)]);
    const shadow = makeShadow({ dbBySlugs: () => new Promise<ListingCard[]>(() => undefined) });
    await shadow.shadow('grid', INPUT, OPTS, { items: [A] });
    expect(shadow.inFlight()).toBe(0);
    expect(await moved()).toEqual(['shadow_requests_total{grid/db_timeout}:1']);
  });

  it('a half-open probe is never spent by a page that returns before asking the read model', async () => {
    let t = NOW_MS;
    const breaker = new IndexBreaker(
      () => ({ threshold: 1, cooldownMs: 60_000 }),
      () => t,
      () => undefined
    );
    const shadow = makeShadow({ breaker });
    reply = () => new Response('{}', { status: 500 });
    await shadow.shadow('grid', INPUT, OPTS, { items: [A] }); // opens the breaker
    t += 60_000; // the cooldown has passed: the next read-model call is the probe
    // Page 2 whose cursor's listing is gone: returns before any read-model call.
    decoded = { cursorSortKey: 'k', cursorId: 'al_gone', cursorMean: null };
    await shadow.shadow('grid', { ...INPUT, cursor: 'db-cursor' }, OPTS, { items: [A] });
    // The next page is still the probe, not refused for another cooldown.
    readModelAnswers([rmCard(A)]);
    await shadow.shadow('grid', INPUT, OPTS, { items: [A] });
    expect(calls).toHaveLength(2);
    expect(await moved()).toEqual([
      'compared_slugs_total{grid}:1',
      'shadow_requests_total{grid/compared}:1',
      'shadow_requests_total{grid/error}:1',
      'shadow_requests_total{grid/unsupported_input}:1',
    ]);
  });

  it('at most maxInFlight reads at a time: the rest are dropped, not queued', async () => {
    config.maxInFlight = 1;
    let release: () => void = () => undefined;
    reply = () =>
      new Promise<Response>((resolve) => {
        release = () => resolve(Response.json({ items: [rmCard(A)] }));
      });
    const shadow = makeShadow();
    const first = shadow.shadow('grid', INPUT, OPTS, { items: [A] });
    expect(shadow.shadow('grid', INPUT, OPTS, { items: [A] })).toBeUndefined();
    expect(shadow.inFlight()).toBe(1);
    release();
    await first;
    expect(shadow.inFlight()).toBe(0);
    expect(calls).toHaveLength(1);
    expect(await moved()).toEqual([
      'compared_slugs_total{grid}:1',
      'shadow_requests_total{grid/compared}:1',
      'shadow_requests_total{grid/saturated}:1',
    ]);
  });
});

describe('rateLimited', () => {
  it('passes at most N a minute, then N again in the next minute', () => {
    let t = 0;
    const seen: number[] = [];
    const log = rateLimited(
      (n: number) => seen.push(n),
      2,
      () => t
    );
    for (const n of [1, 2, 3]) log(n);
    t = 60_000;
    for (const n of [4, 5, 6]) log(n);
    expect(seen).toEqual([1, 2, 4, 5]);
  });
});
