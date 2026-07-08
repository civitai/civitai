import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import superjson from 'superjson';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __getTrpcBatchingEnabled,
  CACHEABLE_PROCEDURES,
  isLargeQuery,
  isTooLargeToBatch,
  queryRetry,
  setTrpcBatchingEnabled,
  shouldBatch,
} from '~/utils/trpc';

/**
 * Unit coverage for the tRPC batching split decision (`shouldBatch`) that the
 * `splitLink` terminating link uses to route a query to `httpBatchStreamLink`
 * (batch) vs the unbatched large-query-aware link. The link objects themselves
 * are tRPC internals; the branch SELECTION is the behaviour we own, so we test
 * the predicate directly. Plus a durable guard keeping `CACHEABLE_PROCEDURES` in
 * sync with the routers.
 */

// tRPC operations only need these fields for `shouldBatch`.
type Op = { type: string; path: string; input: unknown; context: Record<string, unknown> };
const op = (over: Partial<Op> = {}): Op => ({
  type: 'query',
  path: 'model.getInfinite', // a non-edge-cacheable authed feed query (safe to batch)
  input: { limit: 5 },
  context: {},
  ...over,
});

const setWindowAuthed = (isAuthed: boolean | undefined) => {
  (globalThis as any).window = isAuthed === undefined ? {} : { isAuthed };
};
const clearWindow = () => {
  delete (globalThis as any).window;
};

beforeEach(() => {
  setTrpcBatchingEnabled(false);
  clearWindow();
});
afterEach(() => {
  setTrpcBatchingEnabled(false);
  clearWindow();
});

describe('setTrpcBatchingEnabled', () => {
  it('defaults OFF and toggles the module flag', () => {
    expect(__getTrpcBatchingEnabled()).toBe(false); // dark by default
    setTrpcBatchingEnabled(true);
    expect(__getTrpcBatchingEnabled()).toBe(true);
    setTrpcBatchingEnabled(false);
    expect(__getTrpcBatchingEnabled()).toBe(false);
  });
});

describe('shouldBatch', () => {
  it('batches an authed-browser small query when the flag is on', () => {
    setTrpcBatchingEnabled(true);
    setWindowAuthed(true);
    expect(shouldBatch(op())).toBe(true);
  });

  it('does NOT batch when the flag is off (dark default), even if authed', () => {
    setTrpcBatchingEnabled(false);
    setWindowAuthed(true);
    expect(shouldBatch(op())).toBe(false);
  });

  it('does NOT batch anonymous traffic (preserves CF edge-cache for anon GETs)', () => {
    setTrpcBatchingEnabled(true);
    setWindowAuthed(false);
    expect(shouldBatch(op())).toBe(false);
  });

  it('does NOT batch when window.isAuthed is unknown/undefined (early hydration is safe)', () => {
    setTrpcBatchingEnabled(true);
    setWindowAuthed(undefined); // window exists but isAuthed not yet set
    expect(shouldBatch(op())).toBe(false);
  });

  it('does NOT batch on the server (no window)', () => {
    setTrpcBatchingEnabled(true);
    clearWindow();
    expect(shouldBatch(op())).toBe(false);
  });

  it('does NOT batch a procedure that is edge-cacheable for authed sessions', () => {
    setTrpcBatchingEnabled(true);
    setWindowAuthed(true);
    // `model.getAll` applies `edgeCacheIt` and does NOT opt out for authed, so it emits a
    // cacheable response for logged-in users — batching would append `?batch=1` and lose
    // the CF edge-hit. Must stay unbatched.
    expect(CACHEABLE_PROCEDURES.has('model.getAll')).toBe(true);
    expect(shouldBatch(op({ path: 'model.getAll' }))).toBe(false);
  });

  it('DOES batch a non-cacheable authed query on the same router', () => {
    setTrpcBatchingEnabled(true);
    setWindowAuthed(true);
    // `model.getInfinite` is NOT edge-cached → safe to batch (sanity that the exclusion is
    // path-scoped, not router-scoped).
    expect(CACHEABLE_PROCEDURES.has('model.getInfinite')).toBe(false);
    expect(shouldBatch(op({ path: 'model.getInfinite' }))).toBe(true);
  });

  it('honors the skipBatch context escape hatch', () => {
    setTrpcBatchingEnabled(true);
    setWindowAuthed(true);
    expect(shouldBatch(op({ context: { skipBatch: true } }))).toBe(false);
  });

  it('does NOT batch mutations (they stay standalone / keep the POST path)', () => {
    setTrpcBatchingEnabled(true);
    setWindowAuthed(true);
    expect(shouldBatch(op({ type: 'mutation' }))).toBe(false);
  });

  it('does NOT batch large queries (they go out as POST methodOverride, body-carried)', () => {
    setTrpcBatchingEnabled(true);
    setWindowAuthed(true);
    // input encodes to > URL_INPUT_BUDGET => large => unbatched
    expect(shouldBatch(op({ input: { q: 'x'.repeat(3000) } }))).toBe(false);
  });

  it('still batches a query whose input is just under the large-query threshold', () => {
    setTrpcBatchingEnabled(true);
    setWindowAuthed(true);
    expect(shouldBatch(op({ input: { q: 'x'.repeat(100) } }))).toBe(true);
  });
});

/**
 * Regression guard for the batched-GET URL overflow (#2962). The batch link caps the whole
 * request URL at `maxURLLength: 2083` and tRPC throws "Input is too big for a single
 * dispatch" if ONE operation alone exceeds it. `shouldBatch` must therefore NEVER keep a
 * query batched whose single-op batched URL would cross 2083 — otherwise a power user
 * stacking LoRAs on the generator's `whatIf` cost query crashes.
 *
 * The original fix used a raw-JSON-char threshold with a ~1.4× encoding assumption; the
 * real ratio is ~1.75–1.9× for punctuation-dense JSON, which left a ~12–14-resource crash
 * band still batched-but-overflowing. `isTooLargeToBatch` (the batch-exclusion gate) now
 * measures the ACTUAL encoded wire cost, so we assert the end-to-end invariant against a
 * tRPC-faithful URL model — raising the budget too high would fail this test.
 */
describe('shouldBatch never keeps a URL-overflowing query batched (#2962)', () => {
  const BATCH_MAX_URL_LENGTH = 2083; // must match `maxURLLength` on httpBatchStreamLink
  const whatIfPath = 'orchestrator.whatIfFromGraph';

  // The single-op batched GET URL tRPC builds: `/api/trpc/<path>?batch=1&input=<enc {0: serialized}>`.
  const batchedUrlLength = (path: string, input: unknown) =>
    `/api/trpc/${path}?batch=1&input=`.length +
    encodeURIComponent(JSON.stringify({ 0: superjson.serialize(input) })).length;

  // A whatIf-shaped payload: a checkpoint + N LoRA resources (minimal post-filter shape,
  // i.e. trainedWords already stripped by `filterSnapshotForSubmit`).
  const whatIfInput = (loraCount: number) => ({
    resources: [
      { id: 1288280, baseModel: 'Illustrious', model: { type: 'Checkpoint' }, strength: 1 },
      ...Array.from({ length: loraCount }, (_, i) => ({
        id: 1200000 + i,
        baseModel: 'Illustrious',
        model: { type: 'LORA' },
        strength: 1,
      })),
    ],
  });

  beforeEach(() => {
    setTrpcBatchingEnabled(true);
    setWindowAuthed(true);
  });

  it('whatIf path is not edge-cacheable (so batching is otherwise eligible)', () => {
    // Guards the premise: if this ever became cacheable, shouldBatch would return false for
    // an unrelated reason and the invariant below would pass vacuously.
    expect(CACHEABLE_PROCEDURES.has(whatIfPath)).toBe(false);
  });

  it('diverts the exact crash-band payload to POST instead of overflowing the batch URL', () => {
    // 14 LoRAs is the regression point: under the old raw-1400 threshold this stayed batched
    // (raw JSON ~1335 ≤ 1400) yet its encoded URL was ~2101 > 2083 → the #2962 crash. The
    // encoded-budget check must now classify it large → unbatched → POST. (Fails on the
    // pre-fix raw-char threshold, which is what makes this a real regression guard.)
    const crashBand = { type: 'query', path: whatIfPath, input: whatIfInput(14), context: {} };
    expect(batchedUrlLength(whatIfPath, whatIfInput(14))).toBeGreaterThan(BATCH_MAX_URL_LENGTH);
    expect(shouldBatch(crashBand)).toBe(false);
    // And a small stack still batches (the win isn't thrown away for the common case).
    const small = { type: 'query', path: whatIfPath, input: whatIfInput(3), context: {} };
    expect(shouldBatch(small)).toBe(true);
  });

  it('holds the invariant across a resource-count sweep: batched ⇒ URL < 2083', () => {
    for (let n = 0; n <= 40; n++) {
      const input = whatIfInput(n);
      const operation = { type: 'query', path: whatIfPath, input, context: {} };
      if (shouldBatch(operation)) {
        expect(batchedUrlLength(whatIfPath, input)).toBeLessThan(BATCH_MAX_URL_LENGTH);
      }
    }
  });
});

/**
 * The two size gates serve two different URL limits and must NOT be conflated (audit #1):
 *  - `isTooLargeToBatch` (tight, encoded) keeps a query off the batch link (hard 2083 cap).
 *  - `isLargeQuery` (coarse, raw 2500) decides GET→POST on the NON-batched path, whose only
 *    ceiling is HTTP 431 (~4000 chars). It governs the path EVERY query takes while batching
 *    is off, so it must stay at the pre-batching 2500 — otherwise mid-size cacheable GETs
 *    flip to uncacheable POST for 100% of live traffic on deploy. This guards that split.
 */
describe('batch-size gate is distinct from the non-batch GET→POST gate (#1)', () => {
  const q = (input: unknown) => ({ type: 'query', input });

  it('a mid-size query is excluded from batching but STILL sent as a (cacheable) GET', () => {
    // ~2000 raw chars: encoded > 1800 (too big for the 2083 batch cap) but raw ≤ 2500 (a
    // single GET is well under the 431 limit). Must be off the batch link YET stay a GET —
    // this is the edge-cacheability that a shared tight gate would have destroyed.
    const mid = q({ filter: 'x'.repeat(2000) });
    expect(isTooLargeToBatch(mid)).toBe(true); //   → not batched
    expect(isLargeQuery(mid)).toBe(false); //        → stays GET (not forced to POST)
  });

  it('a genuinely huge query goes POST on the non-batch path too', () => {
    const huge = q({ filter: 'x'.repeat(3000) }); // raw > 2500
    expect(isTooLargeToBatch(huge)).toBe(true);
    expect(isLargeQuery(huge)).toBe(true); //        → POST (body-carried)
  });

  it('a small query trips neither gate', () => {
    const small = q({ limit: 5 });
    expect(isTooLargeToBatch(small)).toBe(false);
    expect(isLargeQuery(small)).toBe(false);
  });

  it('the non-batch GET→POST threshold is the pre-batching 2500 raw chars (unchanged)', () => {
    expect(isLargeQuery(q({ s: 'x'.repeat(2600) }))).toBe(true); // just over 2500 raw → POST
    expect(isLargeQuery(q({ s: 'x'.repeat(2000) }))).toBe(false); // under → GET
  });

  it('neither gate fires on mutations (they keep the native POST path)', () => {
    expect(isTooLargeToBatch({ type: 'mutation', input: { s: 'x'.repeat(3000) } })).toBe(false);
    expect(isLargeQuery({ type: 'mutation', input: { s: 'x'.repeat(3000) } })).toBe(false);
  });

  it('isTooLargeToBatch sizes the SERIALIZED input, not raw JSON (superjson can expand)', () => {
    // Regression: superjson.serialize expands special types (Set/Map/Date) into a larger
    // {json,meta} shape. This input is tiny as raw JSON (~190 chars) but serializes+encodes to
    // >2083 — a raw-length fast-path would wave it through as "small" and it would overflow the
    // batch URL (the original "Input is too big for a single dispatch" crash). Must be excluded.
    const expandingInput = { items: Array.from({ length: 60 }, () => new Set()) };
    expect(JSON.stringify(expandingInput).length).toBeLessThan(500); // raw looks tiny…
    expect(isTooLargeToBatch(q(expandingInput))).toBe(true); // …but serialized is too big to batch
  });

  it('isTooLargeToBatch measures ENCODED length, not char count (non-ASCII expands >3x)', () => {
    // Regression: `encodeURIComponent` expands one non-ASCII UTF-16 unit to up to 9 chars
    // (中 → %E4%B8%AD), so a char-count×3 short-circuit under-counts a CJK-dense input and would
    // wave it onto the batch link → 2083 overflow. 300 CJK chars: ~320 serialized chars but the
    // batched URL is ~2790 > 2083. Must be excluded from batching.
    const cjk = q({ q: '中'.repeat(300) });
    expect(JSON.stringify('中'.repeat(300)).length).toBeLessThan(320); // char count looks modest…
    expect(isTooLargeToBatch(cjk)).toBe(true); // …but the ENCODED URL overflows → must not batch
  });
});

/**
 * Durable guard: independently RE-DERIVE the set of procedures that are edge-cacheable for
 * authenticated sessions (apply `edgeCacheIt` and do NOT opt out for authed via
 * `noEdgeCache({ authedOnly })` / blanket `noEdgeCache()`) by statically parsing the router
 * sources, and assert it equals `CACHEABLE_PROCEDURES`. This is what makes the exclusion
 * durable: add a new `edgeCacheIt` procedure without excluding it from batching and THIS
 * test fails — the batch link can't silently start de-caching authed feed queries.
 */
describe('CACHEABLE_PROCEDURES stays in sync with the routers (batch-skip guard)', () => {
  const routersDir = join(process.cwd(), 'src/server/routers');

  // Map `<basename>.router.ts` -> tRPC key prefix from the appRouter registration:
  //   `key: lazy(() => import('.../x.router').then((m) => m.xRouter))`
  const buildFileToKey = (): Record<string, string> => {
    const index = readFileSync(join(routersDir, 'index.ts'), 'utf8');
    const map: Record<string, string> = {};
    const re = /(\w+):\s*lazy\(\(\)\s*=>\s*import\(['"]([^'"]+)['"]\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(index))) {
      const [, key, importPath] = m;
      const base = importPath.split('/').pop()!; // e.g. "model.router"
      map[base.endsWith('.ts') ? base : `${base}.ts`] = key;
    }
    return map;
  };

  // Split a router file into top-level procedure blocks keyed by name (2-space indent).
  const procedureBlocks = (content: string): Array<{ name: string; block: string }> => {
    const lines = content.split('\n');
    const starts: number[] = [];
    lines.forEach((l, i) => {
      if (/^ {2}[a-zA-Z_]\w*:\s/.test(l)) starts.push(i);
    });
    return starts.map((start, idx) => {
      const end = idx + 1 < starts.length ? starts[idx + 1] : lines.length;
      const name = /^ {2}([a-zA-Z_]\w*):/.exec(lines[start])![1];
      return { name, block: lines.slice(start, end).join('\n') };
    });
  };

  it('matches the statically-derived cacheable-for-authed set exactly', () => {
    const fileToKey = buildFileToKey();
    const derived = new Set<string>();
    const missingKey: string[] = [];

    for (const file of readdirSync(routersDir)) {
      if (!file.endsWith('.router.ts')) continue;
      const content = readFileSync(join(routersDir, file), 'utf8');
      if (!content.includes('edgeCacheIt(')) continue;
      const key = fileToKey[file];
      if (!key) {
        missingKey.push(file);
        continue;
      }
      for (const { name, block } of procedureBlocks(content)) {
        if (!block.includes('edgeCacheIt(')) continue;
        // opts out of edge cache for authed (or everyone) => not cacheable-for-authed
        if (/noEdgeCache\(\s*\{\s*authedOnly/.test(block) || /noEdgeCache\(\s*\)/.test(block)) {
          continue;
        }
        derived.add(`${key}.${name}`);
      }
    }

    // Every edgeCacheIt router must be resolvable to an appRouter key, or the guard is blind.
    expect(missingKey).toEqual([]);
    expect(derived.size).toBeGreaterThan(0);

    const listed = [...CACHEABLE_PROCEDURES].sort();
    const expected = [...derived].sort();
    // Symmetric diff surfaces BOTH a new cached procedure not listed AND a stale listing.
    const notListed = expected.filter((p) => !CACHEABLE_PROCEDURES.has(p));
    const stale = listed.filter((p) => !derived.has(p));
    expect({ notListed, stale }).toEqual({ notListed: [], stale: [] });
    expect(listed).toEqual(expected);
  });
});

describe('queryRetry (batch-cohort thundering-herd guard)', () => {
  const err = new Error('boom');
  beforeEach(() => setTrpcBatchingEnabled(false));
  afterEach(() => setTrpcBatchingEnabled(false));

  it('flag OFF: identical to the prior retry:1 (exactly one retry)', () => {
    setTrpcBatchingEnabled(false);
    expect(queryRetry(0, err)).toBe(true); // 1st failure => retry once
    expect(queryRetry(1, err)).toBe(false); // already retried once => stop
    expect(queryRetry(2, err)).toBe(false);
  });

  it('flag ON: 0 retries (a batch failure must not fan out N retries)', () => {
    setTrpcBatchingEnabled(true);
    expect(queryRetry(0, err)).toBe(false);
    expect(queryRetry(1, err)).toBe(false);
  });

  it('tracks live flips of the module flag', () => {
    setTrpcBatchingEnabled(false);
    expect(queryRetry(0, err)).toBe(true);
    setTrpcBatchingEnabled(true);
    expect(queryRetry(0, err)).toBe(false);
  });
});
