// Slug sanitization for the App Blocks KV datastore (W4-KV-v0).
//
// Each approved app block is given a Postgres schema named `app_<slug>`
// in the cnpg-cluster-apps cluster. The slug is derived from the manifest
// blockId at submission time and validated against a tight regex so it
// can be safely concatenated into DDL (identifiers can't be parameterized
// via $1 placeholders).
//
// Rules — must match `^[a-z][a-z0-9_]{2,40}$`:
// - Lowercase only (Postgres identifier folding would otherwise quote)
// - First char must be a letter (so the schema name `app_<slug>` is a
//   simple identifier)
// - 3-41 chars total (long enough to be readable, short enough to keep
//   the fully-qualified `"app_<slug>".kv` quotation tidy)
// - Alphanumerics + underscore only — no hyphens; PG treats them as ops

const APP_SLUG_RE = /^[a-z][a-z0-9_]{2,40}$/;

/**
 * Normalize a raw blockId to a candidate slug. Lowercases + replaces
 * any non-alphanumeric char with `_`. Returns null if the result fails
 * `isValidAppSlug`. Idempotent: passing an already-valid slug returns
 * the same string.
 */
export function sanitizeAppSlug(input: string): string | null {
  if (typeof input !== 'string') return null;
  const lowered = input.toLowerCase();
  const replaced = lowered.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return isValidAppSlug(replaced) ? replaced : null;
}

/**
 * Strict validation gate — every DDL site must verify a slug with this
 * before interpolating it. Returns false for null/undefined/non-string.
 */
export function isValidAppSlug(input: unknown): input is string {
  return typeof input === 'string' && APP_SLUG_RE.test(input);
}

/**
 * Quote-and-return the schema identifier. Slug must be validated first.
 * Throws if the slug doesn't pass — the throw is a fail-shut to catch
 * upstream code paths that skipped validation. Never use the slug
 * unwrapped in DDL elsewhere.
 */
export function appSchemaIdent(slug: string): string {
  if (!isValidAppSlug(slug)) {
    throw new Error(`invalid app slug: ${JSON.stringify(slug)}`);
  }
  return `"app_${slug}"`;
}

export function appRoleIdent(slug: string): string {
  if (!isValidAppSlug(slug)) {
    throw new Error(`invalid app slug: ${JSON.stringify(slug)}`);
  }
  return `"app_${slug}_role"`;
}
