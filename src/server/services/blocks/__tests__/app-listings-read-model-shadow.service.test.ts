/**
 * The listings read-model shadow (`app-listings-read-model-shadow.service.ts`): which pages are
 * shadowed, what is asked of the read model, how the two answers are compared, and that every
 * failure is an outcome rather than an error.
 *
 * Driven through `createListingsReadModelShadow` with the flag's mode, clock, randomness, the read
 * model's HTTP answers and the database reads passed in; nothing of this repo is module-mocked. The
 * counters are the real ones, read as deltas from the registry `/api/metrics` scrapes.
 *
 * The flag's mode (`readReadModelMode`) and serving (`serve`, mode `serve`) are at the end.
 */
import { instrumentationRegistry } from '@civitai/telemetry/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ListAppListingsInput,
  ListingCard,
  SubListingCard,
} from '~/server/schema/blocks/app-listing-read.schema';
import {
  createCachedModeGate,
  createListingsReadModelShadow,
  decodeReadModelCursor,
  quietVariantRead,
  readModelCursor,
  readReadModelMode,
  servedCardOf,
  type DecodedDbCursor,
  type ListingPage,
  type ListingsShadowDeps,
  type ReadModelCard,
  type ReadModelFlagReads,
  type ReadModelMode,
  type ReadModelShadowConfig,
  type ReadModelSubListingCard,
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

/** The read model's card for the same listing, with its id and appBlockId. */
function rmCard(card: ListingCard, over: Partial<ReadModelCard> = {}): ReadModelCard {
  const kindData =
    card.kindData.kind === 'onsite'
      ? {
          kind: 'onsite' as const,
          appBlockId: card.kindData.appBlockId,
          hasPage: card.kindData.hasPage,
          liveUrl: card.kindData.liveUrl,
        }
      : { kind: 'offsite' as const, externalUrl: card.kindData.externalUrl };
  return {
    id: card.id,
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

/** A sub-listing's database card, under the listing `parent`. */
function dbSub(n: number, over: Partial<SubListingCard> = {}): SubListingCard {
  const id = `asl_01J9ZK3Q4R5S6T7V8W9X0YS0${String(n).padStart(2, '0')}`;
  return {
    cardType: 'sub-listing',
    id,
    name: `Item ${n}`,
    tagline: `Item tagline ${n}`,
    kind: 'onsite',
    category: 'utility',
    contentRating: 'pg',
    coverUrl: `https://img.invalid/items/${n}/cover`,
    creator: { id: 500 + n, username: `author-${n}`, image: null },
    parent: {
      id: 'al_alpha',
      slug: 'alpha',
      name: 'Name alpha',
      iconUrl: 'https://img.invalid/alpha/icon',
    },
    runHref: `/apps/run/alpha/items/${n}?sl=${id}`,
    ...over,
  };
}

/** The read model's card for the same sub-listing. */
function rmSub(card: SubListingCard, over: Partial<ReadModelSubListingCard> = {}) {
  return { ...card, ...over } as ReadModelSubListingCard;
}

const INPUT: ListAppListingsInput = { kind: 'all', sort: 'top-rated', limit: 3 };
const OPTS: ListAvailableListingsOpts = {
  redCapable: true,
  scope: 'full',
  floor: 'public',
  viewerBrowsingLevel: 15,
};

type Call = { url: URL; headers: Record<string, string>; timeoutMs: number };
type Reply = (call: Call) => Response | Promise<Response>;

let calls: Call[];
let reply: Reply;
let dbBySlugs: Map<string, ListingCard>;
let dbBySlugsCalls: string[][];
let dbSubListings: Map<string, SubListingCard>;
let dbSubListingsCalls: string[][];
let logs: ShadowLogEntry[];
let config: ReadModelShadowConfig;
let mode: ReadModelMode;
let decoded: DecodedDbCursor;
let dbPage: ListingPage;
let dbPageCalls: number;
let encoded: Array<[string, string, number | undefined]>;

function makeShadow(over: Partial<ListingsShadowDeps> = {}) {
  const deps: ListingsShadowDeps = {
    mode: () => mode,
    config: () => config,
    random: () => 0.5,
    nowMs: () => NOW_MS,
    fetch: async (url, init) => {
      const call = { url: new URL(url), headers: init.headers, timeoutMs: init.timeoutMs };
      calls.push(call);
      return reply(call);
    },
    decodeCursor: () => decoded,
    // Not the database's encoding: a literal shape of this test's own, so the served cursor is
    // visibly the encoder's output.
    encodeCursor: (sortKey, id, mean) => {
      encoded.push([sortKey, id, mean]);
      return `db-cursor(${sortKey}|${id}|${mean ?? 'none'})`;
    },
    dbPage: async () => {
      dbPageCalls++;
      return dbPage;
    },
    dbBySlugs: async (slugs) => {
      dbBySlugsCalls.push(slugs);
      return slugs.flatMap((s) => {
        const c = dbBySlugs.get(s);
        return c ? [c] : [];
      });
    },
    dbSubListingsByIds: async (ids) => {
      dbSubListingsCalls.push(ids);
      return ids.flatMap((id) => {
        const c = dbSubListings.get(id);
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

/**
 * The read model answers `list` for a page and, asked by slug, the `admitted` listings (a slug for
 * that listing's own card, or a card), and asked by sub-listing id, the `admittedSubs` items. As the
 * read model does, an answer with sub-listing cards on says so (`subListings`).
 */
function readModelAnswers(
  list: (ReadModelCard | ReadModelSubListingCard)[],
  nextCursor?: string,
  admitted: (string | ReadModelCard)[] = [],
  admittedSubs: ReadModelSubListingCard[] = []
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
    const subIds = url.searchParams.get('subListingIds');
    if (subIds !== null) {
      const want = new Set(subIds.split(','));
      return Response.json({
        items: admittedSubs.filter((c) => want.has(c.id)),
        subListings: true,
      });
    }
    const marker = url.searchParams.get('subListings') === '1' ? { subListings: true } : {};
    return Response.json(
      nextCursor ? { items: list, nextCursor, ...marker } : { items: list, ...marker }
    );
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
  'app_listings_read_model_serve_requests_total',
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
  dbSubListings = new Map();
  dbSubListingsCalls = [];
  logs = [];
  mode = 'shadow';
  config = {
    url: URL_BASE,
    key: KEY,
    sample: 1,
    maxInFlight: 4,
    timeoutMs: 1000,
    serveTimeoutMs: 250,
  };
  decoded = { cursorSortKey: null, cursorId: null, cursorMean: null };
  dbPage = { items: [] };
  dbPageCalls = 0;
  encoded = [];
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
  it('mode database or serve, or sampled out: nothing is asked and nothing is counted', async () => {
    mode = 'database';
    expect(makeShadow().shadow('grid', INPUT, OPTS, { items: [A] })).toBeUndefined();
    // At serve, a page the database served is one the read model could not serve: not compared.
    mode = 'serve';
    expect(makeShadow().shadow('grid', INPUT, OPTS, { items: [A] })).toBeUndefined();
    mode = 'shadow';
    config.sample = 0.5; // random() is 0.5: not below the rate
    expect(makeShadow().shadow('grid', INPUT, OPTS, { items: [A] })).toBeUndefined();
    expect(calls).toEqual([]);
    expect(await moved()).toEqual([]);
  });

  it('a viewer or page the read model does not answer stays on the database', async () => {
    const shadow = makeShadow();
    shadow.shadow('grid', INPUT, { ...OPTS, floor: 'testers' }, { items: [A] });
    shadow.shadow('grid', INPUT, { ...OPTS, viewerBrowsingLevel: 64 }, { items: [A] });
    shadow.shadow('grid', INPUT, OPTS, { items: [A], search: 'index' });
    config.key = KEY.slice(0, 31);
    shadow.shadow('rest_list', INPUT, OPTS, { items: [A] });
    expect(calls).toEqual([]);
    expect(await moved()).toEqual([
      'shadow_requests_total{grid/unsupported_input}:1',
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
      cursorId: 'apl_01J9Z3',
      cursorMean: 0.625,
    };
    readModelAnswers([rmCard(A)]);
    await makeShadow().shadow('grid', { ...INPUT, cursor: 'db-cursor' }, OPTS, { items: [A] });
    // The literals are the read model's own EncodeCursor output (rank_test.go TestCursorVector).
    expect(calls[0].url.searchParams.get('cursor')).toBe(
      'cm0yHzAwMDAwNzAwMDAwMDAwMDAwMDAwMDAwMDAwMTIwH2FwbF8wMUo5WjMfMC42MjU'
    );
    expect(readModelCursor('paint', 'apl_01J9Z3', null)).toBe('cm0yH3BhaW50H2FwbF8wMUo5WjM');
    // The position is the cursor's id: no database read is needed to name it.
    expect(dbBySlugsCalls).toEqual([]);
  });

  it('🔴 a cursor after a sub-listing card is moved like any other, and so is one after a deleted listing', async () => {
    // The read model reads the item's tie-break from its id (listingread.Rank), as the database does.
    decoded = { cursorSortKey: 'k', cursorId: 'asl_01ARZ3NDEKTSV4RRFFQ69G5FAV', cursorMean: null };
    readModelAnswers([rmCard(A)]);
    await makeShadow().shadow(
      'grid',
      { ...INPUT, cursor: 'db-cursor' },
      { ...OPTS, includeSubListings: true },
      { items: [A] }
    );
    expect(calls).toHaveLength(1);
    // rm2␟k␟asl_01ARZ3NDEKTSV4RRFFQ69G5FAV, base64url.
    expect(calls[0].url.searchParams.get('cursor')).toBe(
      'cm0yH2sfYXNsXzAxQVJaM05ERUtUU1Y0UlJGRlE2OUc1RkFW'
    );
    // The database pages after the deleted row's (sort key, id), and so does the read model.
    decoded = { cursorSortKey: 'k', cursorId: 'apl_gone', cursorMean: null };
    await makeShadow().shadow('grid', { ...INPUT, cursor: 'db-cursor' }, OPTS, { items: [A] });
    expect(calls).toHaveLength(2);
    expect(await moved()).toEqual([
      'compared_slugs_total{grid}:2',
      'shadow_requests_total{grid/compared}:2',
    ]);
  });

  it('🔴 a cursor after a sub-listing card with sub-listings off (the flag turned off between two pages) is moved too', async () => {
    // The read model resumes after the item's key, as the parents-only statement does.
    decoded = { cursorSortKey: 'k', cursorId: 'asl_01ARZ3NDEKTSV4RRFFQ69G5FAV', cursorMean: null };
    readModelAnswers([rmCard(A)]);
    await makeShadow().shadow('grid', { ...INPUT, cursor: 'db-cursor' }, OPTS, { items: [A] });
    expect(calls.map((c) => c.url.searchParams.get('cursor'))).toEqual([
      'cm0yH2sfYXNsXzAxQVJaM05ERUtUU1Y0UlJGRlE2OUc1RkFW',
    ]);
    expect(calls[0].url.searchParams.has('subListings')).toBe(false);
    mode = 'serve';
    config.sample = 0;
    const page = await makeShadow().serve(
      'grid',
      { ...INPUT, cursor: 'db-cursor' },
      OPTS,
      async () => ({ items: [dbCard('database-only')] })
    );
    expect(page.items.map((c) => c.id)).toEqual(['al_alpha']);
    expect(await moved()).toEqual([
      'compared_slugs_total{grid}:1',
      'serve_requests_total{grid/served}:1',
      'shadow_requests_total{grid/compared}:1',
    ]);
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
    [
      'kindData',
      'identity_field',
      { kindData: { kind: 'onsite', appBlockId: 'ab_alpha', hasPage: false, liveUrl: null } },
    ],
    [
      'kindData',
      'identity_field',
      {
        kindData: {
          kind: 'onsite',
          appBlockId: 'ab_other',
          hasPage: true,
          liveUrl: 'https://alpha.apps.invalid',
        },
      },
    ],
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

  it('matched by id: a listing renamed to a new slug is the same listing', async () => {
    readModelAnswers([rmCard(A, { slug: 'alpha-renamed' }), rmCard(B)]);
    await makeShadow().shadow('grid', INPUT, OPTS, { items: [A, B] });
    expect(await moved()).toEqual([
      'compared_slugs_total{grid}:2',
      'shadow_requests_total{grid/compared}:1',
    ]);
    expect(logs).toEqual([]);
  });

  it('🔴 one slug naming another listing id on the read model is an id identity mismatch, never visibility or order', async () => {
    // The database's bravo is al_bravo; the read model's bravo is al_bravo_other.
    readModelAnswers([rmCard(A), rmCard(B, { id: 'al_bravo_other' })]);
    await makeShadow().shadow('grid', INPUT, OPTS, { items: [A, B] });
    expect(await moved()).toEqual([
      'compared_slugs_total{grid}:2',
      'field_mismatches_total{grid/id}:1',
      'mismatches_total{grid/identity_field}:1',
      'shadow_requests_total{grid/compared}:1',
    ]);
    // Neither side was asked about it by slug: it is not a listing on one page only.
    expect(dbBySlugsCalls).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(logs).toEqual([
      {
        surface: 'grid',
        visibilityMissing: [],
        visibilityExtra: [],
        fields: { bravo: ['id'] },
        order: false,
      },
    ]);
  });

  it.each([
    ['a card without an id', { id: undefined }],
    [
      'an on-site card without kindData.appBlockId',
      { kindData: { kind: 'onsite', hasPage: true, liveUrl: 'https://alpha.apps.invalid' } },
    ],
  ] as [string, Record<string, unknown>][])('%s is a bad_response', async (_name, over) => {
    reply = () => Response.json({ items: [{ ...rmCard(A), ...over }] });
    await makeShadow().shadow('grid', INPUT, OPTS, { items: [A] });
    expect(await moved()).toEqual(['shadow_requests_total{grid/bad_response}:1']);
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

  it('a stalled database read is db_timeout, and holds its slot until the read settles', async () => {
    config.timeoutMs = 20;
    config.maxInFlight = 4;
    readModelAnswers([rmCard(A), rmCard(C)]);
    // A breaker that does not open here, so only the in-flight cap is under test.
    const breaker = new IndexBreaker(
      () => ({ threshold: 100, cooldownMs: 60_000 }),
      () => NOW_MS,
      () => undefined
    );
    const settle: Array<() => void> = [];
    const shadow = makeShadow({
      breaker,
      dbBySlugs: () => new Promise<ListingCard[]>((resolve) => settle.push(() => resolve([]))),
    });
    for (let i = 0; i < 4; i++) await shadow.shadow('grid', INPUT, OPTS, { items: [A] });
    // Each of the four timed out, but its database read is still running: its slot is held.
    expect(shadow.inFlight()).toBe(4);
    expect(shadow.shadow('grid', INPUT, OPTS, { items: [A] })).toBeUndefined();
    expect(calls).toHaveLength(4);
    expect(await moved()).toEqual([
      'shadow_requests_total{grid/db_timeout}:4',
      'shadow_requests_total{grid/saturated}:1',
    ]);
    // Once the reads settle, the slots are free.
    for (const s of settle) s();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shadow.inFlight()).toBe(0);
  });

  it('database timeouts open the breaker: no more read-model or database work', async () => {
    config.timeoutMs = 20;
    readModelAnswers([rmCard(A), rmCard(C)]);
    const breaker = new IndexBreaker(
      () => ({ threshold: 2, cooldownMs: 60_000 }),
      () => NOW_MS,
      () => undefined
    );
    let dbReads = 0;
    const shadow = makeShadow({
      breaker,
      dbBySlugs: () => {
        dbReads++;
        return new Promise<ListingCard[]>(() => undefined);
      },
    });
    await shadow.shadow('grid', INPUT, OPTS, { items: [A] });
    await shadow.shadow('grid', INPUT, OPTS, { items: [A] });
    expect(shadow.shadow('grid', INPUT, OPTS, { items: [A] })).toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(dbReads).toBe(2);
    expect(await moved()).toEqual([
      'shadow_requests_total{grid/breaker_open}:1',
      'shadow_requests_total{grid/db_timeout}:2',
    ]);
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
    // A cursor that names no card: returns before any read-model call.
    decoded = { cursorSortKey: 'k', cursorId: '', cursorMean: null };
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shadow.inFlight()).toBe(0);
    expect(calls).toHaveLength(1);
    expect(await moved()).toEqual([
      'compared_slugs_total{grid}:1',
      'shadow_requests_total{grid/compared}:1',
      'shadow_requests_total{grid/saturated}:1',
    ]);
  });
});

describe("the flag's mode", () => {
  /** Flag reads that answer as given, recording which were made. */
  function flagReads(answers: {
    override?: string;
    ready?: boolean;
    variant?: { match: boolean; variantKey: string | null } | null;
  }) {
    const made: string[] = [];
    const reads: ReadModelFlagReads = {
      override: () => (made.push('override'), answers.override),
      ready: () => (made.push('ready'), answers.ready ?? true),
      variant: () => (made.push('variant'), answers.variant ?? null),
    };
    return { reads, made };
  }

  it.each([
    ['serve', 'serve'],
    ['shadow', 'shadow'],
    // Anything else a variant flag answers is the database: an unknown key, a near miss, none.
    ['canary', 'database'],
    ['SERVE', 'database'],
    ['', 'database'],
  ] as const)('a variant flag answering %j is %s', (variantKey, want) => {
    const { reads, made } = flagReads({ variant: { match: true, variantKey } });
    expect(readReadModelMode(reads)).toBe(want);
    expect(made).toEqual(['override', 'ready', 'variant']);
  });

  it('a variant flag that matched no rule (or is disabled) is the database', () => {
    expect(
      readReadModelMode(flagReads({ variant: { match: false, variantKey: null } }).reads)
    ).toBe('database');
  });

  it('absent (or not a variant flag), or Flipt not ready: the database', () => {
    expect(readReadModelMode(flagReads({}).reads)).toBe('database');
    const notReady = flagReads({ ready: false, variant: { match: true, variantKey: 'serve' } });
    expect(readReadModelMode(notReady.reads)).toBe('database');
    expect(notReady.made).toEqual(['override', 'ready']);
  });

  it.each([
    // `on` is not a variant: no boolean reading of this flag exists.
    ['on', 'database'],
    ['shadow', 'shadow'],
    ['serve', 'serve'],
    ['off', 'database'],
    ['bogus', 'database'],
  ] as const)('a local override %j is %s, and nothing else is read', (override, want) => {
    const { reads, made } = flagReads({ override, variant: { match: true, variantKey: 'serve' } });
    expect(readReadModelMode(reads)).toBe(want);
    expect(made).toEqual(['override']);
  });

  it('🔴 a missing (or non-variant) flag reads as the database, and logs nothing', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const requests: unknown[] = [];
    const missing = {
      evaluateVariant: (request: unknown) => {
        requests.push(request);
        throw new Error('flag not found: app-listings-read-model');
      },
    };
    const reads: ReadModelFlagReads = {
      override: () => undefined,
      ready: () => true,
      variant: () => quietVariantRead(missing, 'app-listings-read-model', { surface: 'grid' }),
    };
    expect(readReadModelMode(reads)).toBe('database');
    // The evaluation was made (the guard is reached), for the global entity and the surface.
    expect(requests).toEqual([
      { flagKey: 'app-listings-read-model', entityId: 'global', context: { surface: 'grid' } },
    ]);
    expect(errors).not.toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();
    errors.mockRestore();
    warnings.mockRestore();
  });

  it('positive control: a variant flag answering serve reads as serve through the same read', () => {
    const client = {
      evaluateVariant: () => ({ match: true, variantKey: 'serve' }),
    };
    expect(quietVariantRead(client, 'app-listings-read-model', { surface: 'rest_list' })).toEqual({
      match: true,
      variantKey: 'serve',
    });
    // An unmatched evaluation never names a variant, whatever key the engine carries.
    expect(
      quietVariantRead(
        { evaluateVariant: () => ({ match: false, variantKey: 'serve' }) },
        'app-listings-read-model',
        {}
      )
    ).toEqual({ match: false, variantKey: null });
    expect(quietVariantRead(null, 'app-listings-read-model', {})).toBeNull();
  });

  it('the cached gate reads at most once per window, and a throw is the database', () => {
    let t = 1_000;
    let reads = 0;
    let answer: ReadModelMode | 'throw' = 'serve';
    const gate = createCachedModeGate(
      () => {
        reads++;
        if (answer === 'throw') throw new Error('flipt');
        return answer;
      },
      5_000,
      () => t
    );
    expect(gate()).toBe('serve');
    answer = 'shadow';
    t += 4_999;
    expect(gate()).toBe('serve');
    t += 1;
    expect(gate()).toBe('shadow');
    answer = 'throw';
    t += 5_000;
    expect(gate()).toBe('database');
    expect(reads).toBe(3);
  });
});

describe('serving (mode serve)', () => {
  beforeEach(() => {
    mode = 'serve';
    // No served-page comparison unless a test asks for one.
    config.sample = 0;
  });

  /** A database read that records its calls and answers `page`. */
  function dbReadOf(page: { items: ListingCard[]; nextCursor?: string }) {
    let n = 0;
    const read = async () => {
      n++;
      return page;
    };
    return { read, calls: () => n };
  }
  const DB_SERVED = { items: [dbCard('database-only')], nextCursor: 'db-next' };

  it('mode database or shadow: the database read, and nothing asked of the read model', async () => {
    for (const m of ['database', 'shadow'] as const) {
      mode = m;
      const db = dbReadOf(DB_SERVED);
      readModelAnswers([rmCard(A)]);
      expect(await makeShadow().serve('grid', INPUT, OPTS, db.read)).toBe(DB_SERVED);
      expect(db.calls()).toBe(1);
    }
    expect(calls).toEqual([]);
    expect(await moved()).toEqual([]);
  });

  it('the mode is per surface: one can serve while the other stays on the database', async () => {
    readModelAnswers([rmCard(A)]);
    const asked: string[] = [];
    const shadow = makeShadow({
      mode: (surface) => {
        asked.push(surface);
        return surface === 'grid' ? 'serve' : 'database';
      },
    });
    const db = dbReadOf(DB_SERVED);
    expect(await shadow.serve('rest_list', INPUT, OPTS, db.read)).toBe(DB_SERVED);
    const grid = await shadow.serve('grid', INPUT, OPTS, db.read);
    expect(grid.items.map((c) => c.id)).toEqual(['al_alpha']);
    expect(db.calls()).toBe(1);
    expect(asked).toEqual(['rest_list', 'grid']);
    expect(await moved()).toEqual(['serve_requests_total{grid/served}:1']);
  });

  it("the read model's page, as store cards, with its media as it gated them", async () => {
    // The read model's own gated media, unlike anything the database would answer.
    const card = rmCard(A, {
      iconUrl: 'https://img.invalid/alpha/icon-gated-by-read-model',
      coverUrl: null,
      updatedAt: '2026-04-01T10:20:30.000Z',
    });
    const off = rmCard(dbCard('offsite-x'), {
      kind: 'offsite',
      creator: null,
      isOfficial: true,
      openCount: null,
      updatedAt: undefined,
      kindData: { kind: 'offsite' },
    });
    readModelAnswers([card, off]);
    const db = dbReadOf(DB_SERVED);
    const page = await makeShadow().serve('grid', INPUT, OPTS, db.read);
    expect(db.calls()).toBe(0);
    expect(page).toEqual({
      items: [
        {
          id: 'al_alpha',
          slug: 'alpha',
          kind: 'onsite',
          name: 'Name alpha',
          tagline: 'Tagline alpha',
          category: 'utility',
          contentRating: 'pg',
          iconUrl: 'https://img.invalid/alpha/icon-gated-by-read-model',
          coverUrl: null,
          creator: { id: 42, username: 'maker', image: null },
          recommend: { recommendedCount: 3, notRecommendedCount: 1, recommendPct: 0.75 },
          reviewCount: 4,
          isBeta: false,
          isOfficial: false,
          openCount: 12,
          updatedAt: '2026-04-01T10:20:30.000Z',
          restrictedAudience: null,
          kindData: {
            kind: 'onsite',
            appBlockId: 'ab_alpha',
            hasPage: true,
            liveUrl: 'https://alpha.apps.invalid',
          },
        },
        {
          id: 'al_offsite-x',
          slug: 'offsite-x',
          kind: 'offsite',
          name: 'Name offsite-x',
          tagline: 'Tagline offsite-x',
          category: 'utility',
          contentRating: 'pg',
          iconUrl: 'https://img.invalid/offsite-x/icon',
          coverUrl: 'https://img.invalid/offsite-x/cover',
          creator: null,
          recommend: { recommendedCount: 3, notRecommendedCount: 1, recommendPct: 0.75 },
          reviewCount: 4,
          isBeta: false,
          isOfficial: true,
          openCount: null,
          restrictedAudience: null,
          kindData: { kind: 'offsite', externalUrl: null },
        },
      ],
    });
    expect(await moved()).toEqual(['serve_requests_total{grid/served}:1']);
  });

  it.each([
    // The media ceilings are the read model's (listingread.ProjectMedia), applied to the viewer
    // the token names: it must be the viewer the database read would have gated for.
    [
      'a red-capable host, the viewer level',
      { redCapable: true, viewerBrowsingLevel: 31 },
      'red',
      31,
    ],
    ['the main host, the same level', { redCapable: false, viewerBrowsingLevel: 31 }, 'main', 31],
    [
      'no host or level given: main, PG only',
      { redCapable: undefined, viewerBrowsingLevel: undefined },
      'main',
      0,
    ],
  ] as const)(
    'asked with the database read’s viewer, signed: %s',
    async (_name, over, host, level) => {
      readModelAnswers([rmCard(A)]);
      await makeShadow().serve(
        'rest_list',
        { kind: 'offsite', category: 'utility', sort: 'popular', limit: 7, userId: 42 },
        { ...OPTS, ...over, scope: 'public-external' },
        dbReadOf(DB_SERVED).read
      );
      expect(calls).toHaveLength(1);
      const { url, headers, timeoutMs } = calls[0];
      expect(`${url.origin}${url.pathname}`).toBe('http://read-model.invalid/base/listings');
      expect(Object.fromEntries(url.searchParams)).toEqual({
        sort: 'popular',
        limit: '7',
        kind: 'offsite',
        category: 'utility',
        userId: '42',
      });
      const [, payload] = headers['X-App-Index-Viewer'].split('.');
      expect(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))).toEqual({
        host,
        level,
        scope: 'public-external',
        exp: NOW_MS / 1000 + 60,
      });
      // The serve timeout, not the shadow's.
      expect(timeoutMs).toBe(250);
    }
  );

  it("page 2: the database cursor's position is asked, and the next cursor comes back in the database's format", async () => {
    decoded = {
      cursorSortKey: '00000700000000000000000000120',
      cursorId: 'apl_01J9Z3',
      cursorMean: 0.625,
    };
    // The read model's own EncodeCursor output for (key2, apl_02, mean 0.5).
    const rmNext = Buffer.from('rm2\x1fkey2\x1fapl_02\x1f0.5', 'utf8').toString('base64url');
    readModelAnswers([rmCard(A)], rmNext);
    const page = await makeShadow().serve(
      'grid',
      { ...INPUT, cursor: 'db-cursor' },
      OPTS,
      dbReadOf(DB_SERVED).read
    );
    expect(calls[0].url.searchParams.get('cursor')).toBe(
      'cm0yHzAwMDAwNzAwMDAwMDAwMDAwMDAwMDAwMDAwMTIwH2FwbF8wMUo5WjMfMC42MjU'
    );
    expect(encoded).toEqual([['key2', 'apl_02', 0.5]]);
    expect(page.nextCursor).toBe('db-cursor(key2|apl_02|0.5)');
  });

  it('the read-model cursor format, decoded (the literal is rank_test.go TestCursorVector)', () => {
    expect(
      decodeReadModelCursor('cm0yHzAwMDAwNzAwMDAwMDAwMDAwMDAwMDAwMDAwMTIwH2FwbF8wMUo5WjMfMC42MjU')
    ).toEqual({ sortKey: '00000700000000000000000000120', id: 'apl_01J9Z3', mean: 0.625 });
    expect(decodeReadModelCursor('cm0yH3BhaW50H2FwbF8wMUo5WjM')).toEqual({
      sortKey: 'paint',
      id: 'apl_01J9Z3',
    });
    const enc = (raw: string) => Buffer.from(raw, 'utf8').toString('base64url');
    // Another version, a mean outside [0, 1], no id, too many fields: not a position.
    expect(decodeReadModelCursor(enc('rm1\x1fk\x1fapl_1'))).toBeNull();
    expect(decodeReadModelCursor(enc('v2\x1fk\x1fapl_1'))).toBeNull();
    expect(decodeReadModelCursor(enc('rm2\x1fk\x1fapl_1\x1f1.5'))).toBeNull();
    expect(decodeReadModelCursor(enc('rm2\x1fk\x1fapl_1\x1f'))).toBeNull();
    expect(decodeReadModelCursor(enc('rm2\x1fk\x1f'))).toBeNull();
    expect(decodeReadModelCursor(enc('rm2\x1fk\x1fapl_1\x1f0.5\x1fx'))).toBeNull();
  });

  it.each([
    [
      'a moderator, even at the public floor',
      { viewer: { userId: 7, isModerator: true } },
      'unsupported_viewer',
    ],
    ['a tester floor', { floor: 'testers' }, 'unsupported_viewer'],
    ['a moderator floor', { floor: 'moderators' }, 'unsupported_viewer'],
    ['a level that cannot be signed', { viewerBrowsingLevel: 64 }, 'unsupported_viewer'],
  ] as const)('user-facing only: %s is read from the database', async (_name, over, outcome) => {
    readModelAnswers([rmCard(A)]);
    const db = dbReadOf(DB_SERVED);
    expect(await makeShadow().serve('grid', INPUT, { ...OPTS, ...over }, db.read)).toBe(DB_SERVED);
    expect(db.calls()).toBe(1);
    expect(calls).toEqual([]);
    expect(await moved()).toEqual([`serve_requests_total{grid/${outcome}}:1`]);
  });

  it('positive control: a signed-in, non-moderator viewer at the public floor is served', async () => {
    readModelAnswers([rmCard(A)]);
    const db = dbReadOf(DB_SERVED);
    const page = await makeShadow().serve(
      'grid',
      INPUT,
      { ...OPTS, viewer: { userId: 7, isModerator: false } },
      db.read
    );
    expect(page.items.map((c) => c.id)).toEqual(['al_alpha']);
    expect(db.calls()).toBe(0);
  });

  it('🔴 a crafted cursor with an empty id is refused before the read model and its breaker', async () => {
    let t = NOW_MS;
    let transitions = 0;
    const breaker = new IndexBreaker(
      () => ({ threshold: 1, cooldownMs: 60_000 }),
      () => t,
      () => {
        transitions++;
      }
    );
    decoded = { cursorSortKey: 'k', cursorId: '', cursorMean: null };
    const shadow = makeShadow({ breaker });
    const db = dbReadOf(DB_SERVED);
    for (let i = 0; i < 3; i++) {
      await shadow.serve('grid', { ...INPUT, cursor: 'crafted' }, OPTS, db.read);
    }
    // Shadowed too: refused the same way.
    config.sample = 1;
    await shadow.shadow('grid', { ...INPUT, cursor: 'crafted' }, OPTS, { items: [A] }, 'shadow');
    expect(calls).toEqual([]);
    expect(db.calls()).toBe(3);
    expect(transitions).toBe(0);
    expect(await moved()).toEqual([
      'serve_requests_total{grid/unsupported_input}:3',
      'shadow_requests_total{grid/unsupported_input}:1',
    ]);
    // Positive control: a real position is asked of the read model.
    config.sample = 0;
    t += 1;
    decoded = { cursorSortKey: 'k', cursorId: 'apl_01J9Z3', cursorMean: null };
    readModelAnswers([rmCard(A)]);
    await shadow.serve('grid', { ...INPUT, cursor: 'real' }, OPTS, db.read);
    expect(calls).toHaveLength(1);
  });

  it('the mode is resolved once per request: an explicit mode wins over the flag read', async () => {
    readModelAnswers([rmCard(A)]);
    let reads = 0;
    const shadow = makeShadow({
      mode: () => {
        reads++;
        return 'shadow';
      },
    });
    const db = dbReadOf(DB_SERVED);
    // The request resolved serve; the flag now says shadow (its cache expired in between).
    const page = await shadow.serve('grid', INPUT, OPTS, db.read, 'serve');
    expect(page.items.map((c) => c.id)).toEqual(['al_alpha']);
    // The same request's shadow call sees serve too, so it never compares the page it served.
    expect(shadow.shadow('grid', INPUT, OPTS, page, 'serve')).toBeUndefined();
    expect(reads).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('no usable key: the database', async () => {
    const db = dbReadOf(DB_SERVED);
    config.key = KEY.slice(0, 31);
    await makeShadow().serve('rest_list', INPUT, OPTS, db.read);
    expect(db.calls()).toBe(1);
    expect(calls).toEqual([]);
    expect(await moved()).toEqual(['serve_requests_total{rest_list/unconfigured}:1']);
  });

  it.each([
    [
      'a timeout',
      () => Promise.reject(Object.assign(new Error('t'), { name: 'TimeoutError' })),
      'timeout',
    ],
    ['a connection error', () => Promise.reject(new TypeError('fetch failed')), 'error'],
    ['a 503', () => new Response('{}', { status: 503 }), 'not_ready'],
    ['a 500', () => new Response('{}', { status: 500 }), 'error'],
    ['a body that is not a page', () => Response.json({ results: [] }), 'bad_response'],
    [
      'an on-site card without its live url',
      () =>
        Response.json({
          items: [
            rmCard(A, { kindData: { kind: 'onsite', appBlockId: 'ab_alpha', hasPage: true } }),
          ],
        }),
      'bad_response',
    ],
    [
      'a card whose kind is not its kind data’s',
      () => Response.json({ items: [rmCard(A, { kind: 'offsite' })] }),
      'bad_response',
    ],
    [
      'a next cursor that is not a read-model cursor',
      () => Response.json({ items: [rmCard(A)], nextCursor: 'not-a-cursor' }),
      'bad_response',
    ],
  ] as const)('%s: the database page instead, counted', async (_name, r, outcome) => {
    reply = r;
    const db = dbReadOf(DB_SERVED);
    expect(await makeShadow().serve('rest_list', INPUT, OPTS, db.read)).toBe(DB_SERVED);
    expect(db.calls()).toBe(1);
    expect(await moved()).toEqual([`serve_requests_total{rest_list/${outcome}}:1`]);
  });

  it("the database read's own failure is the request's, as with the flag off", async () => {
    reply = () => new Response('{}', { status: 500 });
    await expect(
      makeShadow().serve('grid', INPUT, OPTS, () => Promise.reject(new Error('db down')))
    ).rejects.toThrow('db down');
  });

  it('a run of failures opens the breaker: the read model is not asked, the database answers', async () => {
    reply = () => new Response('{}', { status: 500 });
    const shadow = makeShadow();
    const db = dbReadOf(DB_SERVED);
    for (let i = 0; i < 3; i++) await shadow.serve('grid', INPUT, OPTS, db.read);
    expect(calls).toHaveLength(2);
    expect(db.calls()).toBe(3);
    expect(await moved()).toEqual([
      'serve_requests_total{grid/breaker_open}:1',
      'serve_requests_total{grid/error}:2',
    ]);
  });

  it('a served answer resets the failure count: failures must be consecutive to open it', async () => {
    const shadow = makeShadow();
    const db = dbReadOf(DB_SERVED);
    reply = () => new Response('{}', { status: 500 });
    await shadow.serve('grid', INPUT, OPTS, db.read);
    readModelAnswers([rmCard(A)]);
    await shadow.serve('grid', INPUT, OPTS, db.read);
    reply = () => new Response('{}', { status: 500 });
    await shadow.serve('grid', INPUT, OPTS, db.read);
    readModelAnswers([rmCard(A)]);
    const page = await shadow.serve('grid', INPUT, OPTS, db.read);
    expect(page.items.map((c) => c.id)).toEqual(['al_alpha']);
    expect(calls).toHaveLength(4);
  });

  describe('a served page compared with the database page', () => {
    beforeEach(() => {
      config.sample = 1;
    });

    it('the same page: compared, nothing differs', async () => {
      readModelAnswers([rmCard(A), rmCard(B)], readModelCursor('k', 'al_bravo', null));
      dbPage = { items: [A, B], nextCursor: 'db-next' };
      const shadow = makeShadow();
      await shadow.serve('grid', INPUT, OPTS, dbReadOf(DB_SERVED).read);
      await shadow.servedComparison();
      expect(dbPageCalls).toBe(1);
      expect(logs).toEqual([]);
      expect(await moved()).toEqual([
        'compared_slugs_total{grid}:2',
        'serve_requests_total{grid/served}:1',
        'shadow_requests_total{grid/compared}:1',
      ]);
    });

    it('a listing the database shows that the read model does not show this viewer: visibility_missing', async () => {
      readModelAnswers([rmCard(A)]);
      dbPage = { items: [A, B] };
      const shadow = makeShadow();
      await shadow.serve('rest_list', INPUT, OPTS, dbReadOf(DB_SERVED).read);
      await shadow.servedComparison();
      // Asked of the read model by slug, which does not admit bravo.
      expect(calls.map((c) => c.url.searchParams.get('slugs'))).toEqual([null, 'bravo']);
      expect(await moved()).toEqual([
        'compared_slugs_total{rest_list}:2',
        'mismatches_total{rest_list/visibility_missing}:1',
        'serve_requests_total{rest_list/served}:1',
        'shadow_requests_total{rest_list/compared}:1',
      ]);
      expect(logs).toEqual([
        {
          surface: 'rest_list',
          visibilityMissing: ['bravo'],
          visibilityExtra: [],
          fields: {},
          order: false,
        },
      ]);
    });

    it("the comparison's database read failing or stalling never touches the served answer or the breaker", async () => {
      config.timeoutMs = 20;
      readModelAnswers([rmCard(A)]);
      const breaker = new IndexBreaker(
        () => ({ threshold: 1, cooldownMs: 60_000 }),
        () => NOW_MS,
        () => undefined
      );
      const failing = makeShadow({ breaker, dbPage: () => Promise.reject(new Error('db down')) });
      const page = await failing.serve('grid', INPUT, OPTS, dbReadOf(DB_SERVED).read);
      expect(page.items.map((c) => c.id)).toEqual(['al_alpha']);
      await failing.servedComparison();
      const stalled = makeShadow({
        breaker,
        dbPage: () => new Promise<ListingPage>(() => undefined),
      });
      await stalled.serve('grid', INPUT, OPTS, dbReadOf(DB_SERVED).read);
      await stalled.servedComparison();
      expect(breaker.allow()).toBe(true);
      expect(await moved()).toEqual([
        'serve_requests_total{grid/served}:2',
        'shadow_requests_total{grid/db_error}:1',
        'shadow_requests_total{grid/db_timeout}:1',
      ]);
    });

    it('sampled out: no comparison, no database read', async () => {
      config.sample = 0;
      readModelAnswers([rmCard(A)]);
      const shadow = makeShadow();
      await shadow.serve('grid', INPUT, OPTS, dbReadOf(DB_SERVED).read);
      expect(shadow.servedComparison()).toBeUndefined();
      expect(dbPageCalls).toBe(0);
    });
  });
});

describe('servedCardOf', () => {
  it('an off-site card with no external url reads null; an on-site one needs hasPage and liveUrl', () => {
    expect(
      servedCardOf(rmCard(dbCard('o'), { kind: 'offsite', kindData: { kind: 'offsite' } }))
        ?.kindData
    ).toEqual({ kind: 'offsite', externalUrl: null });
    expect(
      servedCardOf(
        rmCard(A, { kindData: { kind: 'onsite', appBlockId: null, liveUrl: 'https://x.invalid' } })
      )
    ).toBeNull();
    expect(
      servedCardOf(
        rmCard(A, { kindData: { kind: 'onsite', appBlockId: null, hasPage: false, liveUrl: null } })
      )
    ).toBeNull();
    // Positive control: with both, a native on-site card (no block) is servable.
    expect(
      servedCardOf(
        rmCard(A, {
          kindData: {
            kind: 'onsite',
            appBlockId: null,
            hasPage: false,
            liveUrl: 'https://x.invalid',
          },
        })
      )?.kindData
    ).toEqual({ kind: 'onsite', appBlockId: null, hasPage: false, liveUrl: 'https://x.invalid' });
  });
});

/**
 * Sub-listing cards (LISTINGS-READ-MODEL.md, slice 6): a grid page with them (`includeSubListings`,
 * the `/apps` grid page) is shadowed and served like any other. The read model is asked for them
 * (`subListings=1`) and must say it answered with them; each card is matched by id, named by its id,
 * and counted in the same classes as a listing's.
 */
describe('sub-listing cards (includeSubListings)', () => {
  const SUBS: ListAvailableListingsOpts = { ...OPTS, includeSubListings: true };
  const S1 = dbSub(1);
  const S2 = dbSub(2, { coverUrl: null, runHref: 'https://items.invalid/i/2', external: true });
  const S3 = dbSub(3);

  it('🔴 a page with sub-listing cards is compared, not refused: asked with subListings=1', async () => {
    readModelAnswers([rmCard(A), rmSub(S1), rmSub(S2), rmCard(B)], 'rm-next');
    await makeShadow().shadow('grid', INPUT, SUBS, {
      items: [A, S1, S2, B],
      nextCursor: 'db-next',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url.searchParams.get('subListings')).toBe('1');
    expect(await moved()).toEqual([
      'compared_slugs_total{grid}:4',
      'shadow_requests_total{grid/compared}:1',
    ]);
    expect(logs).toEqual([]);
  });

  it('without includeSubListings the read model is not asked for them', async () => {
    readModelAnswers([rmCard(A)]);
    await makeShadow().shadow('grid', INPUT, OPTS, { items: [A] });
    expect(calls[0].url.searchParams.has('subListings')).toBe(false);
  });

  it('🔴 asked for sub-listing cards, an answer that does not say it has them is a bad_response', async () => {
    reply = () => Response.json({ items: [rmCard(A)] });
    await makeShadow().shadow('grid', INPUT, SUBS, { items: [A, S1] });
    expect(await moved()).toEqual(['shadow_requests_total{grid/bad_response}:1']);
  });

  it.each([
    ['a sub-listing card without a sub-listing id', { id: 'al_alpha_item' }],
    ['a sub-listing card without its link', { runHref: '' }],
    ['a sub-listing card without its parent', { parent: undefined }],
  ] as [string, Record<string, unknown>][])('%s is a bad_response', async (_name, over) => {
    reply = () => Response.json({ items: [{ ...rmSub(S1), ...over }], subListings: true });
    await makeShadow().shadow('grid', INPUT, SUBS, { items: [S1] });
    expect(await moved()).toEqual(['shadow_requests_total{grid/bad_response}:1']);
  });

  // Each field of a sub-listing card counts in its class: media (its cover, its parent's icon) or
  // identity (what it is, who wrote it, where it links). One field differs per case.
  it.each([
    ['coverUrl', 'media', { coverUrl: 'https://img.invalid/items/1/other' }],
    ['parentIconUrl', 'media', { parent: { ...S1.parent, iconUrl: null } }],
    ['name', 'identity_field', { name: 'Other item' }],
    ['tagline', 'identity_field', { tagline: null }],
    ['kind', 'identity_field', { kind: 'offsite' }],
    ['category', 'identity_field', { category: 'games' }],
    ['contentRating', 'identity_field', { contentRating: 'pg13' }],
    ['creator', 'identity_field', { creator: { ...S1.creator, username: 'someone-else' } }],
    ['parent', 'identity_field', { parent: { ...S1.parent, slug: 'alpha-other' } }],
    ['runHref', 'identity_field', { runHref: '/apps/run/alpha/items/other' }],
    ['runHref', 'identity_field', { external: true }],
  ] as [string, string, Partial<ReadModelSubListingCard>][])(
    '%s counts as %s',
    async (field, kind, over) => {
      readModelAnswers([rmSub(S1, over)]);
      await makeShadow().shadow('grid', INPUT, SUBS, { items: [S1] });
      expect(await moved()).toEqual([
        'compared_slugs_total{grid}:1',
        `field_mismatches_total{grid/${field}}:1`,
        `mismatches_total{grid/${kind}}:1`,
        'shadow_requests_total{grid/compared}:1',
      ]);
      // Named by its id: an item has no slug.
      expect(logs[0].fields).toEqual({ [S1.id]: [field] });
    }
  );

  it('one id naming a listing on one side and a sub-listing on the other is an id identity mismatch', async () => {
    const asListing = rmCard(dbCard('alpha', { id: S1.id }));
    readModelAnswers([asListing]);
    await makeShadow().shadow('grid', INPUT, SUBS, { items: [S1] });
    expect(await moved()).toContain('field_mismatches_total{grid/id}:1');
  });

  it('a sub-listing card the database shows that the read model does not show this viewer: visibility_missing, asked by id', async () => {
    readModelAnswers([rmCard(A), rmSub(S1)], undefined, [], []);
    await makeShadow().shadow('grid', { ...INPUT, userId: 42 }, SUBS, { items: [A, S1, S2] });
    // Asked by id, with the developer filter (the id path takes it: it names the parent's owner).
    const byId = calls.find((c) => c.url.searchParams.has('subListingIds'));
    expect(Object.fromEntries(byId!.url.searchParams)).toEqual({
      subListingIds: S2.id,
      userId: '42',
    });
    expect(dbSubListingsCalls).toEqual([]);
    expect(await moved()).toEqual([
      'compared_slugs_total{grid}:3',
      'mismatches_total{grid/visibility_missing}:1',
      'shadow_requests_total{grid/compared}:1',
    ]);
    expect(logs).toEqual([
      {
        surface: 'grid',
        visibilityMissing: [S2.id],
        visibilityExtra: [],
        fields: {},
        order: false,
      },
    ]);
  });

  it('a sub-listing card on the database page only that the read model admits by id: order only', async () => {
    readModelAnswers([rmCard(A), rmSub(S1)], undefined, [], [rmSub(S2)]);
    await makeShadow().shadow('grid', INPUT, SUBS, { items: [A, S1, S2] });
    expect(await moved()).toEqual([
      'compared_slugs_total{grid}:3',
      'order_mismatches_total{grid}:1',
      'shadow_requests_total{grid/compared}:1',
    ]);
  });

  it('a sub-listing card the read model shows that the database does not: visibility_extra, asked of the database by id', async () => {
    readModelAnswers([rmCard(A), rmSub(S1), rmSub(S3)]);
    dbSubListings.set(S1.id, S1);
    await makeShadow().shadow('grid', INPUT, SUBS, { items: [A, S1] });
    expect(dbSubListingsCalls).toEqual([[S3.id]]);
    expect(dbBySlugsCalls).toEqual([]);
    expect(await moved()).toEqual([
      'compared_slugs_total{grid}:3',
      'mismatches_total{grid/visibility_extra}:1',
      'shadow_requests_total{grid/compared}:1',
    ]);
    expect(logs[0]).toMatchObject({ visibilityExtra: [S3.id], order: false });
  });

  it('a listing and a sub-listing on the read-model page only: one database check of each', async () => {
    readModelAnswers([rmCard(A), rmCard(C), rmSub(S3)]);
    dbBySlugs.set('charlie', C);
    dbSubListings.set(S3.id, S3);
    await makeShadow().shadow('grid', INPUT, SUBS, { items: [A] });
    expect([dbBySlugsCalls, dbSubListingsCalls]).toEqual([[['charlie']], [[S3.id]]]);
    // Both shown by the database: a paging difference.
    expect(await moved()).toEqual([
      'compared_slugs_total{grid}:3',
      'order_mismatches_total{grid}:1',
      'shadow_requests_total{grid/compared}:1',
    ]);
  });

  it('🔴 asked by id, an answer that does not say it has sub-listing cards is a bad_response', async () => {
    reply = ({ url }) =>
      url.searchParams.has('subListingIds')
        ? Response.json({ items: [] })
        : Response.json({ items: [rmCard(A)], subListings: true });
    await makeShadow().shadow('grid', INPUT, SUBS, { items: [A, S1] });
    expect(await moved()).toEqual(['shadow_requests_total{grid/bad_response}:1']);
  });

  describe('served (mode serve)', () => {
    beforeEach(() => {
      mode = 'serve';
      config.sample = 0;
    });
    const DB: ListingPage = { items: [dbCard('database-only')] };

    it('🔴 a page with sub-listing cards is served from the read model, each card as the store card', async () => {
      const rmNext = Buffer.from(`rm2\x1fk2\x1f${S2.id}`, 'utf8').toString('base64url');
      readModelAnswers([rmCard(A), rmSub(S1), rmSub(S2)], rmNext);
      let dbReads = 0;
      const page = await makeShadow().serve('grid', INPUT, SUBS, async () => {
        dbReads++;
        return DB;
      });
      expect(dbReads).toBe(0);
      expect(calls[0].url.searchParams.get('subListings')).toBe('1');
      expect(page.items.slice(1)).toEqual([S1, S2]);
      // The next cursor sits on a sub-listing card, in the database's format.
      expect(encoded).toEqual([['k2', S2.id, undefined]]);
      expect(page.nextCursor).toBe(`db-cursor(k2|${S2.id}|none)`);
      expect(await moved()).toEqual(['serve_requests_total{grid/served}:1']);
    });

    it('🔴 a cursor after a sub-listing card is asked of the read model, not refused', async () => {
      decoded = {
        cursorSortKey: 'k',
        cursorId: 'asl_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        cursorMean: null,
      };
      readModelAnswers([rmSub(S3)]);
      const page = await makeShadow().serve(
        'grid',
        { ...INPUT, cursor: 'db-cursor' },
        SUBS,
        async () => DB
      );
      expect(calls[0].url.searchParams.get('cursor')).toBe(
        'cm0yH2sfYXNsXzAxQVJaM05ERUtUU1Y0UlJGRlE2OUc1RkFW'
      );
      expect(page.items).toEqual([S3]);
    });

    it.each([
      [
        'an answer that does not say it has sub-listing cards',
        SUBS,
        () => Response.json({ items: [rmCard(A)] }),
      ],
      [
        'a sub-listing card the request did not ask for',
        OPTS,
        () => Response.json({ items: [rmCard(A), rmSub(S1)] }),
      ],
    ] as const)('🔴 %s: the database page instead', async (_name, opts, r) => {
      reply = r;
      let dbReads = 0;
      const page = await makeShadow().serve('grid', INPUT, opts, async () => {
        dbReads++;
        return DB;
      });
      expect(page).toBe(DB);
      expect(dbReads).toBe(1);
      expect(await moved()).toEqual(['serve_requests_total{grid/bad_response}:1']);
    });

    it('a served page with sub-listing cards is compared with the database page, sub-listing cards included', async () => {
      config.sample = 1;
      readModelAnswers([rmCard(A), rmSub(S1)]);
      dbPage = { items: [A, S1, S2] };
      const shadow = makeShadow();
      await shadow.serve('grid', INPUT, SUBS, async () => DB);
      await shadow.servedComparison();
      expect(await moved()).toEqual([
        'compared_slugs_total{grid}:3',
        'mismatches_total{grid/visibility_missing}:1',
        'serve_requests_total{grid/served}:1',
        'shadow_requests_total{grid/compared}:1',
      ]);
      expect(logs[0]).toMatchObject({ visibilityMissing: [S2.id] });
    });
  });
});
