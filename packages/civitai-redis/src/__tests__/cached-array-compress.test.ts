import { readFileSync } from 'fs';
import { pack, unpack } from 'msgpackr';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * End-to-end coverage for `compress` on createCachedArray / createCachedObject (issue #4588,
 * shipped for `imageMetaCache`).
 *
 * WHY THIS FILE DRIVES THE REAL CLIENT: the hazard here is a SEAM, not a component. The flag has
 * to be symmetric across TWO modules — `cached-array.ts` must pass `{ compress }` to every one of
 * its nine `redis.packed` reads and writes, AND `client.ts`'s `packed.mGet` must actually honour
 * it (before #4588 it could not — only `packed.get` took the option, and `createCachedArray` reads
 * exclusively through `mGet`). A test that mocks `redis.packed` proves neither half: it would pass
 * against a client whose mGet ignores the flag entirely, which is the exact production defect —
 * a compressed value decoded on the general msgpack path throws, the entry is EVICTED, and the
 * read reports a MISS. Permanent miss+evict loop, no error anywhere.
 *
 * So the only thing faked here is the TRANSPORT: `redis`'s client factory is replaced by an
 * in-memory server holding raw Buffers. Everything above the socket — `createCacheRedis`,
 * `client.packed.set/mGet/get`, the msgpack + brotli codec, `createCacheBuilders` — is the real
 * module. That also lets these tests assert the ON-DISK BYTES (the 0x01 brotli sentinel), which is
 * the only way to tell "compression is on" from "the round-trip happens to work anyway".
 */

// process.env must be populated BEFORE ../client is imported: loadRedisEnv() validates it.
vi.hoisted(() => {
  process.env.REDIS_URL ??= 'redis://localhost:6379';
  process.env.REDIS_SYS_URL ??= 'redis://localhost:6379';
  process.env.REDIS_CLUSTER = 'false';
});

/** The in-memory "server": key -> raw stored bytes, exactly as a real Redis would hold them. */
const { store } = vi.hoisted(() => ({ store: new Map<string, Buffer>() }));

vi.mock('redis', () => {
  const toBuffer = (v: unknown): Buffer =>
    Buffer.isBuffer(v) ? v : Buffer.from(v as string, 'binary');

  // A single fake node client. `withTypeMapping` returns a Buffer-mode VIEW over the same store
  // (mirroring node-redis: same connection, different reply decoding).
  const makeClient = (bufferMode = false): Record<string, unknown> => {
    const self: Record<string, any> = {
      connect: () => Promise.resolve(self),
      on: () => self,
      withTypeMapping: () => makeClient(true),
      get: async (key: string) => {
        const v = store.get(key);
        if (v === undefined) return null;
        return bufferMode ? v : v.toString('binary');
      },
      set: async (key: string, value: unknown, options?: { NX?: boolean; XX?: boolean }) => {
        const exists = store.has(key);
        if (options?.NX && exists) return null;
        if (options?.XX && !exists) return null;
        store.set(key, toBuffer(value));
        return 'OK';
      },
      del: async (key: string) => (store.delete(key) ? 1 : 0),
      unlink: async (key: string) => (store.delete(key) ? 1 : 0),
      // Backs client.setNxKeepTtlWithEx's EVAL (SET NX KEEPTTL + EXPIRE). TTLs are irrelevant to
      // the codec contract under test, so the lock is modelled as plain set-if-absent.
      eval: async (_script: string, opts: { keys: string[] }) => {
        const key = opts.keys[0];
        if (store.has(key)) return 0;
        store.set(key, Buffer.from('1'));
        return 1;
      },
      scanIterator: async function* () {
        /* unused */
      },
    };
    return self;
  };

  return {
    createClient: () => makeClient(false),
    createCluster: () => makeClient(false),
    createSentinel: () => makeClient(false),
    RESP_TYPES: { BLOB_STRING: 36 },
  };
});

import { createCacheBuilders, type CachedLookupOptions } from '../cached-array';
import { createCacheRedis } from '../client';
import { PACKED_BROTLI_SENTINEL, compressPacked, decompressPacked } from '../packed-compression';
import type { RedisKeyTemplateCache } from '../client';

const redis = createCacheRedis();

type Row = { id: number; blob: string };

// A value with real redundancy, so a compressed payload is unambiguously SMALLER than the packed
// one. A short random string would compress LARGER than its input and make the size assertion
// below a coin flip.
const bigBlob = 'prompt, masterpiece, highly detailed, '.repeat(120);

const KEY = 'packed:caches:test-compress' as RedisKeyTemplateCache;

function buildCache(
  overrides: Partial<CachedLookupOptions<Row>> = {},
  lookupFn = vi.fn(
    async (ids: number[]) =>
      Object.fromEntries(ids.map((id) => [id, { id, blob: bigBlob }])) as Record<string, Row>
  )
) {
  const noopMetrics = {
    hit: () => undefined,
    miss: () => undefined,
    revalidate: () => undefined,
    failOpenDegraded: () => undefined,
    failOpenOriginFetch: () => undefined,
  };
  const { createCachedObject } = createCacheBuilders({
    redis,
    defaultTtl: 300,
    metrics: noopMetrics,
    logFailOpen: () => undefined,
    logRefreshError: () => undefined,
    log: () => undefined,
    clearByPattern: async () => undefined,
  });
  const cache = createCachedObject<Row>({
    key: KEY,
    idKey: 'id',
    lookupFn,
    ttl: 3600,
    ...overrides,
  });
  return { cache, lookupFn };
}

/** Raw bytes as they sit "in redis" for one cached id. */
const stored = (id: number) => store.get(`${KEY}:${id}`);

beforeEach(() => {
  store.clear();
});

describe('createCachedObject { compress: true } — write path', () => {
  // INVARIANT GUARD (green at origin/main too): with `compress` ignored, reads and writes are
  // still symmetric — just uncompressed — so this cannot go red on the pre-change tree. It pins
  // that enabling compression does not BREAK the basic read-through contract; the regression
  // coverage for compression actually happening is the sentinel test below.
  it('round-trips a value through a compressed cache (2nd fetch is served from redis)', async () => {
    const { cache, lookupFn } = buildCache({ compress: true });

    const first = await cache.fetch([1, 2]);
    expect(first['1']).toEqual({ id: 1, blob: bigBlob });
    expect(lookupFn).toHaveBeenCalledTimes(1);

    const second = await cache.fetch([1, 2]);
    expect(second['1']).toEqual({ id: 1, blob: bigBlob });
    expect(second['2']).toEqual({ id: 2, blob: bigBlob });
    // Served from the compressed redis entry — the origin was NOT re-consulted. This is what
    // fails when mGet ignores `compress`: the decode throws, the entry is evicted, and lookupFn
    // is called a second time.
    expect(lookupFn).toHaveBeenCalledTimes(1);
  });

  it('actually writes a SENTINEL-TAGGED, smaller payload (compression is not a silent no-op)', async () => {
    const { cache } = buildCache({ compress: true });
    await cache.fetch([1]);

    const raw = stored(1)!;
    expect(raw).toBeInstanceOf(Buffer);
    expect(raw[0]).toBe(PACKED_BROTLI_SENTINEL);
    // Positive control on the codec itself: the stored payload must be materially smaller than
    // the uncompressed msgpack of the same record. A round-trip assertion alone passes even if
    // `compress` never reached the write.
    const uncompressedSize = pack({ id: 1, blob: bigBlob, cachedAt: new Date() }).length;
    expect(raw.length).toBeLessThan(uncompressedSize / 2);
  });

  it('compresses the notFound sentinel write too, and does not re-consult the origin', async () => {
    // lookupFn returns nothing for id 7 -> negative marker { id, notFound, cachedAt }.
    const lookupFn = vi.fn(async () => ({} as Record<string, Row>));
    const { cache } = buildCache({ compress: true }, lookupFn);

    const first = await cache.fetch([7]);
    expect(first['7']).toBeUndefined();
    expect(lookupFn).toHaveBeenCalledTimes(1);

    const raw = stored(7)!;
    expect(raw[0]).toBe(PACKED_BROTLI_SENTINEL);

    // The negative cache must be READABLE through the compressed path, or every miss re-queries.
    const second = await cache.fetch([7]);
    expect(second['7']).toBeUndefined();
    expect(lookupFn).toHaveBeenCalledTimes(1);
  });
});

describe('createCachedObject { compress: true } — symmetry across bust / refresh / update', () => {
  it('refresh() rewrites a sentinel-tagged entry that later reads decode', async () => {
    const lookupFn = vi.fn(
      async (ids: number[]) =>
        Object.fromEntries(ids.map((id) => [id, { id, blob: bigBlob }])) as Record<string, Row>
    );
    // staleWhileRevalidate:false so `bust` is the debounce-marker variant and refresh's EX path
    // is the plain one; the SWR variant is covered by the invalidate test below.
    const { cache } = buildCache({ compress: true, staleWhileRevalidate: false }, lookupFn);

    await cache.refresh([3]);
    expect(stored(3)![0]).toBe(PACKED_BROTLI_SENTINEL);

    lookupFn.mockClear();
    const got = await cache.fetch([3]);
    expect(got['3']).toEqual({ id: 3, blob: bigBlob });
    expect(lookupFn).not.toHaveBeenCalled();
  });

  it('bust() writes a compressed debounce marker that the read path understands', async () => {
    const { cache, lookupFn } = buildCache({ compress: true, staleWhileRevalidate: false });
    await cache.fetch([4]);
    expect(lookupFn).toHaveBeenCalledTimes(1);

    await cache.bust(4);
    const raw = stored(4)!;
    expect(raw[0]).toBe(PACKED_BROTLI_SENTINEL);
    // The marker must DECODE, or the debounce is invisible and the entry reads as absent for a
    // different reason. Decoding it proves the compressed bust write is symmetric with the read.
    const marker = unpack(
      await import('zlib').then(
        (z) =>
          new Promise<Buffer>((res, rej) =>
            z.brotliDecompress(raw.subarray(1), (e, b) => (e ? rej(e) : res(b)))
          )
      )
    ) as { id: number; debounce: boolean };
    expect(marker).toMatchObject({ id: 4, debounce: true });

    lookupFn.mockClear();
    const after = await cache.fetch([4]);
    expect(after['4']).toEqual({ id: 4, blob: bigBlob });
    expect(lookupFn).toHaveBeenCalledTimes(1); // the bust forced a re-fetch
  });

  it('bust() on an SWR cache (invalidate) reads AND rewrites through the compressed path', async () => {
    // invalidate() mGets the existing entry and rewrites it with a backdated cachedAt. Both halves
    // must be compress-aware: an mGet that ignores the flag sees nothing to rewrite and the
    // invalidate silently NO-OPS — the value keeps being served fresh.
    const { cache } = buildCache({ compress: true, staleWhileRevalidate: true });
    await cache.fetch([5]);
    const before = stored(5)!;

    await cache.bust(5);
    const after = stored(5);
    // Asserted before indexing: if invalidate's mGet decoded on the wrong path the entry is
    // EVICTED, and this says so instead of throwing a bare TypeError on `after[0]`.
    expect(after, 'entry was evicted — invalidate read it on the non-compress path').toBeDefined();
    expect(after![0]).toBe(PACKED_BROTLI_SENTINEL);
    expect(after!.equals(before)).toBe(false); // it really rewrote the entry
  });

  it('update() reads and rewrites a compressed entry', async () => {
    const { cache } = buildCache({ compress: true, staleWhileRevalidate: false });
    await cache.fetch([6]);

    // `false` here means update() found nothing to correct — which, on a compressed cache, is
    // what an asymmetric mGet produces: the read throws, the entry is evicted, and the
    // write-through silently degrades to a no-op the caller is expected to fall back from.
    const ok = await cache.update(6, (current) => ({ ...current, blob: 'updated' }));
    expect(ok, 'update() found no entry — the compressed read decoded on the wrong path').toBe(
      true
    );
    expect(stored(6)![0]).toBe(PACKED_BROTLI_SENTINEL);

    const got = await cache.fetch([6]);
    expect(got['6']).toEqual({ id: 6, blob: 'updated' });
  });
});

describe('back-compat: legacy UNCOMPRESSED entries stay readable', () => {
  it('serves a MIXED population — a legacy raw entry and a freshly compressed one — in one fetch', async () => {
    // This is the state of the cache for the whole TTL after the flag is flipped, and the reason
    // no key-bust or migration is needed. Both entries must decode in the SAME mGet.
    const { cache, lookupFn } = buildCache({ compress: true });

    // Exactly what the cache wrote before compression was enabled: raw msgpack, no sentinel.
    const legacy = pack({ id: 9, blob: bigBlob, cachedAt: new Date() });
    expect(legacy[0]).not.toBe(PACKED_BROTLI_SENTINEL);
    store.set(`${KEY}:9`, Buffer.from(legacy));

    // id 10 is absent, so this pass writes it through the NEW compressed path.
    const got = await cache.fetch([9, 10]);
    expect(got['9']).toEqual({ id: 9, blob: bigBlob });
    expect(got['10']).toEqual({ id: 10, blob: bigBlob });
    // Only the missing id reached the origin — the legacy entry was a hit, not a decode failure.
    expect(lookupFn).toHaveBeenCalledTimes(1);
    expect(lookupFn.mock.calls[0][0]).toEqual([10]);

    // The two entries are now stored in DIFFERENT formats…
    expect(stored(9)![0]).not.toBe(PACKED_BROTLI_SENTINEL);
    expect(stored(10)![0]).toBe(PACKED_BROTLI_SENTINEL);
    // …and the legacy one survived (a failed decode would have UNLINKed it).
    expect(store.has(`${KEY}:9`)).toBe(true);

    // A second fetch reads both formats back with no origin call at all.
    lookupFn.mockClear();
    const again = await cache.fetch([9, 10]);
    expect(again['9']).toEqual({ id: 9, blob: bigBlob });
    expect(again['10']).toEqual({ id: 10, blob: bigBlob });
    expect(lookupFn).not.toHaveBeenCalled();
  });
});

// INVARIANT GUARDS (green at origin/main too, by construction — that is the point). These pin
// that the DEFAULT is unchanged, i.e. that ~30 other packed caches keep writing plain msgpack.
// They go red only if someone flips the default on, which is the regression they exist for.
describe('default / compress:false is byte-for-byte unchanged', () => {
  it('writes NO sentinel and stores plain msgpack when compress is omitted', async () => {
    const { cache } = buildCache({});
    await cache.fetch([1]);

    const raw = stored(1)!;
    expect(raw[0]).not.toBe(PACKED_BROTLI_SENTINEL);
    // Plain msgpack map marker, and it unpacks with no decompression step.
    const decoded = unpack(raw) as Row;
    expect(decoded).toMatchObject({ id: 1, blob: bigBlob });
  });

  it('compress:false explicitly is identical to the default', async () => {
    const { cache } = buildCache({ compress: false });
    await cache.fetch([2]);
    expect(stored(2)![0]).not.toBe(PACKED_BROTLI_SENTINEL);
  });
});

describe('SEAM LEDGER: every redis.packed call site in cached-array.ts is compress-aware', () => {
  // The behavioural tests above cover all NINE call sites as they exist today. This ledger is
  // what catches the TENTH: a new redis.packed read or write added later without `packedOptions`
  // would be silently asymmetric on a compressed cache, and no existing test would exercise it.
  // Asserted as an exact COUNT in both directions — a shrinking set means the detector went
  // blind, which passes an additions-only check while reporting a clean file.
  const src = readFileSync(path.join(__dirname, '..', 'cached-array.ts'), 'utf8');
  // Paren-matched rather than regex-captured: the call sites here span 1–6 lines and a
  // "up to the closing paren" regex silently misses the single-line ones (it did, at first —
  // it found 8 of 9, which is exactly the shape of a detector that reports a clean file).
  const calls: { op: string; args: string }[] = [];
  for (const m of src.matchAll(/redis\.packed\.(mGet|set)\b/g)) {
    let i = m.index! + m[0].length;
    if (src[i] === '<') i = src.indexOf('>', i) + 1; // skip an explicit type argument
    if (src[i] !== '(') continue;
    let depth = 0;
    let end = i;
    for (; end < src.length; end++) {
      if (src[end] === '(') depth++;
      else if (src[end] === ')' && --depth === 0) break;
    }
    calls.push({ op: m[1], args: src.slice(i + 1, end) });
  }

  // INVARIANT GUARD (green at origin/main too): the nine call sites exist there as well. Its job
  // is to keep the ledger below honest — a detector that goes blind fails HERE rather than
  // reporting zero violations over zero call sites.
  it('finds exactly the 9 known redis.packed call sites', () => {
    // POSITIVE CONTROL on the detector: if the matcher stops matching, the count drops and the
    // whole ledger fails loudly rather than reporting zero violations over zero call sites.
    expect(calls.length).toBe(9);
    expect(calls.filter((c) => c.op === 'mGet').length).toBe(3);
    expect(calls.filter((c) => c.op === 'set').length).toBe(6);
  });

  it('every one of them passes packedOptions', () => {
    const missing = calls.filter((c) => !c.args.includes('packedOptions')).map((c) => c.args);
    expect(missing).toEqual([]);
  });

  it('packedOptions is derived from the option, not hardcoded', () => {
    expect(src).toMatch(/const packedOptions = \{ compress \} as const;/);
  });
});

describe('the symmetry hazard this flag exists to prevent', () => {
  it('a compressed entry read through the NON-compress path is a miss AND is evicted', async () => {
    // This is the production failure mode if any one call site drops the flag: not an error, a
    // silent permanent miss+evict loop. Asserted directly against the real client so the guard
    // pins the mechanism rather than a mocked stand-in.
    const key = `${KEY}:99` as RedisKeyTemplateCache;
    store.set(key, await compressPacked(Buffer.from(pack({ id: 99, blob: bigBlob }))));

    const [viaGeneral] = await redis.packed.mGet<Row>([key]);
    expect(viaGeneral).toBeNull();
    expect(store.has(key)).toBe(false); // evicted by safeUnpack's unlink

    // …and the same bytes read WITH the flag decode fine.
    store.set(key, await compressPacked(Buffer.from(pack({ id: 99, blob: bigBlob }))));
    const [viaCompress] = await redis.packed.mGet<Row>([key], { compress: true });
    expect(viaCompress).toEqual({ id: 99, blob: bigBlob });
  });
});

describe('packed.mGet index alignment — the OTHER half of the seam', () => {
  /**
   * `mGet`'s contract is POSITIONAL: result[i] belongs to keys[i], and a decode failure at i must
   * evict keys[i] — nobody else. Both halves are unguarded by everything above, because
   * `createCachedArray` re-keys the batch by `idKey` immediately after the read and so cannot
   * observe either defect. The next caller would.
   *
   * The eviction half is not hypothetical for this PR: during a mixed-fleet rollout a pod WILL
   * meet entries it cannot decode (see the compress-symmetry test above), so a mis-indexed
   * `unlink` would repeatedly evict a healthy NEIGHBOUR while leaving the bad entry in place —
   * a self-sustaining eviction of good data that looks like ordinary cache churn.
   *
   * Shape of the fixture, which is what makes both defects visible:
   *  - THREE keys, failure in the MIDDLE, so an off-by-one and a first-element collapse land on
   *    different keys and neither can be satisfied by luck;
   *  - the two good values are PAIRWISE DISTINCT, so a reversed array is detectable (a reversal
   *    keeps `null` in the middle — only distinct outer values expose it);
   *  - eviction is asserted as an exact SET over the store, so it fails whether the wrong key is
   *    evicted, an extra key is evicted, or nothing is evicted at all.
   */
  const K = (n: number) => `${KEY}:align-${n}` as RedisKeyTemplateCache;
  const first = { id: 101, blob: 'first-value' };
  const last = { id: 103, blob: 'last-value' };
  // Sentinel-tagged but NOT a valid brotli stream: reaches the compress-aware decode and throws
  // inside brotliDecompress, which is the realistic corruption on this path.
  const CORRUPT_COMPRESSED = Buffer.from([PACKED_BROTLI_SENTINEL, 0xff, 0xff, 0xff, 0xff]);
  // A truncated msgpack map16 header — no sentinel byte, so it is a corrupt LEGACY value and
  // fails inside `unpack` on the general path.
  const CORRUPT_PLAIN = Buffer.from([0xde, 0x00, 0x05]);

  it('COMPRESS branch: positional order is preserved and ONLY the failing key is evicted', async () => {
    store.set(K(1), await compressPacked(Buffer.from(pack(first))));
    store.set(K(2), CORRUPT_COMPRESSED);
    store.set(K(3), await compressPacked(Buffer.from(pack(last))));

    const got = await redis.packed.mGet<Row>([K(1), K(2), K(3)], { compress: true });

    // ORDER: index 0 is the FIRST key's value, index 2 is the LAST key's. Reversing the array
    // keeps the null in the middle, so only these two distinct outer values can catch it.
    expect(got).toEqual([first, null, last]);

    // EVICTION: exactly the offending key, and nothing else. An exact set rather than three
    // independent `has` calls, so a wrong/extra/absent eviction all fail the same assertion.
    const survivors = [K(1), K(2), K(3)].filter((k) => store.has(k));
    expect(survivors, 'only the undecodable key may be evicted').toEqual([K(1), K(3)]);
  });

  it('NON-COMPRESS branch: same contract, same fixture shape', async () => {
    // The general path is PRE-EXISTING code this PR did not touch, but it carries the identical
    // `keys[i]` shape one line below the branch that was added — so a future edit to one half is
    // overwhelmingly likely to be made to both. Guarded here to close the class rather than the
    // instance; this is test-only and expands no production diff.
    store.set(K(4), Buffer.from(pack(first)));
    store.set(K(5), CORRUPT_PLAIN);
    store.set(K(6), Buffer.from(pack(last)));

    const got = await redis.packed.mGet<Row>([K(4), K(5), K(6)]);

    expect(got).toEqual([first, null, last]);
    const survivors = [K(4), K(5), K(6)].filter((k) => store.has(k));
    expect(survivors, 'only the undecodable key may be evicted').toEqual([K(4), K(6)]);
  });

  it('POSITIVE CONTROL: the corrupt fixtures really are undecodable on their own path', () => {
    // Without this, a fixture that silently DECODED would make both tests above pass while
    // proving nothing — the null would never be produced and no eviction would ever be attempted.
    expect(CORRUPT_COMPRESSED[0]).toBe(PACKED_BROTLI_SENTINEL);
    expect(CORRUPT_PLAIN[0]).not.toBe(PACKED_BROTLI_SENTINEL);
    expect(() => unpack(CORRUPT_PLAIN)).toThrow();
    return expect(decompressPacked(CORRUPT_COMPRESSED)).rejects.toThrow();
  });
});
