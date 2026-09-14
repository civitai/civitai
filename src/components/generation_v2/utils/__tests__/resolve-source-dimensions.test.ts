import { describe, expect, it, vi } from 'vitest';
import { resolveSourceDimensions } from '~/components/generation_v2/utils/resolve-source-dimensions';

const portrait = { width: 832, height: 1216 };

describe('resolveSourceDimensions', () => {
  it('uses cached dimensions without loading the image', async () => {
    const load = vi.fn();
    await expect(resolveSourceDimensions({ cached: portrait, load })).resolves.toEqual(portrait);
    expect(load).not.toHaveBeenCalled();
  });

  it('loads the image when nothing is cached', async () => {
    const load = vi.fn().mockResolvedValue(portrait);
    await expect(resolveSourceDimensions({ load })).resolves.toEqual(portrait);
  });

  it('returns undefined instead of a square placeholder when a portrait source fails to load', async () => {
    const load = vi.fn().mockRejectedValue(new Error('load failed'));
    await expect(resolveSourceDimensions({ load })).resolves.toBeUndefined();
  });

  it('treats zero-sized results as unresolved', async () => {
    const load = vi.fn().mockResolvedValue({ width: 0, height: 0 });
    await expect(
      resolveSourceDimensions({ cached: { width: 0, height: 1216 }, load })
    ).resolves.toBeUndefined();
    expect(load).toHaveBeenCalled();
  });
});
