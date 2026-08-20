import { beforeEach, describe, expect, it, vi } from 'vitest';

// `source` is what the BitDex feed notice keys on: it must name the backend that
// ACTUALLY served the page, not the flag variant. Two ways that diverges:
//   - shadow runs BitDex in the background and serves Meili → must report meili
//   - primary falls through to Meili when BitDex errors → must report meili
// Getting either wrong puts a "we're testing a new system" notice over old-system
// results, so the feedback would describe the wrong backend.
//
// Same minimal-seam mocking as image-feed-clickhouse-failsoft.test.ts: stub the
// event-engine-common submodule + infra clients + env so importing image.service
// doesn't boot real infra.

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
// `metricsSearchClient: null` makes getImagesFromSearchPreFilter return an empty
// page immediately — the Meili leg still RUNS and still stamps source 'meili',
// which is the whole point, without needing a live index.
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
import {
  BITDEX_SERVE_MODES,
  BITDEX_SERVE_OUTCOMES,
  ensureRegisterBitdexFeedServeMetrics,
  type BitdexServeMode,
  type BitdexServeOutcome,
} from '~/server/metrics/bitdex-feed-serve.metrics';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
redisMock.redis.get.mockResolvedValue('[]');
redisMock.redis.set.mockResolvedValue(undefined);

const bitdexDoc = {
  id: 101,
  url: 'abc',
  hash: null,
  nsfwLevel: 1,
  userId: 7,
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
  sortAt: 1_700_000_000,
  publishedAt: 1_700_000_000,
};

// `cursor: undefined` terminates fetchBitdexPrimary's pass loop on the first
// iteration. A fake that always returned a cursor would spin to MAX_PASSES.
const bitdexPage = { documents: [bitdexDoc], cursor: undefined };

const baseInput = {
  limit: 10,
  browsingLevel: 1,
  periodMode: 'published',
  include: [],
  currentUserId: undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ImageSearchInput isn't exported
} as any;

const CURRENT_USER_ID = 42;

/**
 * Both BitDex passes go through the same `queryBitdex`, so a fake has to tell
 * them apart from their arguments or it answers the same thing to both and every
 * assertion keyed on the difference is meaningless.
 *
 * The main pass filters availability with `Not(Eq(availability, Private))`; the
 * own-content pass asks for the OPPOSITE inside an `Or`. Keying on that `Or`
 * distinguishes them STRUCTURALLY rather than by call order or argument
 * position, both of which are incidental and would silently stop discriminating
 * if the parallel pass were reordered. Same discriminator as
 * `bitdex-empty-fallback.test.ts`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw BitDex filter clauses
type Clause = any;
function isOwnExcludedQuery(filters: unknown): boolean {
  if (!Array.isArray(filters)) return false;
  return filters.some(
    (clause: Clause) =>
      Array.isArray(clause?.Or) &&
      clause.Or.some(
        (member: Clause) =>
          Array.isArray(member?.Eq) &&
          member.Eq[0] === 'availability' &&
          member.Eq[1]?.String === 'Private'
      )
  );
}

describe('getImagesFromSearch — reported source names the backend that served the page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryBitdexMock.mockResolvedValue(bitdexPage);
  });

  it('reports meili in SHADOW mode even though BitDex ran and returned documents', async () => {
    getFliptVariantMock.mockResolvedValue('shadow');

    const result = await getImagesFromSearch(baseInput);

    expect(result.source).toBe('meili');
  });

  it('reports bitdex in PRIMARY mode when BitDex serves the page', async () => {
    getFliptVariantMock.mockResolvedValue('primary');

    const result = await getImagesFromSearch(baseInput);

    expect(result.source).toBe('bitdex');
  });

  it('reports meili in PRIMARY mode when BitDex throws and Meili serves the fallback', async () => {
    getFliptVariantMock.mockResolvedValue('primary');
    queryBitdexMock.mockRejectedValue(new Error('bitdex is down'));

    const result = await getImagesFromSearch(baseInput);

    expect(result.source).toBe('meili');
  });
});

/**
 * 🔴 POSITIVE CONTROL FOR `bitdex_primary_result_total` (#3930).
 *
 * The whole value of this counter is that a ZERO on `outcome="fallback_error"`
 * can be believed. A counter that is never incremented reads zero too, and the
 * two are indistinguishable from a dashboard — so a zero is worthless until
 * something has been watched to move.
 *
 * Every case below asserts on the DELTA and asserts that EXACTLY ONE series
 * moved, naming which. Two properties fall out of that shape:
 *   - an emit line deleted anywhere makes the corresponding case fail on the
 *     COUNTER's assertion (0 series moved), not on the `source` assertion in the
 *     sibling describe above — the pre-existing assertion would still pass, and
 *     a green-for-the-wrong-reason is exactly what this control has to exclude;
 *   - the labels cannot be swapped, transposed, or collapsed onto one series
 *     without a different case going red, because a different one is named in
 *     each.
 *
 * 🔴 On the "BitDex throws" arm in the describe above: it drives a path
 * PRODUCTION CANNOT REACH. `queryBitdex` documents that it never throws and
 * returns `null` on every failure, so the mock replacing it with a rejection is
 * exercising the application-error arm (`fallback_exception`), not a BitDex
 * outage. The reachable version of a BitDex outage is a `null` return WITH the
 * failure callback invoked, which is what the `fallback_error` case below
 * drives — through the collector, the way the client actually reports it.
 */
type OutcomeSnapshot = Record<string, number>;

async function readOutcomes(): Promise<OutcomeSnapshot> {
  const { primaryResultTotal } = ensureRegisterBitdexFeedServeMetrics();
  const { values } = await (
    primaryResultTotal as unknown as {
      get(): Promise<{ values: Array<{ labels: Record<string, string>; value: number }> }>;
    }
  ).get();
  // Every combination pre-populated at 0, derived from the unions rather than
  // listed: a series that is absent and a series that is zero must compare
  // equal here, or the delta below would report "moved" for a first-ever emit
  // on some other test's behalf.
  const snapshot: OutcomeSnapshot = {};
  for (const outcome of BITDEX_SERVE_OUTCOMES)
    for (const mode of BITDEX_SERVE_MODES) snapshot[`${outcome}|${mode}`] = 0;
  for (const v of values) snapshot[`${v.labels.outcome}|${v.labels.mode}`] = v.value;
  return snapshot;
}

function seriesThatMoved(before: OutcomeSnapshot, after: OutcomeSnapshot): string[] {
  return Object.keys(after)
    .filter((key) => (after[key] ?? 0) !== (before[key] ?? 0))
    .sort();
}

const key = (outcome: BitdexServeOutcome, mode: BitdexServeMode) => `${outcome}|${mode}`;

describe('bitdex_primary_result_total moves, and moves a DIFFERENT series per outcome', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryBitdexMock.mockResolvedValue(bitdexPage);
  });

  it('PRIMARY, BitDex answers with documents → served{mode="primary"} +1, and nothing else', async () => {
    getFliptVariantMock.mockResolvedValue('primary');
    const before = await readOutcomes();

    const result = await getImagesFromSearch(baseInput);

    const after = await readOutcomes();
    expect(result.source).toBe('bitdex');
    expect(seriesThatMoved(before, after)).toEqual([key('served', 'primary')]);
    expect(after[key('served', 'primary')] - before[key('served', 'primary')]).toBe(1);
  });

  it('PRIMARY, every call SUCCEEDS but the index has nothing → fallback_empty{mode="primary"} +1', async () => {
    getFliptVariantMock.mockResolvedValue('primary');
    // A successful, genuinely empty page: no failure callback is invoked.
    queryBitdexMock.mockResolvedValue({ documents: [], cursor: undefined });
    const before = await readOutcomes();

    const result = await getImagesFromSearch(baseInput);

    const after = await readOutcomes();
    expect(result.source).toBe('meili');
    expect(seriesThatMoved(before, after)).toEqual([key('fallback_empty', 'primary')]);
  });

  it('🔴 PRIMARY, a call FAILS and the result is empty → fallback_error{mode="primary"} +1, NOT fallback_empty', async () => {
    getFliptVariantMock.mockResolvedValue('primary');
    // The reachable shape of a BitDex outage: the client returns `null` — it
    // never throws — and reports the classification through the callback it was
    // handed. Driven through the collector rather than asserted on the mock, so
    // this fails if the service stops passing the callback down.
    queryBitdexMock.mockImplementation(async (...args: unknown[]) => {
      const onFailure = args.find((a) => typeof a === 'function') as
        | ((reason: string) => void)
        | undefined;
      onFailure?.('http_5xx');
      return null;
    });
    const before = await readOutcomes();

    const result = await getImagesFromSearch(baseInput);

    const after = await readOutcomes();
    expect(result.source).toBe('meili');
    expect(seriesThatMoved(before, after)).toEqual([key('fallback_error', 'primary')]);
  });

  it('PRIMARY, the application itself throws → fallback_exception{mode="primary"} +1', async () => {
    getFliptVariantMock.mockResolvedValue('primary');
    queryBitdexMock.mockRejectedValue(new Error('bitdex is down'));
    const before = await readOutcomes();

    const result = await getImagesFromSearch(baseInput);

    const after = await readOutcomes();
    expect(result.source).toBe('meili');
    expect(seriesThatMoved(before, after)).toEqual([key('fallback_exception', 'primary')]);
  });

  /**
   * 🔴 THE SEAM THE OTHER CASES CANNOT REACH, AND THE REASON THEY CANNOT.
   *
   * Every case above runs ANONYMOUSLY (`currentUserId: undefined`), which makes
   * `skipOwnExcluded` true — so the parallel own-content pass is NEVER ISSUED and
   * exactly one BitDex call happens per request. With one call in play, "any call
   * in this request failed" and "the main call failed" are byte-identical in
   * behaviour, so the whole justification for the per-request predicate sat
   * unexercised and a mutant that stopped threading the callback into the
   * own-content pass survived a fully green run. Fixture collapse: the fixture
   * could not distinguish the two implementations because it only ever built one
   * of the two states.
   *
   * This case builds the state that separates them: a SIGNED-IN caller, whose
   * own-content pass FAILS while the main pass succeeds and legitimately returns
   * nothing. The main call reports no failure at all — so an implementation that
   * only watched the main call would record `fallback_empty` and declare the page
   * genuinely empty, when the documents that would have filled it are exactly the
   * ones the failed call was fetching.
   */
  it('🔴 PRIMARY, signed-in, the OWN-CONTENT pass fails while the main pass is empty → fallback_error', async () => {
    getFliptVariantMock.mockResolvedValue('primary');

    // Two INDEPENDENTLY-RECORDED ledgers: which passes ran, and which passes
    // actually reported a failure. An earlier revision derived the second from
    // the first (`failed: ownExcluded`), which made the "the main pass did not
    // fail" assertion below restate its own fixture instead of observing
    // anything. `reportedFailure` is now pushed from INSIDE the branch that
    // invokes the callback, so it records what happened rather than what was
    // intended.
    const callsRun: Array<{ ownExcluded: boolean }> = [];
    const reportedFailure: Array<{ ownExcluded: boolean }> = [];
    queryBitdexMock.mockImplementation(async (...args: unknown[]) => {
      const ownExcluded = isOwnExcludedQuery(args[1]);
      const onFailure = args.find((a) => typeof a === 'function') as
        | ((reason: string) => void)
        | undefined;
      callsRun.push({ ownExcluded });
      if (ownExcluded) {
        // Only the own-content pass fails. The main pass below succeeds.
        reportedFailure.push({ ownExcluded });
        onFailure?.('http_5xx');
        return null;
      }
      return { documents: [], cursor: undefined };
    });

    const before = await readOutcomes();
    const result = await getImagesFromSearch({ ...baseInput, currentUserId: CURRENT_USER_ID });
    const after = await readOutcomes();

    // The fixture is only meaningful if BOTH passes actually ran and only the
    // own-content one failed — assert the state was built before reading the
    // conclusion off it, or a silently-skipped second pass would make this case
    // pass for the same reason the anonymous ones do.
    expect(callsRun.filter((c) => c.ownExcluded)).toHaveLength(1);
    expect(callsRun.filter((c) => !c.ownExcluded).length).toBeGreaterThanOrEqual(1);
    // Exactly one failure was reported, and it came from the own-content pass —
    // observed, not restated. If the main pass had also failed, `fallback_error`
    // would be reachable without the own-content seam and the case would prove
    // nothing.
    expect(reportedFailure).toEqual([{ ownExcluded: true }]);

    expect(result.source).toBe('meili');
    expect(seriesThatMoved(before, after)).toEqual([key('fallback_error', 'primary')]);
  });

  /**
   * The denominator this counter's help string claims — "requests that issued at
   * least one query" — has to be true of the code, not just of the sentence.
   * `limit: 0` is externally reachable (the feed schema accepts `min(0)`) and
   * collapses the pass loop before its first iteration; anonymously, the
   * own-content pass is skipped too, so BitDex is never contacted. The empty
   * result must NOT be recorded as a fallback, or the served ratio a rollout
   * decision reads is biased downward by requests that asked BitDex nothing.
   */
  it('🔴 PRIMARY with limit 0 issues NO BitDex query, so nothing is recorded', async () => {
    getFliptVariantMock.mockResolvedValue('primary');
    const before = await readOutcomes();

    const result = await getImagesFromSearch({ ...baseInput, limit: 0 });

    const after = await readOutcomes();
    // Positive control on the premise: this asserts the zero-query state was
    // actually built. Without it, "no series moved" would also be satisfied by a
    // counter that had simply stopped working.
    expect(queryBitdexMock).not.toHaveBeenCalled();
    expect(result.source).toBe('meili');
    expect(seriesThatMoved(before, after)).toEqual([]);
  });

  /**
   * 🔴 THE SAME DEFECT ONE DOOR DOWN — FOR AN ANONYMOUS CALLER.
   *
   * `limit: 0` is not the only way to reach the empty-result guard without
   * contacting BitDex. `getImagesFromBitdexPreFilter` has FIVE early
   * `return null` paths that never reach the client at all: `hidden` with no
   * signed-in user, `hidden` with no hidden images, an unresolvable username,
   * followed-with-zero-follows, and newCreators-with-none. A guard that counted
   * LOOP ENTRY rather than evidence of an actual call over-counted all of them.
   *
   * ⚠️ READ THE SCOPE FROM THE PREDICATE, NOT FROM A SENTENCE. Two revisions of
   * this comment glossed it and both were refuted by measurement. The exclusion
   * holds exactly when `skipOwnExcluded` (image.service.ts, declared beside the
   * own-content pass) is true, i.e. one of: anonymous caller; a `bdx:` cursor;
   * or `creatorScopeExcludesCaller` — the request is scoped to a set of creators
   * that does not contain the caller. A NON-`bdx:` cursor does NOT qualify — and
   * that is the common case, since a request that fell back to Meilisearch carries
   * a Meilisearch cursor on its next page.
   *
   * 🔴 THE THIRD DISJUNCT USED TO READ "signed-in caller viewing another user's
   * profile", AND #4123 REPLACED IT. That wording described only the single-
   * `userId` case and was silent on the set-shaped ones (`followed`,
   * `newCreators`). This was the THIRD copy of that enumeration in the repo and
   * the last to be corrected — the other two are in image.service.ts and
   * src/server/metrics/bitdex-feed-serve.metrics.ts. Of those, only
   * image.service.ts points readers at THIS file as the pin; the metrics module
   * points at the `skipOwnExcluded` symbol instead. Reference the predicate by
   * SYMBOL when updating it again.
   *
   * This case drives an ANONYMOUS caller, which is the disjunct that makes the
   * exclusion apply — so on its own it flatters the claim. The sibling case below
   * pins a request where a call DOES go out, and the two together are what stop
   * this drifting back into an absolute.
   *
   * Anonymous `hidden` is the cleanest of the five doors to drive — it returns at
   * the first line of that block with no database round trip.
   */
  it('🔴 PRIMARY where the query builder returns early issues NO BitDex query, so nothing is recorded', async () => {
    getFliptVariantMock.mockResolvedValue('primary');
    const before = await readOutcomes();

    // Anonymous + `hidden` → `if (!currentUserId) return null` before any client
    // call. Anonymous also skips the own-content pass, so the request contacts
    // BitDex exactly zero times.
    const result = await getImagesFromSearch({ ...baseInput, hidden: true });

    const after = await readOutcomes();
    expect(queryBitdexMock).not.toHaveBeenCalled();
    expect(result.source).toBe('meili');
    expect(seriesThatMoved(before, after)).toEqual([]);
  });

  /**
   * 🔴 THE CASE THAT REFUTES THE ABSOLUTE VERSION OF THE CLAIM ABOVE, PINNED SO
   * IT CANNOT BE RE-ASSERTED.
   *
   * A signed-in caller whose `hidden` feed has no hidden images: the FEED query
   * returns early inside the builder and never reaches the client — but no
   * disjunct of `skipOwnExcluded` holds here, so the own-content pass IS issued,
   * completes, and counts. One call went out, so the request is recorded as
   * `fallback_empty`.
   *
   * That is defensible under the stated denominator — "requests that ENGAGED the
   * backend" — and it is deliberately NOT changed. What was wrong was the claim
   * that all five doors are excluded: `currentUserId` is a PRECONDITION of two of
   * them, so for those two the exclusion can never apply at all.
   *
   * 🔴 THIS CASE USED TO BE DRIVEN BY followed-with-zero-follows, AND #4123 MOVED
   * IT HERE. That fix makes the own-content pass conditional on the request's
   * CREATOR SCOPE containing the caller, so a Following feed with zero follows now
   * issues zero calls and records nothing — it joined the other doors instead of
   * being the one that leaked a call. `hidden` is not a creator scope, so this
   * door is untouched by that change and still drives the state this case needs.
   *
   * 🔴 Retargeted rather than deleted BECAUSE it is the ONLY killing case for
   * `if (ownExcluded) bitdexCallsObserved++` — the third observation site, which
   * has no other mutation killing it. Rewriting the followed case to expect zero
   * calls and stopping there would have left that line untested while every suite
   * stayed green. Delete that line and this case goes red, because the request
   * then looks like it made no calls at all.
   */
  it('🔴 PRIMARY, signed-in, hidden-with-no-hidden-images: the own-content pass still counts', async () => {
    getFliptVariantMock.mockResolvedValue('primary');
    queryBitdexMock.mockResolvedValue({ documents: [], cursor: undefined });
    // The door: signed in, so the `!currentUserId` line does not fire, and the
    // hidden-image lookup comes back empty so the builder returns null after it.
    dbMock.dbRead.imageEngagement.findMany.mockResolvedValue([]);
    const before = await readOutcomes();

    const result = await getImagesFromSearch({
      ...baseInput,
      currentUserId: CURRENT_USER_ID,
      hidden: true,
    });

    const after = await readOutcomes();
    // The state this case exists to build: exactly ONE call went out, and it was
    // the own-content pass — the feed query returned early inside the builder.
    // Asserting the shape, not just the count, so a fixture that accidentally
    // issued a feed query could not satisfy it.
    expect(queryBitdexMock.mock.calls).toHaveLength(1);
    expect(isOwnExcludedQuery(queryBitdexMock.mock.calls[0][1])).toBe(true);

    expect(result.source).toBe('meili');
    expect(seriesThatMoved(before, after)).toEqual([key('fallback_empty', 'primary')]);
  });

  /**
   * The counterpart, and the reason the case above had to move: after #4123 a
   * Following feed with zero follows makes NO BitDex call at all, so it records
   * nothing. The caller's creator scope is the empty set, which does not contain
   * them, so the own-content pass is not issued.
   *
   * This is a REDUCTION in what `fallback_empty` counts, and it is deliberate —
   * the request never engaged the backend, so counting it overstated the fallback
   * population. ⚠️ It also shifts the served-ratio baseline, exactly as #4122 did.
   * Do not compare that ratio across this change.
   */
  it('🔴 PRIMARY, signed-in, followed-with-zero-follows: no call goes out, so nothing is recorded', async () => {
    getFliptVariantMock.mockResolvedValue('primary');
    queryBitdexMock.mockResolvedValue({ documents: [], cursor: undefined });
    const before = await readOutcomes();

    const result = await getImagesFromSearch({
      ...baseInput,
      currentUserId: CURRENT_USER_ID,
      followed: true,
    });

    const after = await readOutcomes();
    expect(queryBitdexMock).not.toHaveBeenCalled();
    expect(result.source).toBe('meili');
    expect(seriesThatMoved(before, after)).toEqual([]);
  });

  it('SHADOW, BitDex answers with documents → served{mode="shadow"} +1 (Meili still serves the user)', async () => {
    getFliptVariantMock.mockResolvedValue('shadow');
    const before = await readOutcomes();

    const result = await getImagesFromSearch(baseInput);
    expect(result.source).toBe('meili');

    // Shadow work is deliberately detached and outlives the user-facing return,
    // so the emit lands after the awaited call resolves. Waiting is the only
    // honest read; a bare read here would be a race that passes by luck.
    await vi.waitFor(async () => {
      const after = await readOutcomes();
      expect(seriesThatMoved(before, after)).toEqual([key('served', 'shadow')]);
    });
  });
});

/**
 * The publication rule on the BitDex leg, asserted at the DISPATCHER.
 *
 * 🔴 These belong here rather than beside the Meili filter-string tests, and the
 * reason is the bug that produced them. `publishedOnly` was added to both Meili
 * filter builders and tested there by a `describe.each` over a hand-authored
 * list of two — and a hand-authored list cannot report a member it does not
 * have. The BitDex leg was the member it did not have, so the picker that
 * started all this still served a moderator their own drafts while the tests
 * stayed green.
 *
 * `getImagesFromSearch` is the one place that enumerates the backends, so a test
 * parameterised over the FLAG (a closed set the dispatcher already switches on)
 * fails when a fourth leg arrives, where a test parameterised over a list of
 * functions cannot.
 *
 * The subject has to change with it: BitDex applies this rule as a post-filter
 * over fetched documents and emits no filter clause at all, so a filter-string
 * assertion is structurally incapable of seeing it. These assert on the rows
 * that came back, which every backend has to produce.
 */
describe('publishedOnly is honoured on every backend, not only the ones with a filter string', () => {
  const unpublishedOwnDoc = { ...bitdexDoc, id: 909, userId: CURRENT_USER_ID, publishedAt: null };

  const moderatorPickerInput = {
    ...baseInput,
    currentUserId: CURRENT_USER_ID,
    userId: CURRENT_USER_ID,
    isModerator: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getFliptVariantMock.mockResolvedValue('primary');
    // The own-content pass is the door the drafts came in by; the main pass is
    // already published-only for everyone and is not what this is about.
    queryBitdexMock.mockImplementation((_index: unknown, filters: unknown) =>
      Promise.resolve(
        isOwnExcludedQuery(filters)
          ? { documents: [unpublishedOwnDoc], cursor: undefined }
          : { documents: [], cursor: undefined }
      )
    );
  });

  it('does not hand a publishedOnly caller their own unpublished row', async () => {
    const result = await getImagesFromSearch({ ...moderatorPickerInput, publishedOnly: true });

    expect(result.data.map((row: { id: number }) => row.id)).not.toContain(unpublishedOwnDoc.id);
  });

  it('still merges a moderator own unpublished row when they did not ask for published only', async () => {
    // The control, and it is load-bearing twice over: without it the assertion
    // above passes against a build where the own-content pass returns nothing at
    // all, and it pins the deliberate moderator carve-out that the fix narrows
    // rather than removes.
    const result = await getImagesFromSearch(moderatorPickerInput);

    expect(result.data.map((row: { id: number }) => row.id)).toContain(unpublishedOwnDoc.id);
  });
});
