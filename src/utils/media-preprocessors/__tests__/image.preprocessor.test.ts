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

import { preprocessFile } from '~/utils/media-preprocessors';
import {
  isAnimatedAvif,
  isAnimatedImage,
  preprocessImage,
} from '~/utils/media-preprocessors/image.preprocessor';

/** An ISO-BMFF file: its leading ftyp box, then whatever follows it. */
function isoFile(major: string, compatible: string[], rest = '') {
  const size = 16 + 4 * compatible.length;
  const bytes = new Uint8Array(size + rest.length);
  new DataView(bytes.buffer).setUint32(0, size);
  const ascii = `ftyp${major}\0\0\0\0${compatible.join('')}${rest}`;
  for (let i = 0; i < ascii.length; i++) bytes[4 + i] = ascii.charCodeAt(i);
  return new File([bytes], 'a.avif', { type: 'image/avif' });
}
// Brand lists as libavif writes them.
const stillAvif = () => isoFile('avif', ['mif1', 'avif', 'miaf']);
const animatedAvif = () => isoFile('avis', ['avif', 'avis', 'msf1', 'iso8', 'mif1', 'miaf']);

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

describe('AVIF', () => {
  beforeEach(() => {
    mocks.createImageElement.mockReset().mockResolvedValue({ width: 4, height: 3 });
    mocks.getMetadata.mockReset().mockResolvedValue({});
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview');
  });
  afterEach(() => vi.restoreAllMocks());

  it('is preprocessed as an image', async () => {
    const result = await preprocessFile(stillAvif());
    expect(result).toMatchObject({
      type: 'image',
      mimeType: 'image/avif',
      metadata: { width: 4, height: 3 },
    });
  });

  it('is refused when animated', async () => {
    await expect(preprocessFile(animatedAvif())).rejects.toThrow(
      'Animated AVIF files are not supported'
    );
  });

  it.each([
    ['a still image', stillAvif(), false],
    ['an image sequence', animatedAvif(), true],
    ['a sequence that names avis only as a compatible brand', isoFile('mif1', ['avis']), true],
    ['a file with no ftyp box', new File(['\0\0\0\x18ftap'.padEnd(32)], 'a.avif'), false],
    // 'avis' past the end of the ftyp box is another box's payload, not a brand.
    ['a still image with avis in a later box', isoFile('avif', ['mif1'], 'avis'), false],
  ])('isAnimatedAvif reads %s', async (_, input, expected) => {
    expect(await isAnimatedAvif(input)).toBe(expected);
  });

  it('isAnimatedImage dispatches on the AVIF type', async () => {
    expect(await isAnimatedImage(animatedAvif())).toBe(true);
    expect(await isAnimatedImage(stillAvif())).toBe(false);
  });
});
