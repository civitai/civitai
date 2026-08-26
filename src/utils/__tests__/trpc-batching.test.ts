import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import superjson from 'superjson';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __getTrpcBatchingEnabled,
  CACHEABLE_PROCEDURES,
  isLargeQuery,
  isTooLargeToBatch,
  NEVER_BATCH_PROCEDURES,
  queryRetry,
  setTrpcBatchingEnabled,
  shouldBatch,
} from '~/utils/trpc';
import {
  OBSERVED_MAX_FIRST_PARTY_BATCH_WIDTH,
  TRPC_MAX_BATCH_SIZE,
} from '~/shared/constants/trpc.constants';

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
    // `bug.getLatest` applies `edgeCacheIt` and does NOT opt out for authed, so it emits a
    // cacheable response for logged-in users — batching would append `?batch=1` and lose
    // the CF edge-hit. Must stay unbatched.
    //
    // This used to name `model.getAll`, which is no longer a member: its `skipEdgeCache`
    // middleware now skips on `!!ctx.user`, so it is deliberately not cacheable-for-authed.
    expect(CACHEABLE_PROCEDURES.has('bug.getLatest')).toBe(true);
    expect(shouldBatch(op({ path: 'bug.getLatest' }))).toBe(false);
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
/**
 * Remove comments from TypeScript source, preserving newlines (so line-oriented parsing
 * downstream is unaffected) and string/template contents (so a `//` inside a URL literal can't
 * swallow the rest of the line).
 *
 * 🔴 This is the fix for a latent COUPLING bug, not a tidy-up. The derivation below used a bare
 * `block.includes('edgeCacheIt(')` substring test, which also matched COMMENTED-OUT code —
 * `image.getGenerationData`'s `edgeCacheIt` is commented out, so it was being derived as
 * "cacheable" purely because the words were still in the file. With a batch-size cap in place
 * that stops being harmless: anyone who later made this guard comment-aware would drop
 * `image.getGenerationData` off the never-batch list, and the client would silently start
 * batching a per-image query at feed width. Fixing that bug must not be able to open this one,
 * so the procedure is now pinned separately via `NEVER_BATCH_PROCEDURES` for an independent
 * reason (see its doc comment) and asserted below.
 */
export function stripTsComments(src: string): string {
  type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'template';
  let mode: Mode = 'code';
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const c2 = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && c2 === '/') {
        mode = 'line';
        i += 2;
        continue;
      }
      if (c === '/' && c2 === '*') {
        mode = 'block';
        i += 2;
        continue;
      }
      if (c === "'") mode = 'single';
      else if (c === '"') mode = 'double';
      else if (c === '`') mode = 'template';
      out += c;
      i += 1;
      continue;
    }
    if (mode === 'line') {
      // Keep the newline so line numbering / indent-based block splitting is preserved.
      if (c === '\n') {
        mode = 'code';
        out += c;
      }
      i += 1;
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && c2 === '/') {
        mode = 'code';
        i += 2;
        continue;
      }
      if (c === '\n') out += c;
      i += 1;
      continue;
    }
    // Inside a string/template: copy through, honouring escapes so `\'` doesn't close it.
    if (c === '\\') {
      out += c + (c2 ?? '');
      i += 2;
      continue;
    }
    if (
      (mode === 'single' && c === "'") ||
      (mode === 'double' && c === '"') ||
      (mode === 'template' && c === '`')
    ) {
      mode = 'code';
    }
    out += c;
    i += 1;
  }
  return out;
}

describe('stripTsComments (drift-guard instrument)', () => {
  // NEGATIVE CONTROL: the guard must NOT see a commented-out call...
  it('does not report edgeCacheIt( from a line comment', () => {
    const block = [
      '  getGenerationData: publicProcedure',
      '    // TODO: Add edgeCacheIt back after fixing the cache invalidation.',
      '    // .use(',
      '    //   edgeCacheIt({ ttl: CacheTTL.day })',
      '    // )',
      '    .query(({ input }) => getImageGenerationData(input)),',
    ].join('\n');
    expect(block.includes('edgeCacheIt(')).toBe(true); // the OLD substring test was fooled
    expect(stripTsComments(block).includes('edgeCacheIt(')).toBe(false);
  });

  it('does not report edgeCacheIt( from a block comment', () => {
    const block = '  x: publicProcedure\n    /* .use(edgeCacheIt({ ttl: 1 })) */\n    .query(f),';
    expect(stripTsComments(block).includes('edgeCacheIt(')).toBe(false);
  });

  // ...POSITIVE CONTROL: and it must still see a real one, or the whole derivation is vacuous
  // and every "in sync" assertion below passes by finding nothing.
  it('still reports a real edgeCacheIt( call', () => {
    const block = '  getAll: publicProcedure\n    .use(edgeCacheIt({ ttl: CacheTTL.hour }))\n';
    expect(stripTsComments(block).includes('edgeCacheIt(')).toBe(true);
  });

  it('preserves line count so indent-based block splitting is unaffected', () => {
    const src = 'a\n// c\n/* b\n b */\nd\n';
    expect(stripTsComments(src).split('\n').length).toBe(src.split('\n').length);
  });

  it('does not treat // inside a string literal as a comment', () => {
    const src = `const u = 'https://x.example/y'; edgeCacheIt({});`;
    expect(stripTsComments(src).includes('edgeCacheIt(')).toBe(true);
  });
});

describe('CACHEABLE_PROCEDURES stays in sync with the routers (batch-skip guard)', () => {
  const routersDir = join(process.cwd(), 'src/server/routers');

  // Map `<basename>.router.ts` -> tRPC key prefix from the appRouter registration:
  //   `key: lazy(() => import('.../x.router').then((m) => m.xRouter))`
  const buildFileToKey = (): Record<string, string> => {
    // Comment-aware for the same reason as the `edgeCacheIt(` scan: a commented-out `lazy()`
    // registration is not a registered router, and must not mint a key.
    const index = stripTsComments(readFileSync(join(routersDir, 'index.ts'), 'utf8'));
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

  /**
   * Middlewares defined as top-level consts in the same router file, so a bare
   * `.use(someMiddleware)` can be resolved to its body.
   *
   * A router may express the authed opt-out in a bespoke middleware rather than via
   * `noEdgeCache` — `model.router.ts`'s `skipEdgeCache` sets `ctx.cache.skip` from
   * `ctx.user`, which `edgeCacheIt` reads to compute the TTL. A block-scoped regex
   * cannot see that, so without this resolution the derivation reports such a
   * procedure as cacheable-for-authed, which is the opposite of the truth.
   */
  const localMiddlewares = (content: string): Record<string, string> => {
    const lines = content.split('\n');
    const out: Record<string, string> = {};
    lines.forEach((line, i) => {
      const m = /^const (\w+) = middleware\(/.exec(line);
      if (!m) return;
      let end = i;
      while (end < lines.length && !/^\}\);/.test(lines[end])) end++;
      out[m[1]] = lines.slice(i, Math.min(end + 1, lines.length)).join('\n');
    });
    return out;
  };

  /** Append the bodies of any locally-defined middlewares the block applies. */
  const withResolvedUses = (block: string, locals: Record<string, string>) =>
    [block, ...[...block.matchAll(/\.use\((\w+)\)/g)].map((m) => locals[m[1]] ?? '')].join('\n');

  /**
   * Does this (use-resolved) block opt out of edge caching for authenticated callers?
   * Three spellings, all of which mean "not cacheable-for-authed":
   *   - `noEdgeCache({ authedOnly: true })`
   *   - a blanket `noEdgeCache()`
   *   - a `skip` assignment that consults `ctx.user`
   */
  const optsOutForAuthed = (text: string) =>
    /noEdgeCache\(\s*\{\s*authedOnly/.test(text) ||
    /noEdgeCache\(\s*\)/.test(text) ||
    /skip:[^,\n]*ctx\.user/.test(text);

  it('resolves a bespoke authed opt-out expressed in a local middleware', () => {
    const content = [
      "const skipIt = middleware(async ({ ctx, next }) => {",
      "  return next({ ctx: { cache: { ...ctx.cache, skip: !!ctx.user } } });",
      "});",
      "",
      "  getAll: publicProcedure",
      "    .use(skipIt)",
      "    .use(edgeCacheIt({ ttl: 60 }))",
    ].join('\n');
    const block = procedureBlocks(content).find((b) => b.name === 'getAll')!.block;
    // The bare block cannot see it; resolving `.use()` is what makes it visible.
    expect(optsOutForAuthed(block)).toBe(false);
    expect(optsOutForAuthed(withResolvedUses(block, localMiddlewares(content)))).toBe(true);
  });

  it('does not invent an opt-out for a local middleware that ignores the caller', () => {
    const content = [
      "const skipIt = middleware(async ({ input, ctx, next }) => {",
      "  return next({ ctx: { cache: { ...ctx.cache, skip: !!(input as any).favorites } } });",
      "});",
      "",
      "  getAll: publicProcedure",
      "    .use(skipIt)",
      "    .use(edgeCacheIt({ ttl: 60 }))",
    ].join('\n');
    const block = procedureBlocks(content).find((b) => b.name === 'getAll')!.block;
    expect(optsOutForAuthed(withResolvedUses(block, localMiddlewares(content)))).toBe(false);
  });

  it('matches the statically-derived cacheable-for-authed set exactly', () => {
    const fileToKey = buildFileToKey();
    const derived = new Set<string>();
    const missingKey: string[] = [];

    for (const file of readdirSync(routersDir)) {
      if (!file.endsWith('.router.ts')) continue;
      // Comment-aware: a commented-out `edgeCacheIt(` is NOT an applied middleware. See
      // `stripTsComments` above for why this correction is coupled to NEVER_BATCH_PROCEDURES.
      const content = stripTsComments(readFileSync(join(routersDir, file), 'utf8'));
      if (!content.includes('edgeCacheIt(')) continue;
      const key = fileToKey[file];
      if (!key) {
        missingKey.push(file);
        continue;
      }
      const locals = localMiddlewares(content);
      for (const { name, block } of procedureBlocks(content)) {
        if (!block.includes('edgeCacheIt(')) continue;
        // opts out of edge cache for authed (or everyone) => not cacheable-for-authed.
        // Resolve `.use(localMiddleware)` first, or a bespoke opt-out is invisible here.
        if (optsOutForAuthed(withResolvedUses(block, locals))) continue;
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

  /**
   * The other half of the decoupling. `image.getGenerationData` used to appear in the derived
   * set ONLY because the substring test matched its commented-out `edgeCacheIt`. Now that the
   * derivation is comment-aware it correctly does not — so this asserts both facts at once:
   * the guard no longer counts commented-out code, AND the procedure is still excluded from
   * batching, by an independent mechanism that the derivation cannot reach.
   */
  it.each([
    ['image.router.ts', 'image', 'getGenerationData'],
    ['event.router.ts', 'event', 'getData'],
  ])('does not derive %s#%s (its edgeCacheIt is commented out)', (file, key, procedure) => {
    const raw = readFileSync(join(routersDir, file), 'utf8');
    const block = procedureBlocks(stripTsComments(raw)).find((b) => b.name === procedure);

    expect(buildFileToKey()[file]).toBe(key); // guard is looking at the right router
    expect(block).toBeDefined();
    // Raw source still contains the words somewhere — this is exactly what the OLD substring
    // guard tripped on, and why both procedures looked derived when neither is.
    expect(raw.includes('edgeCacheIt(')).toBe(true);
    expect(block!.block.includes('edgeCacheIt(')).toBe(false);
    expect(CACHEABLE_PROCEDURES.has(`${key}.${procedure}`)).toBe(false);
  });

  it('derives a procedure whose edgeCacheIt is REAL, in the same file', () => {
    // Positive control for the pair above: the comment-aware strip must not have simply stopped
    // detecting `edgeCacheIt` in `event.router.ts` altogether, which would make that assertion
    // pass for the wrong reason.
    expect(CACHEABLE_PROCEDURES.has('event.getTeamScores')).toBe(true);
    expect(CACHEABLE_PROCEDURES.has('image.getResources')).toBe(true);
  });
});

describe('NEVER_BATCH_PROCEDURES (independent of the edge-cache derivation)', () => {
  beforeEach(() => {
    setTrpcBatchingEnabled(true);
    setWindowAuthed(true);
  });
  afterEach(() => {
    setTrpcBatchingEnabled(false);
    clearWindow();
  });

  it('pins both pending-cacheable procedures to the never-batch set', () => {
    expect([...NEVER_BATCH_PROCEDURES].sort()).toEqual([
      'event.getData',
      'image.getGenerationData',
    ]);
  });

  it.each([...NEVER_BATCH_PROCEDURES])(
    'keeps %s unbatched even with every other condition satisfied',
    (path) => {
      // Same op shape that DOES batch, differing only in path — so a failure here can only be
      // attributable to the never-batch set, not to some other condition failing.
      expect(shouldBatch(op({ path: 'model.getInfinite' }))).toBe(true);
      expect(shouldBatch(op({ path }))).toBe(false);
    }
  );

  it('does not overlap CACHEABLE_PROCEDURES (one reason per procedure)', () => {
    const overlap = [...NEVER_BATCH_PROCEDURES].filter((p) => CACHEABLE_PROCEDURES.has(p));
    expect(overlap).toEqual([]);
  });
});

describe('batch-size cap constants', () => {
  /**
   * Pins the widest batch first-party traffic has been measured to emit BELOW the cap. Tightening
   * `TRPC_MAX_BATCH_SIZE` under real traffic then fails here rather than in production. If a
   * wider first-party batch is genuinely measured, update
   * `OBSERVED_MAX_FIRST_PARTY_BATCH_WIDTH` — and re-check the cap while doing it.
   */
  it('leaves headroom over the widest observed first-party batch', () => {
    expect(OBSERVED_MAX_FIRST_PARTY_BATCH_WIDTH).toBeLessThan(TRPC_MAX_BATCH_SIZE);
    // Not merely "below" — a cap one call above real traffic would clip on any new fan-out.
    expect(TRPC_MAX_BATCH_SIZE).toBeGreaterThanOrEqual(2 * OBSERVED_MAX_FIRST_PARTY_BATCH_WIDTH);
  });

  it('is a positive integer (a non-integer or 0 would reject every batch)', () => {
    expect(Number.isInteger(TRPC_MAX_BATCH_SIZE)).toBe(true);
    expect(TRPC_MAX_BATCH_SIZE).toBeGreaterThan(0);
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
