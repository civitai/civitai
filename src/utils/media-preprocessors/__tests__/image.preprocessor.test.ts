// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ImageUtils from '~/utils/image-utils';

/**
 * The preview url preprocessImage returns holds the file's bytes for as long as it lives, so it is
 * made only for a file that prepared: a failure leaves no url (an in-memory copy of a pick, say,
 * would otherwise stay in memory with nothing to release it).
 */

const mocks = vi.hoisted(() => ({ createImageElement: vi.fn(), getMetadata: vi.fn() }));
vi.mock('~/utils/image-utils', async (orig) => ({
  ...(await orig<typeof ImageUtils>()),
  createImageElement: mocks.createImageElement,
}));
vi.mock('~/utils/metadata', () => ({ getMetadata: mocks.getMetadata }));
vi.mock('~/utils/blurhash', () => ({ createBlurHash: () => 'LKO2' }));

import { preprocessImage } from '~/utils/media-preprocessors/image.preprocessor';

describe('preprocessImage — its preview url', () => {
  let createUrl: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    mocks.createImageElement.mockReset().mockResolvedValue({ width: 4, height: 3 });
    mocks.getMetadata.mockReset().mockResolvedValue({});
    createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview');
  });
  afterEach(() => vi.restoreAllMocks());

  const file = () => new File(['x'], 'p.jpg', { type: 'image/jpeg' });

  it('is made for a file that prepares', async () => {
    const photo = file();
    const result = await preprocessImage(photo);
    expect(result.objectUrl).toBe('blob:preview');
    expect(createUrl.mock.calls).toEqual([[photo]]);
    expect(result.metadata).toMatchObject({ width: 4, height: 3 });
  });

  it.each([
    [
      'its image cannot be loaded',
      () => mocks.createImageElement.mockRejectedValue(new Error('x')),
    ],
    ['its metadata cannot be read', () => mocks.getMetadata.mockRejectedValue(new Error('x'))],
  ])('is not made when %s', async (_, fail) => {
    fail();
    await expect(preprocessImage(file())).rejects.toThrow('x');
    expect(createUrl).not.toHaveBeenCalled();
  });
});
