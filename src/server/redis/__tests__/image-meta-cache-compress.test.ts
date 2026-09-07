import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * `imageMetaCache` must stay configured with `compress: true` (issue #4588).
 *
 * WHY A SOURCE-LEVEL GUARD. `caches.ts` builds 20+ module-scope cache singletons during module
 * evaluation and pulls in the env / clickhouse / orchestrator import graph, so importing it from
 * a unit test is not viable (that is why every other cache test in this directory rebuilds the
 * cache from a copied lookupFn instead). The cache objects it exports are opaque closures — they
 * do not expose the options they were built with — so there is nothing to assert on at runtime
 * either. The declaration site IS the configuration, so that is what this pins.
 *
 * The MECHANISM is covered behaviourally, end-to-end against the real redis client, in
 * `packages/civitai-redis/src/__tests__/cached-array-compress.test.ts`. This file only guards
 * that this particular cache is still opted in — the deployment half of #4588.
 *
 * SCOPE: the extractor brace-matches the `imageMetaCache` options object specifically, so a
 * `compress: true` elsewhere in the 3,000-line file cannot satisfy it. The positive control
 * below proves that scoping is real by running the same extractor over a NEIGHBOURING cache
 * that must NOT be compressed — if the extractor ever degrades into "scan the whole file", that
 * control turns red rather than this guard silently passing on the wrong evidence.
 */

const CACHES_PATH = path.join(process.cwd(), 'src/server/redis/caches.ts');
const source = readFileSync(CACHES_PATH, 'utf8');

/**
 * Return the text of the options object literal passed to the `createCached*` call that
 * initialises `export const <name>`. Throws if the declaration is absent, so a rename fails
 * loudly instead of returning an empty string that vacuously satisfies a `not.toContain`.
 */
function cacheOptionsBlock(name: string): string {
  const decl = new RegExp(`export const ${name} = createCached(?:Object|Array)<[^>]*>\\(`);
  const m = decl.exec(source);
  if (!m) throw new Error(`Could not locate "export const ${name} = createCached…(" in caches.ts`);
  const open = source.indexOf('{', m.index + m[0].length - 1);
  if (open === -1) throw new Error(`No options object literal found for ${name}`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`Unbalanced braces while extracting ${name}'s options`);
}

describe('imageMetaCache compression (#4588)', () => {
  const block = cacheOptionsBlock('imageMetaCache');

  it('is the IMAGE_META cache (the extractor is pointed at the right declaration)', () => {
    expect(block).toContain('key: REDIS_KEYS.CACHES.IMAGE_META');
  });

  it('is configured with compress: true', () => {
    expect(block).toMatch(/(^|\n)\s*compress:\s*true\s*,/);
  });

  it('still has NO per-pod L1 (the hideMeta privacy control — do not "fix" decode cost with one)', () => {
    // `meta` is gated on hideMeta and a cross-pod refresh() cannot be observed by an L1, so an
    // L1 here would keep serving a prompt the owner just hid. Compression changes the decode
    // cost, which is exactly the argument someone will reach for an L1 with — pinned so that
    // reasoning has to come back through review.
    expect(block).not.toMatch(/(^|\n)\s*localTtl:/);
  });

  it('keeps the 4h logical TTL and the trimmed 1h stale tail', () => {
    // Compression is the lever that replaced the (already-spent) TTL lever; a future change that
    // shortens the logical TTL would convert the hot working set into misses and stampede dbRead.
    expect(block).toContain('ttl: CacheTTL.hour * 4');
    expect(block).toContain('staleWhileRevalidateTtl: CacheTTL.hour');
  });

  it('POSITIVE CONTROL: the extractor is block-scoped, not a whole-file scan', () => {
    // imageMetadataCache sits directly after imageMetaCache in the file and is NOT compressed.
    // If the extractor degraded to scanning the whole source, this would find imageMetaCache's
    // `compress: true` and fail — which is precisely the failure this control exists to catch.
    const neighbour = cacheOptionsBlock('imageMetadataCache');
    expect(neighbour).toContain('key: REDIS_KEYS.CACHES.IMAGE_METADATA');
    expect(neighbour).not.toMatch(/(^|\n)\s*compress:\s*true\s*,/);
  });

  it('POSITIVE CONTROL: a missing declaration throws rather than passing vacuously', () => {
    expect(() => cacheOptionsBlock('noSuchCacheDoesNotExist')).toThrow(/Could not locate/);
  });
});
