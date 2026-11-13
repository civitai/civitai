/**
 * The rule a block slug follows, which submit and the dev tunnel enforce: civitai's `SLUG_REGEX`
 * (`src/server/schema/blocks/publish-request.schema.ts`) is this one.
 */
export const BLOCK_SLUG = /^[a-z][a-z0-9-]*[a-z0-9]$/;

const BLOCK_ID_MIN = 3;
const BLOCK_ID_MAX = 40;
const FALLBACK_APP_KEY = 'my-app';

/**
 * Whether `key` can also be the app's `blockId`, which a live preview needs: the same rule submit
 * and the dev tunnel enforce on a slug.
 */
export function isAppBlockId(key: string): boolean {
  return key.length >= BLOCK_ID_MIN && key.length <= BLOCK_ID_MAX && BLOCK_SLUG.test(key);
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

/** The key an app named `name` gets when no other app has it. */
export function appKeyBase(name: string): string {
  const base = slugify(name, BLOCK_ID_MAX);
  return base.length < BLOCK_ID_MIN ? FALLBACK_APP_KEY : base;
}

/** The `n`th copy's key: the base, cut to leave room, then `-n`. */
function numberedAppKey(base: string, n: number): string {
  const suffix = `-${n}`;
  return `${slugify(base, BLOCK_ID_MAX - suffix.length)}${suffix}`;
}

/**
 * A readable key for a new app named `name`, unused among `taken`. It is always a valid `blockId`, so
 * the app can be previewed under the same name.
 */
export function newAppKey(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = appKeyBase(name);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const key = numberedAppKey(base, n);
    if (!used.has(key)) return key;
  }
}
