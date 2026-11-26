import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { SemanticAuditEntry } from '~/server/services/semantic-search-audit.service';
import type { CandidateSource, GuardRead } from '~/server/services/semantic-search-client';
import type { SessionUser } from '~/types/session';

/** The keys a semantic search procedure may hand the browser, besides the router's latencyMs. */
const PAGE_KEYS = ['items', 'nextCursor', 'correctedQuery', 'refused'];

export const AUDIT_VIEWER = { id: 77, isModerator: false } as SessionUser;

type Run = (args: {
  source: CandidateSource;
  user?: SessionUser;
  cursor?: number;
}) => Promise<{ items: { id: number }[] }>;

/**
 * The audit contract every semantic search service keeps, run against that service's own test
 * harness. `ids` must be ids the harness hydrates for AUDIT_VIEWER; `narrowToMinor` and `refuse`
 * set the harness's word audit to a minor verdict and to a real-people refusal. A refusal hands the audit its
 * deferred run as the second argument of `recorded`.
 */
export function describeSemanticAuditContract({
  index,
  run,
  ids,
  recorded,
  narrowToMinor,
  refuse,
  ownCache = false,
}: {
  index: SemanticAuditEntry['index'];
  run: Run;
  ids: number[];
  recorded: Mock;
  narrowToMinor: () => void;
  refuse: () => void;
  /** The service wraps the source in its own candidate cache, which sets `cacheHit` itself. */
  ownCache?: boolean;
}) {
  const source =
    (
      guard: (GuardRead & { refused?: boolean }) | undefined,
      served = ids,
      extra: Partial<Awaited<ReturnType<CandidateSource>>> = {}
    ): CandidateSource =>
    async ({ offset, limit }) => ({ ids: served.slice(offset, offset + limit), guard, ...extra });
  const shadowFlag: GuardRead = {
    outcome: 'flag',
    rules: ['block:rule_a'],
    mode: 'shadow',
    version: 'v1',
  };
  const enforceFlag = { ...shadowFlag, mode: 'enforce', refused: true as const };
  const entry = () => recorded.mock.calls.at(-1)?.[0] as SemanticAuditEntry | undefined;
  beforeEach(() => recorded.mockClear());

  describe(`${index}: the guard's verdict never reaches a non-moderator`, () => {
    it.each([
      ['shadow', source(shadowFlag)],
      ['enforce', source(enforceFlag, [])],
    ])('in %s mode, the response carries no guard, rule or verdict', async (_, src) => {
      const result = await run({ source: src, user: AUDIT_VIEWER });
      expect(Object.keys(result).filter((k) => !PAGE_KEYS.includes(k))).toEqual([]);
      expect(JSON.stringify(result)).not.toMatch(/rule_a|guard|bypass|verdict/i);
    });
  });

  // One search per test: the harnesses' fixtures and candidate caches outlive a search.
  describe(`${index}: a refused page`, () => {
    const pass: GuardRead = { outcome: 'pass', rules: [], mode: 'enforce', version: 'v1' };
    const MOD = { ...AUDIT_VIEWER, isModerator: true } as SessionUser;
    // What every service answers when nothing matched, besides the mark.
    const NO_MATCH = { items: [], nextCursor: undefined, correctedQuery: undefined };
    const minusRefused = (page: object) => {
      const { refused, ...rest } = page as { refused?: unknown };
      return rest;
    };

    it('marks a page with no matches as not refused', async () => {
      expect(await run({ source: source(pass, []), user: AUDIT_VIEWER })).toEqual({
        ...NO_MATCH,
        refused: false,
      });
    });

    it('marks a page with matches as not refused', async () => {
      const page = await run({ source: source(pass), user: AUDIT_VIEWER });
      expect(page.items.length).toBeGreaterThan(0);
      expect(page).toMatchObject({ refused: false });
    });

    it.each([
      ['by the word audit', () => (refuse(), source(pass))],
      ['by the search service', () => source(enforceFlag, [])],
    ])('is, %s, a no-match page plus `refused` for a non-moderator', async (_, setup) => {
      const refused = await run({ source: setup(), user: AUDIT_VIEWER });
      expect(refused).toMatchObject({ refused: true });
      expect(minusRefused(refused)).toEqual(NO_MATCH);
      expect(Object.hasOwn(refused, 'refusedBy')).toBe(false);
    });

    it("names the search service's check to a moderator", async () => {
      expect(await run({ source: source(enforceFlag, []), user: MOD })).toMatchObject({
        refused: true,
        refusedBy: 'query guard',
      });
    });

    it("names the word audit's check to a moderator", async () => {
      refuse();
      const page = await run({ source: source(pass), user: MOD });
      expect(page).toMatchObject({ refused: true });
      // Every harness's `refuse` is a real-people verdict.
      expect(page).toMatchObject({ refusedBy: 'real people' });
    });

    it('names a guard that could not complete as fail-closed, not as a verdict', async () => {
      const failed = { ...enforceFlag, outcome: 'unavailable' as const, rules: [] };
      expect(await run({ source: source(failed, []), user: MOD })).toMatchObject({
        refused: true,
        refusedBy: 'error',
      });
    });

    // The candidate cache holds the search service's answer; the mark is put on after it, per viewer.
    it.runIf(ownCache)(
      "serves a non-moderator no refusedBy after a moderator's search filled the cache",
      async () => {
        const src = vi.fn(source(enforceFlag, []));
        expect(await run({ source: src, user: MOD })).toMatchObject({ refusedBy: 'query guard' });
        const page = await run({ source: src, user: AUDIT_VIEWER });
        expect(page).toMatchObject({ refused: true });
        expect(Object.hasOwn(page, 'refusedBy')).toBe(false);
      }
    );

    it('names nothing on a moderator page that was not refused', async () => {
      const page = await run({ source: source(pass), user: MOD });
      expect(page).toMatchObject({ refused: false });
      expect(Object.hasOwn(page, 'refusedBy')).toBe(false);
    });
  });

  describe(`${index}: one audit row per first-page search`, () => {
    it("records the viewer, the guard's verdict and what was served", async () => {
      const result = await run({ source: source(shadowFlag), user: AUDIT_VIEWER });
      expect(result.items.length).toBeGreaterThan(0);
      expect(recorded).toHaveBeenCalledTimes(1);
      expect(entry()).toMatchObject({
        index,
        viewer: { id: AUDIT_VIEWER.id, isModerator: false },
        wordVerdict: false,
        withholdIds: false,
        guard: { outcome: 'flag', rules: ['block:rule_a'], mode: 'shadow' },
        cacheHit: false,
        searchPath: 'served',
        resultIds: result.items.map((x) => x.id),
      });
    });

    it('records what a narrowed minor search served', async () => {
      narrowToMinor();
      const result = await run({ source: source(shadowFlag), user: AUDIT_VIEWER });
      expect(result.items.length).toBeGreaterThan(0);
      expect(entry()).toMatchObject({
        wordVerdict: 'minor',
        withholdIds: false,
        searchPath: 'narrowed',
        resultIds: result.items.map((x) => x.id),
      });
    });

    it('records a refused search, with no guard verdict and nothing served', async () => {
      refuse();
      const result = await run({ source: source(shadowFlag), user: AUDIT_VIEWER });
      expect(result.items).toEqual([]);
      expect(entry()?.wordVerdict).toBeTruthy();
      expect(entry()).toMatchObject({
        guard: { outcome: 'none' },
        resultIds: [],
        resultsServed: true,
        searchPath: 'refused_query',
      });
    });

    it('hands the audit a run of the refused search that it may make later', async () => {
      refuse();
      const src = vi.fn(source(shadowFlag));
      await run({ source: src, user: AUDIT_VIEWER });
      expect(src).not.toHaveBeenCalled();
      const compute = recorded.mock.calls.at(-1)?.[1] as () => Promise<{ ids: number[] }>;
      expect((await compute()).ids).toEqual(ids);
      expect(src).toHaveBeenCalledTimes(1);
    });

    // A cache-wrapped service's hit is pinned in semantic-candidate-cache.test.ts.
    it.skipIf(ownCache)('records a hit on the candidate cache', async () => {
      await run({ source: source(shadowFlag, ids, { cacheHit: true }), user: AUDIT_VIEWER });
      expect(entry()?.cacheHit).toBe(true);
    });

    it('records a search the service sent no guard result for as unknown', async () => {
      await run({ source: source(undefined), user: AUDIT_VIEWER });
      expect(entry()?.guard).toMatchObject({ outcome: 'unknown', rules: [] });
    });

    it('records nothing for a later page', async () => {
      await run({ source: source(shadowFlag), user: AUDIT_VIEWER, cursor: 1 });
      expect(recorded).not.toHaveBeenCalled();
    });
  });
}
