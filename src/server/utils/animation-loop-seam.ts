import sharp from 'sharp';
import { hasEmptyLoopSeam } from '~/server/schema/creator-shop.schema';

// Reaching a late page decodes every page before it, so pages are bounded by a timeout and the
// two trailing ones share a single decode.
const DECODE_TIMEOUT_SECONDS = 5;

const maxAlphaPerPage = async (buffer: Buffer, page: number, pages: number) => {
  const { data, info } = await sharp(buffer, { page, pages })
    .timeout({ seconds: DECODE_TIMEOUT_SECONDS })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const alpha = info.channels - 1;
  const pageBytes = data.length / pages;
  return Array.from({ length: pages }, (_, index) => {
    let max = 0;
    for (let i = index * pageBytes + alpha; i < (index + 1) * pageBytes; i += info.channels)
      if (data[i] > max) max = data[i];
    return max;
  });
};

/** Callers gate on `hasAlpha`: an opaque animation has no frame that can be empty. */
export async function detectEmptyLoopSeam(buffer: Buffer, frames: number) {
  if (frames < 3) return false;
  const [first] = await maxAlphaPerPage(buffer, 0, 1);
  if (first === 0) return false;
  const [penultimate, last] = await maxAlphaPerPage(buffer, frames - 2, 2);
  return hasEmptyLoopSeam({ first: first > 0, penultimate: penultimate > 0, last: last > 0 });
}
