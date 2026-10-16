import { SLUG_REGEX } from '~/server/schema/blocks/publish-request.schema';

const BLOCK_ID_MIN = 3;
const BLOCK_ID_MAX = 40;
const FALLBACK_APP_KEY = 'my-app';

/**
 * Whether `key` can also be the app's `blockId`, which a live preview needs: the same rule submit
 * and the dev tunnel enforce on a slug.
 */
export function isAppBlockId(key: string): boolean {
  return key.length >= BLOCK_ID_MIN && key.length <= BLOCK_ID_MAX && SLUG_REGEX.test(key);
}

function slugify(name: string, maxLength: number): string {
  const words = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // A blockId starts with a letter.
  const slug = /^[0-9]/.test(words) ? `app-${words}` : words;
  return slug.slice(0, maxLength).replace(/-+$/, '');
}

/**
 * A readable key for a new app named `name`, unused among `taken`. It is always a valid `blockId`, so
 * the app can be previewed under the same name.
 */
export function newAppKey(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  let base = slugify(name, BLOCK_ID_MAX);
  if (base.length < BLOCK_ID_MIN) base = FALLBACK_APP_KEY;
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const key = `${slugify(base, BLOCK_ID_MAX - suffix.length)}${suffix}`;
    if (!used.has(key)) return key;
  }
}
