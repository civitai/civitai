import { pack } from 'msgpackr';
import { describe, expect, it } from 'vitest';
import {
  PACKED_BROTLI_SENTINEL,
  compressPacked,
  decompressPacked,
  type PackedCodecTimer,
} from '../packed-compression';

/**
 * Unit coverage for the codec's OWN timing contract (the `civitai_app_packed_codec_duration_seconds`
 * histogram is fed from these callbacks — see ../client for the prom wiring, and
 * ./packed-codec-metrics.test.ts for the end-to-end seam).
 *
 * Why the timing has to be measured HERE rather than inferred from anything already present:
 * the codec is `promisify(zlib.brotli*)`, so it executes on the libuv threadpool with no JS
 * stack — a V8 CPU profile contains no `brotli*` frame at all. And the redis command histogram
 * closes at the round trip, before decode; a compressed payload is also smaller on the wire, so
 * that histogram gets BETTER as this codec gets more expensive.
 *
 * The contract pinned below:
 *   - compress always records exactly one `compress` sample,
 *   - decompress records exactly one `decompress` sample ONLY when brotli actually ran,
 *   - the LEGACY raw-msgpack passthrough records NOTHING (see the test for why that matters),
 *   - the recorded value is in SECONDS, bounded above by the caller's own wall clock.
 */

type Sample = { op: 'compress' | 'decompress'; seconds: number };

function recorder() {
  const samples: Sample[] = [];
  const timer: PackedCodecTimer = (op, seconds) => samples.push({ op, seconds });
  return { samples, timer };
}

// Real redundancy so brotli has measurable work to do — a few random bytes would compress in
// well under the clock's resolution and make the bounds assertions a coin flip.
const repetitive = Buffer.from(
  pack({
    data: {
      tensors: Array.from(
        { length: 4000 },
        (_, i) => `model.diffusion_model.blocks.${i}.attn.to_q.weight`
      ),
    },
    cachedAt: 1_700_000_000_000,
  })
);

describe('packed codec timing callback', () => {
  it('compressPacked records exactly one compress sample', async () => {
    const { samples, timer } = recorder();
    await compressPacked(repetitive, timer);
    expect(samples.map((s) => s.op)).toEqual(['compress']);
  });

  it('decompressPacked records exactly one decompress sample when brotli actually ran', async () => {
    const { samples, timer } = recorder();
    const compressed = await compressPacked(repetitive);
    expect(compressed[0]).toBe(PACKED_BROTLI_SENTINEL); // precondition: this IS the codec path
    await decompressPacked(compressed, timer);
    expect(samples.map((s) => s.op)).toEqual(['decompress']);
  });

  // 🔴 THE ONE THAT CHANGES WHAT THE NUMBER MEANS. `decompressPacked` returns a legacy
  // (pre-compression) value untouched after a single byte comparison. Recording those as
  // `decompress` observations would fill the histogram with near-zero samples measuring the cost
  // of NOT decompressing, dragging p50/p95 toward zero — the metric would then answer "how often
  // is this cache still legacy", which is not the question it exists for.
  it('decompressPacked records NOTHING for a legacy raw-msgpack value (no sentinel)', async () => {
    const { samples, timer } = recorder();
    const legacy = Buffer.from(pack({ data: { hello: 'world' }, cachedAt: 1 }));
    expect(legacy[0]).not.toBe(PACKED_BROTLI_SENTINEL); // precondition: this is the passthrough
    const out = await decompressPacked(legacy, timer);
    expect(Buffer.compare(out, legacy)).toBe(0); // passthrough still correct
    expect(samples).toEqual([]);
  });

  it('decompressPacked records NOTHING for an empty buffer', async () => {
    const { samples, timer } = recorder();
    await decompressPacked(Buffer.alloc(0), timer);
    expect(samples).toEqual([]);
  });

  // SECONDS, not milliseconds — prom convention, and the histogram's buckets are seconds. Bounded
  // against the caller's OWN wall clock rather than a fixed threshold, so it is load-independent:
  // a millisecond value would exceed the elapsed-seconds bound by ~1000x on any machine.
  it('records SECONDS: 0 < sample <= the caller-observed elapsed time, both ops', async () => {
    const { samples, timer } = recorder();

    const compressStart = performance.now();
    const compressed = await compressPacked(repetitive, timer);
    const compressElapsedSeconds = (performance.now() - compressStart) / 1000;

    const decompressStart = performance.now();
    await decompressPacked(compressed, timer);
    const decompressElapsedSeconds = (performance.now() - decompressStart) / 1000;

    const compressSample = samples.find((s) => s.op === 'compress');
    const decompressSample = samples.find((s) => s.op === 'decompress');
    expect(compressSample, 'a compress sample was recorded').toBeDefined();
    expect(decompressSample, 'a decompress sample was recorded').toBeDefined();

    expect(compressSample!.seconds).toBeGreaterThan(0);
    expect(compressSample!.seconds).toBeLessThanOrEqual(compressElapsedSeconds);
    expect(decompressSample!.seconds).toBeGreaterThan(0);
    expect(decompressSample!.seconds).toBeLessThanOrEqual(decompressElapsedSeconds);
  });

  it('is optional: both functions still work with no timer passed', async () => {
    const compressed = await compressPacked(repetitive);
    const restored = await decompressPacked(compressed);
    expect(Buffer.compare(restored, repetitive)).toBe(0);
  });
});
