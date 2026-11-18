import { z } from 'zod';
import { MAX_INT4 } from '$lib/server/users.service';

export const BAD_IMAGE = 'Enter an image id or an image page URL.';

/** The image id in a pasted id or civitai image page URL (`/images/<id>`), or null. */
export function parseImageRef(value: unknown): number | null {
  const text = typeof value === 'string' ? value.trim() : '';
  const id = /^\d+$/.test(text)
    ? Number(text)
    : Number(text.match(/\/images\/(\d+)(?:[/?#]|$)/)?.[1]);
  return Number.isInteger(id) && id > 0 && id <= MAX_INT4 ? id : null;
}

export const imageRef = z.preprocess(
  (value) => parseImageRef(value) ?? NaN,
  z.number({ error: BAD_IMAGE }).int(BAD_IMAGE).positive(BAD_IMAGE).max(MAX_INT4, BAD_IMAGE)
);
