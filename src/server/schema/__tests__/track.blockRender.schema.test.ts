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
    expect(blockRenderSchema.parse({ ...base, status: 'error', errorClass: 'no_token' }).secondary).toBe(
      false
    );
  });

  it('accepts an explicit `secondary: true` follow-up beacon', () => {
    expect(blockRenderSchema.parse({ ...base, status: 'error', secondary: true }).secondary).toBe(
      true
    );
  });

  it('rejects an over-long errorClass (bounded to 64 chars)', () => {
    expect(
      blockRenderSchema.safeParse({ ...base, errorClass: 'x'.repeat(65) }).success
    ).toBe(false);
  });
});
