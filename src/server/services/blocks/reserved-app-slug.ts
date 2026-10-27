/**
 * App ids (manifest `blockId`, the app's slug) that a new app may not take.
 *
 * An app is served at `<slug>.<APPS_DOMAIN>`, and a new app's host is answered by a catch-all on
 * the shared static server. Any name that already has, or will get, its own DNS record under that
 * domain shadows the catch-all, so an app taking it would never be reachable:
 *   - `a-`, `aaaa-`, `cname-` — the DNS ownership records the platform writes beside each managed
 *     record are named `<record type>-<name>`;
 *   - `dev-` — dev tunnel hosts (`dev-<16 hex>`);
 *   - `review-` — moderator review previews (`review-<sha16>`, see apps-pipeline.service.ts);
 *   - `www`.
 *
 * The one place this rule lives. submitVersion, BlockManifestValidator and isValidForkSlug call it.
 */

const RESERVED_PREFIXES: ReadonlyArray<{ prefix: string; usedFor: string }> = [
  { prefix: 'a-', usedFor: 'DNS ownership records' },
  { prefix: 'aaaa-', usedFor: 'DNS ownership records' },
  { prefix: 'cname-', usedFor: 'DNS ownership records' },
  { prefix: 'dev-', usedFor: 'dev tunnel hosts' },
  { prefix: 'review-', usedFor: 'moderator review previews' },
];

const RESERVED_NAMES: ReadonlyArray<string> = ['www'];

/**
 * Why `slug` is reserved, as an author-facing sentence, or `null` when it is free to use.
 * Only checks the reserved names; the format rule (lowercase DNS label, 3–40 chars) is separate.
 */
export function reservedAppSlugReason(slug: string): string | null {
  if (RESERVED_NAMES.includes(slug)) {
    return `blockId "${slug}" is reserved. Choose a different blockId.`;
  }
  const hit = RESERVED_PREFIXES.find(({ prefix }) => slug.startsWith(prefix));
  if (hit) {
    return `blockId "${slug}" is reserved: ids starting with "${hit.prefix}" are used for ${hit.usedFor}, so the app's address would never reach it. Choose a different blockId.`;
  }
  return null;
}
