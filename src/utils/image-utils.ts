import sharp from 'sharp';
import { encode } from 'blurhash';
import arrayBufferToBuffer from 'arraybuffer-to-buffer';

import { getClampedSize } from '~/utils/blurhash';

export async function imageToBlurhash(url: string | Parameters<typeof sharp>[0]) {
  if (typeof url === 'string')
    url = arrayBufferToBuffer(await fetch(url).then((r) => r.arrayBuffer()));

  const image = await sharp(url);
  const { width, height } = await image.metadata();
  if (width === undefined || height === undefined) throw new Error('Image has no metadata');

  const { width: cw, height: ch } = getClampedSize(width, height, 64);
  const shrunkImage = await image.raw().ensureAlpha().resize(cw, ch, { fit: 'inside' }).toBuffer();
  const hash = encode(new Uint8ClampedArray(shrunkImage), cw, ch, 4, 4);
  return { hash, width, height };
}
