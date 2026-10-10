/**
 * An App Block's human-readable name, from its manifest, falling back to its slug.
 *
 * 🔴 ONE RULE, FOUR CALL SITES THAT DISAGREED. The queue row and the review page tested
 * `typeof name === 'string' && name.length > 0`; the review-token mint and the scope-grant
 * surface tested `typeof name === 'string'` alone. So a manifest carrying `"name": ""`
 * rendered a blank identity on the two server surfaces and the slug on the two client ones
 * — one record, two answers, with nothing choosing between them.
 *
 * The empty-string branch is NOT reachable today, and that is worth stating rather than
 * leaving as a reassurance: `name` is required with `minLength: 1` in the canonical
 * `public/schemas/app-block/v1.json`, `submitVersion` throws
 * `manifest.name must be a non-empty string`, and `BlockManifestValidator` rejects it for
 * both the git-push and approve paths. So this consolidation changes no behaviour any
 * reachable input can observe — it removes the two copies that would answer wrongly IF the
 * value ever became reachable, and it picks the slug fallback, which is the only one of the
 * two that leaves a surface with an identity on it.
 *
 * `fallback` is a parameter because the call sites legitimately have different ones — a
 * publish request has a `slug`, an `AppBlock` has a `blockId`.
 */
export function appDisplayName(manifest: unknown, fallback: string): string {
  if (!manifest || typeof manifest !== 'object') return fallback;
  const name = (manifest as Record<string, unknown>).name;
  return typeof name === 'string' && name.length > 0 ? name : fallback;
}
