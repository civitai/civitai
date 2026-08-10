import { afterEach, describe, expect, it, vi } from 'vitest';
import { getFlipt } from '../flipt';

// The wiring guard for @civitai/flipt: without FLIPT_URL the shim must still resolve, hand back a
// client, and answer every flag `false` rather than throwing into whatever page evaluated it.
describe('getFlipt', () => {
  afterEach(() => {
    delete (globalThis as { flipt?: unknown }).flipt;
    vi.restoreAllMocks();
  });

  it('reuses one instance across calls', () => {
    expect(getFlipt()).toBe(getFlipt());
  });

  it('fails closed when Flipt is unconfigured', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await getFlipt().isEnabled('any-flag')).toBe(false);
    expect(await getFlipt().getVariant('any-flag')).toBeNull();
  });
});
