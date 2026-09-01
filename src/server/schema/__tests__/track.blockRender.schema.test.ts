import { describe, expect, it } from 'vitest';
import { blockRenderSchema } from '~/server/schema/track.schema';

/**
 * App Blocks runtime observability — blockRenderSchema `status`/`errorClass`
 * additions. `status` drives the `civitai_app_block_renders_total{result}`
 * counter; it MUST default to 'ok' so legacy/status-less beacons keep working.
 */
describe('blockRenderSchema — status/errorClass', () => {
  const base = { appBlockId: 'apb_x', blockInstanceId: 'page_apb_x', slotId: 'app.page' };

  it('defaults status to "ok" when omitted', () => {
    const parsed = blockRenderSchema.parse(base);
    expect(parsed.status).toBe('ok');
    expect(parsed.errorClass).toBeUndefined();
  });

  it('accepts status:"error" and a bounded errorClass', () => {
    const parsed = blockRenderSchema.parse({ ...base, status: 'error', errorClass: 'timeout' });
    expect(parsed.status).toBe('error');
    expect(parsed.errorClass).toBe('timeout');
  });

  it('rejects a status outside the ok|error enum', () => {
    expect(blockRenderSchema.safeParse({ ...base, status: 'weird' }).success).toBe(false);
  });

  it('defaults `secondary` to false so an ordinary beacon still writes its CH row', () => {
    // The CH insert is suppressed only for an explicit follow-up. A legacy or
    // launch-failure beacon that sends no flag must keep being recorded.
    expect(blockRenderSchema.parse(base).secondary).toBe(false);
    expect(
      blockRenderSchema.parse({ ...base, status: 'error', errorClass: 'no_token' }).secondary
    ).toBe(false);
  });

  it('accepts an explicit `secondary: true` follow-up beacon', () => {
    expect(blockRenderSchema.parse({ ...base, status: 'error', secondary: true }).secondary).toBe(
      true
    );
  });

  it('rejects an over-long errorClass (bounded to 64 chars)', () => {
    expect(blockRenderSchema.safeParse({ ...base, errorClass: 'x'.repeat(65) }).success).toBe(
      false
    );
  });
});

/**
 * 🔴 `initPosts` — THE COUNT THAT DISCRIMINATES `init_wait`.
 *
 * Its schema rule is deliberately LOOSE, and that looseness is the point rather
 * than an oversight. The whole `timings` object carries `.catch(undefined)`, so
 * ANY strict rule inside it converts a malformed value into "no timings at all"
 * — one bad COUNT would silently delete that launch's DURATION samples too. The
 * real gate is `launchInitPostsSample` server-side (integer, >0, bounded,
 * dropped-not-clamped), mirrored client-side by `boundedInitPosts`.
 */
describe('blockRenderSchema — initPosts', () => {
  const base = { appBlockId: 'apb_1', blockInstanceId: 'page_apb_1', slotId: 'app.page' };

  it('accepts a post count alongside the durations', () => {
    const parsed = blockRenderSchema.parse({
      ...base,
      timings: { totalMs: 1_100, initWaitMs: 700, initPosts: 4 },
    });
    expect(parsed.timings).toEqual({ totalMs: 1_100, initWaitMs: 700, initPosts: 4 });
  });

  it('is optional — a beacon without it still parses with its durations intact', () => {
    const parsed = blockRenderSchema.parse({ ...base, timings: { totalMs: 1_100 } });
    expect(parsed.timings).toEqual({ totalMs: 1_100 });
    expect(parsed.timings).not.toHaveProperty('initPosts');
  });

  /**
   * 🔴 THE SUBORDINATION RULE. A junk count must cost the beacon NOTHING beyond
   * itself — not a 400, and not the durations. Failing this makes an
   * observability add-on capable of breaking the analytics series it rides on.
   */
  it('🔴 a malformed initPosts degrades the timings to undefined — it never 400s the beacon', () => {
    const parsed = blockRenderSchema.parse({
      ...base,
      timings: { totalMs: 1_100, initPosts: 'lots' },
    });
    // `.catch(undefined)` swallows the whole object rather than rejecting…
    expect(parsed.timings).toBeUndefined();
    // …and the IMPRESSION — the thing the beacon actually exists for — survives
    // completely intact. This is the assertion that matters.
    expect(parsed.appBlockId).toBe('apb_1');
    expect(parsed.blockInstanceId).toBe('page_apb_1');
    expect(parsed.slotId).toBe('app.page');
    expect(parsed.status).toBe('ok');
  });

  it('🔴 does NOT enforce integrality here (that is the server gate, deliberately)', () => {
    // A strict `.int()` would send 2.5 down the `.catch(undefined)` path and
    // take the durations with it. Accepted here, DROPPED by
    // `launchInitPostsSample` — so the durations are still observed and only the
    // count is lost.
    const parsed = blockRenderSchema.parse({
      ...base,
      timings: { totalMs: 1_100, initWaitMs: 700, initPosts: 2.5 },
    });
    expect(parsed.timings?.initPosts).toBe(2.5);
    expect(parsed.timings?.initWaitMs).toBe(700);
  });
});
