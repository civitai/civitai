import client from 'prom-client';
import { describe, expect, it, vi } from 'vitest';
import type * as PromClient from '~/server/prom/client';

/**
 * 🔴 THE SEAM THE WHOLE `packed_codec_duration_seconds` METRIC HANGS ON.
 *
 * `@civitai/redis` must not statically import prom-client (it is reachable from the client
 * bundle), so it reads its metric handles off a `globalThis.__civitaiRedisMetrics` bag that THIS
 * module publishes, and every read is optional-chained:
 *
 *     getRedisMetrics()?.packedCodecDuration?.observe(...)
 *
 * That `?.` is what makes the seam dangerous. Delete one line from the published object and every
 * codec sample vanishes — no throw, no warning, no failing test anywhere in either package,
 * because the package's own suite installs a FAKE bridge (correctly: it is testing the client, not
 * the app). The observable result is a histogram with no series, which is exactly what "no cache
 * opted into compress" looks like. So the publish itself needs a guard, and it has to be on the
 * REAL module rather than a stub of it.
 *
 * Two halves, because either alone is walkable:
 *   - a LEDGER of the PUBLISHED key set, asserted for equality so it fails when what
 *     `src/server/prom/client.ts` publishes SHRINKS (the deletion above) or GROWS;
 *   - a BEHAVIOURAL check that the published `packedCodecDuration` handle is a real registered
 *     histogram whose observations reach the scraped exposition text. A structural check alone
 *     passes against a key holding `undefined`, a stub, or a metric on a registry nobody serves.
 *
 * 🔴 WHAT THIS FILE DOES *NOT* COVER, AND WHERE THAT LIVES INSTEAD. An earlier version of this
 * comment claimed the ledger also caught "a handle added here but never consumed, or vice versa".
 * The "vice versa" half was false. Both halves above only ever look at the PUBLISHER:
 * `PUBLISHED_HANDLES` is a hand-written literal compared against the object
 * `src/server/prom/client.ts` builds, and one person edits both, so this file cannot see the other
 * direction at all — `@civitai/redis` growing a handle that nothing here publishes, which is the
 * silently dead metric this whole seam exists to prevent. Measured: adding a ninth field to
 * `RedisMetricsBridge` and reading it at the codec timer, while leaving the publish at eight, left
 * this file 2/2 green and the package 193/193 green.
 *
 * That direction is enforced at COMPILE time instead, and deliberately not here: the consumer's
 * type is the only independent statement of what is read, and `src/**\/__tests__/**` is excluded
 * from `tsconfig.json`, so a type-level assertion written in THIS file would never be evaluated by
 * `pnpm typecheck` — coverage that reads as coverage while providing none. The live check is the
 * `satisfies RedisMetricsBridge & Record<keyof RedisMetricsBridge, unknown>` on the published
 * object in `src/server/prom/client.ts`; growing the package's type without publishing the handle
 * fails the typecheck there. The runtime equality below then fails too, as the second step, once
 * the publish grows to satisfy it — which is what keeps the ledger in this file honest.
 */

// `src/__tests__/setup.ts` replaces this module wholesale with call-recording stubs, to keep the
// DB-pool glue it builds at module scope out of unrelated tests. A stub cannot answer either
// question above — it has no globalThis publish and no registry — so the real module is loaded.
// Same technique, and the same reason, as
// src/server/__tests__/metrics-endpoint-prisma-failure.test.ts.
vi.mock('~/server/prom/client', async (importOriginal) => ({
  ...(await importOriginal<typeof PromClient>()),
}));

/**
 * Every handle `src/server/prom/client.ts` publishes. Asserted as a SET, so it fails whether the
 * publish loses a key or gains one — but note what that is and is not: this is a ledger of the
 * PUBLISHER, kept by hand, not a reading of `RedisMetricsBridge`. It cannot tell you the consumer
 * reads exactly these; see the second half of the block comment above for where that is checked.
 */
const PUBLISHED_HANDLES = [
  'packedCodecDuration',
  'redisCommandDuration',
  'redisCommandsInflight',
  'redisRoutingRetryCounter',
  'redisSelfHealDeadlineHitsWindow',
  'redisSelfHealReconnectCounter',
  'sysredisSentinelClientErrorsCounter',
  'sysredisSentinelTopologyChangesCounter',
] as const;

const CODEC_METRIC = 'civitai_app_packed_codec_duration_seconds';

type Bridge = Record<string, unknown> | undefined;

async function loadBridge(): Promise<Bridge> {
  // Importing the module for its publish side effect is the point; it has no export for this.
  await import('~/server/prom/client');
  return (globalThis as unknown as { __civitaiRedisMetrics?: Record<string, unknown> })
    .__civitaiRedisMetrics;
}

describe('the redis metrics bridge this app publishes on globalThis', () => {
  it('publishes exactly the handle set @civitai/redis reads, with no undefined values', async () => {
    const bridge = await loadBridge();

    expect(bridge, 'the bridge object exists at all').toBeDefined();
    expect(Object.keys(bridge as Record<string, unknown>).sort()).toEqual([...PUBLISHED_HANDLES]);

    // A key present but holding `undefined` satisfies the key check and still short-circuits at
    // the consumer's `?.` — the identical silent failure, one level down.
    for (const handle of PUBLISHED_HANDLES) {
      expect(
        (bridge as Record<string, unknown>)[handle],
        `${handle} is a live handle`
      ).toBeDefined();
    }
  });

  it('the published packedCodecDuration handle really writes to the scraped histogram', async () => {
    const bridge = (await loadBridge()) as Record<string, unknown>;
    const handle = bridge.packedCodecDuration as {
      observe: (labels: { op: string; cache_name: string }, value: number) => void;
    };

    // Label values chosen so nothing else in the suite can have produced this series, and so the
    // negative control below is a value the metric CANNOT already hold.
    const cacheName = 'packed:caches:bridge-seam-probe';
    const before = await client.register.metrics();
    expect(
      before,
      'NEGATIVE CONTROL: the probe series does not exist before the observe'
    ).not.toContain(`cache_name="${cacheName}"`);

    handle.observe({ op: 'decompress', cache_name: cacheName }, 0.0125);

    const after = await client.register.metrics();
    // Pinned as whole lines: a check for the metric NAME alone would pass on a handle wired to a
    // different metric, and a check for the label alone would pass on a counter.
    expect(after).toContain(`${CODEC_METRIC}_count{op="decompress",cache_name="${cacheName}"} 1`);
    expect(after).toContain(
      `${CODEC_METRIC}_sum{op="decompress",cache_name="${cacheName}"} 0.0125`
    );
    // …and it landed in a bucket that can resolve it, rather than only in `+Inf`.
    expect(after).toContain(
      `${CODEC_METRIC}_bucket{le="0.025",op="decompress",cache_name="${cacheName}"} 1`
    );
    expect(after).toContain(
      `${CODEC_METRIC}_bucket{le="0.01",op="decompress",cache_name="${cacheName}"} 0`
    );
  });
});
