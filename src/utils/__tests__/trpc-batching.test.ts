import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __getTrpcBatchingEnabled,
  CACHEABLE_PROCEDURES,
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
    // input serializes to > MAX_QUERY_INPUT_LENGTH (2500 chars) => large => unbatched
    expect(shouldBatch(op({ input: { q: 'x'.repeat(3000) } }))).toBe(false);
  });

  it('still batches a query whose input is just under the large-query threshold', () => {
    setTrpcBatchingEnabled(true);
    setWindowAuthed(true);
    expect(shouldBatch(op({ input: { q: 'x'.repeat(100) } }))).toBe(true);
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
