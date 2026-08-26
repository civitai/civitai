import { beforeEach, describe, expect, it, vi } from 'vitest';

// Scheduled content must not be served before its publish time.
//
// The publication decision on this path is carried by a single index flag, so
// the post-filter is what keeps a document with a not-yet-arrived publish time
// out of the feed.
//
// The case worth pinning is the RESCHEDULE one, exercised below: `sortAt` holds
// the new future schedule while `publishedAt` still holds an earlier value the
// post was moved off. A guard that only inspected `publishedAt` would pass it,
// so the fixture deliberately uses that combination.
//
// Same minimal-seam mocking as bitdex-feed-source.test.ts: stub the
// event-engine-common submodule + infra clients + env so importing
// image.service doesn't boot real infra.

import type * as BitdexClient from '~/server/bitdex/client';
import type * as FliptClient from '~/server/flipt/client';
import type * as MeiliClient from '~/server/meilisearch/client';

const { queryBitdexMock, getFliptVariantMock } = vi.hoisted(() => ({
  queryBitdexMock: vi.fn(),
  getFliptVariantMock: vi.fn(),
}));

vi.mock('../../../../event-engine-common/feeds', () => ({
  ImagesFeed: class {
    populatedQuery = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

vi.mock('~/env/server', () => ({
  env: new Proxy({ LOGGING: [] as string[] } as Record<string, unknown>, {
    get: (target, prop) => {
      if (prop in target) return target[prop as string];
      if (typeof prop === 'string' && (prop.endsWith('_URL') || prop.endsWith('_ENDPOINT')))
        return 'https://test:test@localhost:5432/test';
      if (
        typeof prop === 'string' &&
        /(_CONCURRENCY|_LIMIT|_MS|_PORT|_TIMEOUT|_MAX|_SIZE|_COUNT)$/.test(prop)
      )
        return 1;
      return undefined;
    },
  }),
}));

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/meilisearch/client', async (importOriginal) => ({
  ...(await importOriginal<typeof MeiliClient>()),
  metricsSearchClient: null,
}));

vi.mock('~/server/bitdex/client', async (importOriginal) => ({
  ...(await importOriginal<typeof BitdexClient>()),
  queryBitdex: queryBitdexMock,
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  getFliptVariant: getFliptVariantMock,
  getFliptBoolean: vi.fn().mockResolvedValue(false),
}));

import { getImagesFromSearch } from '../image.service';
import { redisMock } from '~/__tests__/mocks/redis.mock';
redisMock.redis.get.mockResolvedValue('[]');
redisMock.redis.set.mockResolvedValue(undefined);

const OWNER_ID = 7;
const nowSec = () => Math.floor(Date.now() / 1000);

const baseDoc = {
  url: 'abc',
  hash: null,
  nsfwLevel: 1,
  userId: OWNER_ID,
  type: 'image',
  availability: 'Public',
  postId: 55,
  postedToId: null,
  hasMeta: true,
  onSite: true,
  poi: false,
  minor: false,
  width: 100,
  height: 100,
  reactionCount: 0,
  commentCount: 0,
  collectedCount: 0,
};

/** Genuinely published: both timestamps in the past. */
const publishedDoc = {
  ...baseDoc,
  id: 101,
  publishedAt: nowSec() - 3600,
  sortAt: nowSec() - 3600,
};

/**
 * Rescheduled: `sortAt` a day out, while `publishedAt` still carries the
 * earlier schedule the post was moved off.
 */
const rescheduledDoc = {
  ...baseDoc,
  id: 202,
  publishedAt: nowSec() - 3600,
  sortAt: nowSec() + 86_400,
};

/** Scheduled outright: publish time itself is in the future. */
const scheduledDoc = {
  ...baseDoc,
  id: 303,
  publishedAt: nowSec() + 86_400,
  sortAt: nowSec() + 86_400,
};

/**
 * Published, but dropped by an ORDINARY filter rather than the publication one.
 * Used to prove the emptied-page allowance is not handed to every empty page.
 */
const privateDoc = {
  ...baseDoc,
  id: 505,
  availability: 'Private',
  publishedAt: nowSec() - 3600,
  sortAt: nowSec() - 3600,
};

/**
 * Never published — a draft. `sortAt` is in the PAST (it falls back to
 * `existedAt`), so the future-schedule half of the test does not catch this one;
 * only the null check does.
 */
const neverPublishedDoc = {
  ...baseDoc,
  id: 404,
  publishedAt: null,
  sortAt: nowSec() - 3600,
};

// `cursor: undefined` terminates fetchBitdexPrimary's pass loop on the first
// iteration. A fake that always returned a cursor would spin to MAX_PASSES.
const page = (documents: unknown[]) => ({ documents, cursor: undefined });

/**
 * Distinguish the two BitDex passes STRUCTURALLY rather than by call order.
 *
 * Both go through the same `queryBitdex`, so a mock keyed on order answers
 * whichever pass happens to run first — and if that assumption ever breaks, a
 * test keyed on it keeps passing while testing nothing. The main pass filters
 * availability with `Not(Eq(availability, Private))`; the own-excluded pass
 * asks for the opposite inside an `Or`. Keying on that `Or` cannot drift.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw BitDex filter clauses
type Clause = any;
function isOwnExcludedQuery(filters: unknown): boolean {
  if (!Array.isArray(filters)) return false;
  return filters.some(
    (clause: Clause) =>
      Array.isArray(clause?.Or) &&
      clause.Or.some(
        (member: Clause) => Array.isArray(member?.Eq) && member.Eq[0] === 'availability'
      )
  );
}

const baseInput = {
  limit: 10,
  browsingLevel: 1,
  periodMode: 'published',
  include: [],
  currentUserId: undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ImageSearchInput isn't exported
} as any;

describe('BitDex primary feed — content is not served before its publish time', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getFliptVariantMock.mockResolvedValue('primary');
  });

  it('drops a RESCHEDULED document (future sortAt, past publishedAt) for an anonymous viewer', async () => {
    queryBitdexMock.mockResolvedValue(page([publishedDoc, rescheduledDoc]));

    const result = await getImagesFromSearch(baseInput);
    const ids = result.data.map((i: { id: number }) => i.id);

    // Named ids, so a regression reads as "202 was served" rather than a count.
    expect(ids).toContain(101);
    expect(ids).not.toContain(202);
  });

  it('drops a document whose publishedAt itself is in the future', async () => {
    queryBitdexMock.mockResolvedValue(page([publishedDoc, scheduledDoc]));

    const result = await getImagesFromSearch(baseInput);
    const ids = result.data.map((i: { id: number }) => i.id);

    expect(ids).toContain(101);
    expect(ids).not.toContain(303);
  });

  it('paginates past pages the guard empties instead of starving the request', async () => {
    // The documents this guard drops sort FIRST (a future publish time is a high
    // `sortAt`), so they arrive contiguously at the head of the feed. If each
    // wholly-dropped page were charged against MAX_PASSES (3), a big enough
    // cluster would make every pass return nothing, `data` would be empty, and
    // the request would fall through to Meili on a page BitDex could serve.
    //
    // Three emptied pages is one more than the pass budget can absorb, so this
    // fails on a build that counts them.
    let call = 0;
    queryBitdexMock.mockImplementation(async () => {
      call++;
      return call <= 3
        ? { documents: [rescheduledDoc], cursor: { slot_id: call, sort_value: call } }
        : { documents: [publishedDoc], cursor: undefined };
    });

    const result = await getImagesFromSearch(baseInput);
    const ids = result.data.map((i: { id: number }) => i.id);

    expect(ids).toContain(101);
    expect(ids).not.toContain(202);
  });

  it('does NOT grant the extra pages to a page emptied by an ordinary filter', async () => {
    // The allowance exists because the publication guard drops a contiguous
    // cluster at the HEAD of the sort, so the next page is likely different. An
    // ordinary filter that happens to empty a page — a private-heavy or
    // poi-heavy slice — has no such property, and paying 5 extra full
    // `includeDocs` fetches on the feed hot path for it is a latency regression
    // that buys nothing.
    //
    // Every page here is emptied by the Private check, not the publication one,
    // so the loop should spend its 3 passes and stop — not 8.
    const FAKE_PAGE_CAP = 50;
    let calls = 0;
    queryBitdexMock.mockImplementation(async () => {
      calls++;
      if (calls > FAKE_PAGE_CAP) return { documents: [], cursor: undefined };
      return { documents: [privateDoc], cursor: { slot_id: calls, sort_value: calls } };
    });

    await getImagesFromSearch(baseInput);

    expect(calls).toBe(3);
  });

  it('does NOT grant the extra pages to a MIXED page with a single publication hold', async () => {
    // The all-Private test above passes whether the condition is "one doc was a
    // publication hold" or "every doc was". This one separates them: a page of
    // Private documents plus ONE scheduled document is an ordinary-filter page
    // that happens to contain a publication hold, and it must not buy the
    // allowance.
    const FAKE_PAGE_CAP = 50;
    let calls = 0;
    queryBitdexMock.mockImplementation(async () => {
      calls++;
      if (calls > FAKE_PAGE_CAP) return { documents: [], cursor: undefined };
      return {
        documents: [privateDoc, privateDoc, rescheduledDoc],
        cursor: { slot_id: calls, sort_value: calls },
      };
    });

    await getImagesFromSearch(baseInput);

    expect(calls).toBe(3);
  });

  // The owner and moderator cases below match the Meilisearch rule: strict
  // published-only by default for everyone, lifted only when the caller opts in
  // with `scheduled`/`notPublished`. Without that, a creator's own scheduled
  // post sits ABOVE every live image on their feed until it publishes, because
  // a not-yet-arrived publish time is a high `sortAt`.
  //
  // All three route the mock by the SHAPE of the filters, not by call order —
  // the sibling bitdex-empty-fallback.test.ts does the same, for the same
  // reason. Keying on order would leave a test passing if the doc arrived via
  // the own-excluded merge, which bypasses postFilterBitdexDocs entirely, so it
  // could never fail.
  const routeByShape = () =>
    queryBitdexMock.mockImplementation(async (_index: string, filters: unknown) =>
      isOwnExcludedQuery(filters) ? page([]) : page([publishedDoc, rescheduledDoc])
    );

  it('holds back the creator’s OWN scheduled work by default', async () => {
    routeByShape();

    const result = await getImagesFromSearch({ ...baseInput, currentUserId: OWNER_ID });
    const ids = result.data.map((i: { id: number }) => i.id);

    expect(ids).toContain(101);
    expect(ids).not.toContain(202);
  });

  it('shows the creator their own scheduled work when they opt in with `scheduled`', async () => {
    routeByShape();

    const result = await getImagesFromSearch({
      ...baseInput,
      currentUserId: OWNER_ID,
      scheduled: true,
    });
    const ids = result.data.map((i: { id: number }) => i.id);

    expect(ids).toContain(202);
  });

  it('holds scheduled work back from a moderator’s ordinary feed too', async () => {
    routeByShape();

    // A different account, so this tests the moderator rule and not the owner
    // carve-out — Meili's moderator branch keeps `OR userId = me`.
    const result = await getImagesFromSearch({
      ...baseInput,
      currentUserId: OWNER_ID + 1,
      isModerator: true,
    });
    const ids = result.data.map((i: { id: number }) => i.id);

    expect(ids).toContain(101);
    expect(ids).not.toContain(202);
  });

  // A moderator's scheduled queue is a request BitDex cannot answer: its query
  // pushes `isPublished = true`, so the scheduled population is not in the result
  // to be narrowed down to, and what comes back is the ordinary published feed.
  //
  // Two wrong ways to handle that, both tried in earlier revisions of this PR:
  // serve the published feed (the moderator opens the scheduled queue and sees
  // live content), or narrow it in the post-filter (the main pass goes
  // near-empty while the own-excluded merge stays populated, so BitDex serves the
  // moderator only their OWN content as the "scheduled queue"). Both are
  // non-empty results, and a non-empty result SUPPRESSES the Meili fallback that
  // answers this correctly.
  //
  // So it declines instead. `source: 'meili'` is the assertion — the request was
  // handed to the backend that can answer it.
  it('declines a moderator’s `scheduled` request so Meili answers it', async () => {
    routeByShape();

    const result = await getImagesFromSearch({
      ...baseInput,
      currentUserId: OWNER_ID + 1,
      isModerator: true,
      scheduled: true,
    });

    expect(result.source).toBe('meili');
    // Not the published feed dressed up as the scheduled queue.
    expect(result.data.map((i: { id: number }) => i.id)).not.toContain(101);
  });

  it('declines a CREATOR’s own-drafts request so Meili answers it', async () => {
    // The Draft toggle on the profile images/videos tabs sends `notPublished`
    // from a non-moderator. `wantsUnpublished` reads `scheduled` alone for a
    // non-moderator, so without the decline BitDex answers a drafts request with
    // the PUBLISHED feed — and a non-empty result suppresses the Meili fallback,
    // so the creator is shown a population that is not the one they asked for,
    // with nothing signalling it.
    //
    // Scoped: `userId === currentUserId`. The decline sits AFTER the
    // username→userId resolution, so a request addressed by handle reaches it
    // with a resolved id rather than `undefined`.
    routeByShape();

    const result = await getImagesFromSearch({
      ...baseInput,
      currentUserId: OWNER_ID,
      userId: OWNER_ID,
      isModerator: false,
      notPublished: true,
    });

    expect(result.source).toBe('meili');
    // Asserted on the MOCK, not on `data`. `data` is `[]` by construction whenever
    // source is meili — this file stubs `metricsSearchClient: null` and the Meili
    // builders early-return an empty page — so a `not.toContain(101)` here could
    // never fail. It read as proof that BitDex had not answered with the published
    // feed and proved nothing.
    //
    // The mock also separates the two ways source can be 'meili': the decline
    // firing (no BitDex query at all) versus BitDex throwing and falling through.
    expect(queryBitdexMock).not.toHaveBeenCalled();
  });

  it('declines when the creator is addressed by USERNAME rather than id', async () => {
    // 🔴 The decline sits AFTER the username→userId resolution precisely so this
    // works. Every other case here passes `userId` explicitly, so the check reads
    // the same value at either position and none of them can tell whether the
    // placement is right. Move the block above the resolution and only this case
    // fails — which matters because the profile page addresses creators by handle.
    routeByShape();

    const result = await getImagesFromSearch({
      ...baseInput,
      currentUserId: OWNER_ID,
      username: 'owner-handle',
      isModerator: false,
      notPublished: true,
    });

    expect(result.source).toBe('meili');
    expect(queryBitdexMock).not.toHaveBeenCalled();
  });

  it('does NOT decline a non-moderator asking about SOMEONE ELSE', async () => {
    // The control. Without it the test above passes against a build that declines
    // every `notPublished` request from anyone, which would quietly route an
    // unauthorized request to Meili instead of refusing it — and would make the
    // decline look like authorization, which it is not. The filter builders are
    // what refuse; this only chooses which backend answers.
    routeByShape();

    const result = await getImagesFromSearch({
      ...baseInput,
      currentUserId: OWNER_ID + 99,
      userId: OWNER_ID,
      isModerator: false,
      notPublished: true,
    });

    expect(result.source).toBe('bitdex');
    expect(queryBitdexMock).toHaveBeenCalled();
  });

  it('declines a moderator’s `notPublished` request so Meili answers it', async () => {
    // Same class as `scheduled`. BitDex's query pushes `isPublished = false`,
    // which covers scheduled AND never-published with no separate signal, so it
    // returns a superset seeded with scheduled posts where Meili answers
    // never-published only. A non-empty superset suppresses the fallback.
    routeByShape();

    const result = await getImagesFromSearch({
      ...baseInput,
      currentUserId: OWNER_ID + 1,
      isModerator: true,
      notPublished: true,
    });

    expect(result.source).toBe('meili');
  });

  it('still grants the allowance when the scheduled cluster contains a private doc', async () => {
    // `Private`/`blockedFor`/`acceptableMinor`/`poi` are tested BEFORE the
    // publication check, so those documents never increment the hold count.
    // Requiring EVERY doc on the page to be a publication hold would therefore
    // let one private image inside a scheduled cluster deny the allowance and
    // restore the starvation it exists to prevent.
    //
    // 2 of 3 held for publication, 1 private → still the cluster, still allowed.
    const FAKE_PAGE_CAP = 50;
    let calls = 0;
    queryBitdexMock.mockImplementation(async (_index: string, filters: unknown) => {
      if (isOwnExcludedQuery(filters)) return page([]);
      calls++;
      if (calls > FAKE_PAGE_CAP) return { documents: [], cursor: undefined };
      return calls <= 4
        ? {
            documents: [rescheduledDoc, scheduledDoc, privateDoc],
            cursor: { slot_id: calls, sort_value: calls },
          }
        : { documents: [publishedDoc], cursor: undefined };
    });

    const result = await getImagesFromSearch(baseInput);

    // Reached page 5 and served it: without the allowance the loop would have
    // spent its 3 passes on the cluster and returned nothing.
    expect(result.data.map((i: { id: number }) => i.id)).toContain(101);
  });

  it('keeps a moderator’s own unpublished content arriving via the own-excluded pass', async () => {
    // The main post-filter keeps `OR userId = me` for moderators. If the merge
    // path applied the publication rule unconditionally, the same document would
    // be served through one door and dropped through the other.
    queryBitdexMock.mockImplementation(async (_index: string, filters: unknown) =>
      isOwnExcludedQuery(filters) ? page([rescheduledDoc]) : page([publishedDoc])
    );

    const result = await getImagesFromSearch({
      ...baseInput,
      currentUserId: OWNER_ID,
      isModerator: true,
    });
    const ids = result.data.map((i: { id: number }) => i.id);

    expect(ids).toContain(202);
  });

  it('does not treat `notPublished` as an opt-in for a non-moderator', async () => {
    // Meili's non-moderator branch honours `scheduled` and ignores
    // `notPublished`. Accepting it here would make the two backends answer the
    // same input differently, and the difference would land in the shadow
    // comparator with nothing to attribute it to.
    routeByShape();

    const result = await getImagesFromSearch({
      ...baseInput,
      currentUserId: OWNER_ID,
      notPublished: true,
    });
    const ids = result.data.map((i: { id: number }) => i.id);

    expect(ids).toContain(101);
    expect(ids).not.toContain(202);
  });

  // A never-published draft is a DIFFERENT failure from a scheduled post, and
  // the two below exist because splitting the publication test in half is how
  // the owner and moderator branches came to enforce only the scheduled one.
  // `neverPublishedDoc` has a PAST `sortAt`, so nothing but the null check can
  // catch it.
  it('holds back the creator’s own NEVER-published draft by default', async () => {
    queryBitdexMock.mockImplementation(async (_index: string, filters: unknown) =>
      isOwnExcludedQuery(filters) ? page([]) : page([publishedDoc, neverPublishedDoc])
    );

    const result = await getImagesFromSearch({ ...baseInput, currentUserId: OWNER_ID });
    const ids = result.data.map((i: { id: number }) => i.id);

    expect(ids).toContain(101);
    expect(ids).not.toContain(404);
  });

  it('holds a never-published draft back from a moderator’s ordinary feed', async () => {
    queryBitdexMock.mockImplementation(async (_index: string, filters: unknown) =>
      isOwnExcludedQuery(filters) ? page([]) : page([publishedDoc, neverPublishedDoc])
    );

    const result = await getImagesFromSearch({
      ...baseInput,
      currentUserId: OWNER_ID + 1,
      isModerator: true,
    });
    const ids = result.data.map((i: { id: number }) => i.id);

    expect(ids).toContain(101);
    expect(ids).not.toContain(404);
  });

  it('applies the publication rule to the own-excluded second pass as well', async () => {
    // 🔴 The door the rule was NOT checking. This pass asks for
    // `nsfwLevel=0 OR availability=Private OR blockedFor IN (…)`, and
    // `nsfwLevel = 0` is the ordinary state of a freshly-uploaded, unscanned
    // image — so a creator's just-scheduled upload matches on the nsfw0 arm
    // alone, with no `isPublished=false` clause needed. Its documents are merged
    // straight into the result without going through postFilterBitdexDocs, and
    // its future `sortAt` sorts it to position 1 of the creator's own feed.
    //
    // Note the routing is INVERTED from the tests above: the scheduled doc is
    // returned by the own-excluded pass, so it can only reach the caller through
    // the merge. Every other test stubs that pass empty and therefore cannot
    // catch this.
    queryBitdexMock.mockImplementation(async (_index: string, filters: unknown) =>
      isOwnExcludedQuery(filters) ? page([rescheduledDoc]) : page([publishedDoc])
    );

    const result = await getImagesFromSearch({ ...baseInput, currentUserId: OWNER_ID });
    const ids = result.data.map((i: { id: number }) => i.id);

    expect(ids).toContain(101);
    expect(ids).not.toContain(202);
  });

  it('still merges own excluded content through that pass when opted in', async () => {
    // Positive control for the test above: same routing, `scheduled` set. If the
    // merge filter were unconditional rather than gated on the opt-in, this
    // would fail — so the previous test cannot be passing merely because the
    // merge path is broken.
    queryBitdexMock.mockImplementation(async (_index: string, filters: unknown) =>
      isOwnExcludedQuery(filters) ? page([rescheduledDoc]) : page([publishedDoc])
    );

    const result = await getImagesFromSearch({
      ...baseInput,
      currentUserId: OWNER_ID,
      scheduled: true,
    });
    const ids = result.data.map((i: { id: number }) => i.id);

    expect(ids).toContain(202);
  });

  it('opting in with `scheduled` surfaces scheduled work and STILL holds back drafts', async () => {
    // ClickUp 868kt9y1w, BitDex half. `scheduled` sets `wantsUnpublished`, which
    // skips the publication guard on this merge entirely — so a creator who asked
    // for their scheduled posts also received every never-published draft they own.
    // Same symptom the Meili builders had.
    //
    // Both docs arrive through the own-excluded pass together, which is the point:
    // the opt-in has to separate them rather than admit or refuse the pair. 202 is
    // scheduled (future `sortAt`), 404 is a draft (`publishedAt: null`).
    queryBitdexMock.mockImplementation(async (_index: string, filters: unknown) =>
      isOwnExcludedQuery(filters) ? page([rescheduledDoc, neverPublishedDoc]) : page([publishedDoc])
    );

    const result = await getImagesFromSearch({
      ...baseInput,
      currentUserId: OWNER_ID,
      scheduled: true,
    });
    const ids = result.data.map((i: { id: number }) => i.id);

    // Asserted on IDs rather than a count: `getInfinite({ids})` is known to drop
    // its ids and return the global feed, so a count here could pass against a
    // result that is not this query's at all.
    expect(ids).toContain(101);
    expect(ids).toContain(202);
    expect(ids).not.toContain(404);
  });

  it('a moderator’s own-excluded merge is unchanged by that rule', async () => {
    // The control. The fix is scoped to non-moderators — a moderator's `scheduled`
    // request is declined outright so Meili answers it (see the tests above), and
    // their own unpublished content still arrives through this pass. Without this,
    // narrowing the moderator branch too would keep the test above green while
    // silently changing what #4148 deliberately built.
    queryBitdexMock.mockImplementation(async (_index: string, filters: unknown) =>
      isOwnExcludedQuery(filters) ? page([neverPublishedDoc]) : page([publishedDoc])
    );

    const result = await getImagesFromSearch({
      ...baseInput,
      currentUserId: OWNER_ID,
      isModerator: true,
    });
    const ids = result.data.map((i: { id: number }) => i.id);

    expect(ids).toContain(404);
  });

  it('stops skipping emptied pages at the bound instead of walking forever', async () => {
    // The pagination test above proves the ALLOWANCE; this proves the BOUND.
    // Without it, deleting the `emptiedPages < MAX_EMPTIED_PAGES` condition
    // leaves that test green, because its mock stops issuing cursors after the
    // third page. Here the cursor stream keeps going, so the consumer has to be
    // the thing that stops.
    //
    // The fake terminates itself at 50 pages even so. An endless one would leave
    // a build with both bounds removed spinning on already-resolved promises —
    // a pure microtask loop that starves the macrotask queue, so vitest's
    // setTimeout-based timeout never fires and CI hangs with nothing to read.
    // Self-terminating turns that into `expected 51 to be 8` in under a second.
    // (This is what `local-rules/no-unbounded-paging-fake` exists to catch, and
    // it caught this test.)
    const FAKE_PAGE_CAP = 50;
    let calls = 0;
    queryBitdexMock.mockImplementation(async () => {
      calls++;
      if (calls > FAKE_PAGE_CAP) return { documents: [], cursor: undefined };
      return { documents: [rescheduledDoc], cursor: { slot_id: calls, sort_value: calls } };
    });

    const result = await getImagesFromSearch(baseInput);

    // 5 skipped pages + 3 charged passes = 8 fetches, then it gives up and falls
    // through to Meili with nothing of its own.
    //
    // UPPER bound only. The allowance is also bounded by EMPTIED_PAGE_BUDGET_MS
    // measured from the start of the loop, so on a stalled worker the budget can
    // elapse during the FIRST iteration — every emptied page is then charged as
    // a pass and the loop exits at 3 fetches. A lower bound would fail there,
    // reporting the machine rather than the code.
    //
    // The bound under test is the upper one: anything at or below 8 means a
    // bound held, and a build with both bounds removed reaches the fake's 51.
    expect(calls).toBeLessThanOrEqual(8);
    expect(result.data.map((i: { id: number }) => i.id)).not.toContain(202);
  });
});
