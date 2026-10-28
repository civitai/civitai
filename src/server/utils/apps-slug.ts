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

// Names a NEW app may not take. An app is served at `<blockId>.<APPS_DOMAIN>`, and a new app's
// host is answered by a catch-all on the shared static server. Any name that already has, or will
// get, its own DNS record under that domain shadows the catch-all, so the app would never be
// reachable: the DNS ownership records the platform writes beside each managed record
// (`<record type>-<name>`), dev tunnel hosts (`dev-<16 hex>`), moderator review previews
// (`review-<sha16>`), and `www`.
const RESERVED_BLOCK_ID_PREFIXES: ReadonlyArray<{ prefix: string; usedFor: string }> = [
  { prefix: 'a-', usedFor: 'DNS ownership records' },
  { prefix: 'aaaa-', usedFor: 'DNS ownership records' },
  { prefix: 'cname-', usedFor: 'DNS ownership records' },
  { prefix: 'dev-', usedFor: 'dev tunnel hosts' },
  { prefix: 'review-', usedFor: 'moderator review previews' },
];
const RESERVED_BLOCK_IDS: ReadonlyArray<string> = ['www'];

/**
 * Why a NEW blockId may not be registered, or `null` when it may.
 *
 * - Consecutive hyphens: `sanitizeAppSlug` folds a run of hyphens to one `_`, so `my-app` and
 *   `my--app` would share one storage schema. Among blockIds that match the manifest pattern and
 *   contain no `--`, the mapping is a plain `-` to `_` substitution and cannot collide.
 * - Reserved names (above): the app's address would never reach it.
 *
 * Apply this only where a blockId is first registered, never to a new version of an existing app.
 */
export function newBlockIdError(blockId: string): string | null {
  if (blockId.includes('--')) {
    return `blockId "${blockId}" must not contain consecutive hyphens ("--"): app storage treats a run of hyphens as a single separator, so it could share storage with another app. Use single hyphens.`;
  }
  if (RESERVED_BLOCK_IDS.includes(blockId)) {
    return `blockId "${blockId}" is reserved. Choose a different blockId.`;
  }
  const hit = RESERVED_BLOCK_ID_PREFIXES.find(({ prefix }) => blockId.startsWith(prefix));
  if (hit) {
    return `blockId "${blockId}" is reserved: ids starting with "${hit.prefix}" are used for ${hit.usedFor}, so the app's address would never reach it. Choose a different blockId.`;
  }
  return null;
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

// ── MOD REVIEW SANDBOX "run for real" preview storage namespace (#2831) ──────
//
// A moderator running an UNAPPROVED app for real gets a DISPOSABLE, per-publish-
// request storage schema so preview scribbles (a) can't read another pending
// app's data and (b) never pollute the eventual APPROVED app's production
// `app_<slug>` schema. Keyed on the publishRequestId (`pubreq_<ULID>`), NOT the
// slug — two pending apps, or a pending app and its later-approved self, get
// DIFFERENT schemas.
//
// SAFETY: the prefix is `apprev_` (NO underscore after `app`), which by
// construction can NEVER collide with a production `app_<slug>` schema — those
// always have `_` at string index 3 (`a p p _`), while `apprev_…` has `r`. So no
// approved app schema and no preview schema can ever alias, regardless of slug.
// The id is normalised to `[a-z0-9]` (identifiers can't be parameterized in DDL);
// the strict regex is the load-bearing boundary, exactly like `isValidAppSlug`.

const REVIEW_PREVIEW_ID_RE = /^[a-z0-9]{3,48}$/;

/** Normalise a publishRequestId to the identifier-safe component of its preview
 *  schema. Lowercases + strips non-alnum; returns null if the result is unusable. */
export function normalizeReviewPreviewId(publishRequestId: unknown): string | null {
  if (typeof publishRequestId !== 'string') return null;
  const norm = publishRequestId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 48);
  return REVIEW_PREVIEW_ID_RE.test(norm) ? norm : null;
}

/** Quote-and-return the DISPOSABLE per-publish-request preview schema identifier.
 *  Throws (fail-shut) if the id can't be normalised — mirrors `appSchemaIdent`. */
export function reviewPreviewSchemaIdent(publishRequestId: string): string {
  const norm = normalizeReviewPreviewId(publishRequestId);
  if (norm === null) {
    throw new Error(`invalid review preview id: ${JSON.stringify(publishRequestId)}`);
  }
  return `"apprev_${norm}"`;
}
