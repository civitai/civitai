// Import-free so the assistant runner (which bundles only workspace packages) applies the same
// rule as the manifest validator and the submit path.

/**
 * SENSITIVE block scopes — the subset of the vocabulary that carries elevated
 * privacy/financial risk to the VIEWER, and therefore warrants distinct,
 * warning-styled emphasis wherever scopes are surfaced (the mod review modal,
 * the consent/grant prompt, and the per-app "granted permissions" panels).
 *
 * A scope is sensitive when granting it lets the app do one of:
 *   - spend the viewer's Buzz          (`ai:write:budgeted`, `social:tip:self`)
 *   - read the viewer's Buzz balance   (`buzz:read:self`)
 *   - read the viewer's PRIVATE data   (`collections:read:private`)
 *   - write data OTHER users see       (`apps:storage:shared:write`,
 *                                       `apps:storage:publish`,
 *                                       `posts:write:self`,
 *                                       `apps:store:items:write`,
 *                                       `social:react:self`)
 *
 * This set does two things. (1) PRESENTATION — it drives the distinct,
 * warning-styled emphasis wherever scopes are surfaced. (2) ENFORCEMENT — it
 * now also gates MANIFEST VALIDITY: at submit time the manifest validator
 * REQUIRES a non-empty `scopeJustifications` entry for every declared sensitive
 * scope (see `block-manifest-validator.service.ts`), so a moderator always sees
 * WHY an elevated-risk permission was requested. It does NOT change whether a
 * granted scope is enforced at call time — that stays with the server-side
 * per-op gates + consent grant. Keeping it a set (not a per-scope flag on the
 * map) keeps the enforcement map and this classification decoupled.
 *
 * INVARIANT (guarded by a test): every entry must be a currently-known scope in
 * `BLOCK_SCOPE_TO_OAUTH_BIT`. If a scope is renamed/removed (as
 * `media:read:owned` / `block:settings:*` were in #3212) it must be updated
 * here too, so a sensitive scope can never silently drop out of the set.
 */
export const SENSITIVE_BLOCK_SCOPES: ReadonlySet<string> = new Set([
  'ai:write:budgeted',
  'social:tip:self',
  'buzz:read:self',
  'collections:read:private',
  'apps:storage:shared:write',
  // The document store's successor to `apps:storage:shared:write`: documents in a shared
  // collection, authored under the viewer's identity, read by every viewer of the app.
  'apps:storage:publish',
  // Writes PUBLIC, feed-visible, reward-earning content under the VIEWER'S name.
  // The most consequential entry in this set: `apps:storage:shared:write` is
  // visible to other viewers OF THAT APP, this one is visible to the whole site
  // and carries the viewer's byline.
  'posts:write:self',
  // Spends the viewer's Buzz on an app's own catalog. The read half
  // (`goods:read:self`) is not sensitive — it returns only what the calling app
  // already sold to this viewer.
  'goods:purchase:self',
  // Writes store cards every visitor sees, under the viewer's name.
  'apps:store:items:write',
  // Sets a public, reward-paying reaction under the viewer's name.
  'social:react:self',
]);

export function isSensitiveBlockScope(scope: string): boolean {
  return SENSITIVE_BLOCK_SCOPES.has(scope);
}

/**
 * Manifest-shaped input for the sensitive-scope-justification gate. Only the two
 * fields the rule actually reads are needed, and both are `unknown` because
 * callers pass raw, not-yet-fully-validated manifests — the ZIP-extracted blob
 * at submit (`submitVersion`) and the stored/deep-validated manifest at
 * `validate`. Keeping the shape this loose is what lets ONE helper back both
 * enforcement sites.
 */
export type SensitiveScopeManifestInput = {
  scopes?: unknown;
  scopeJustifications?: unknown;
};

/**
 * Returns the DECLARED sensitive scopes that lack a non-empty
 * `scopeJustifications` entry (deduped, in declaration order). Empty when the
 * manifest is compliant, declares no sensitive scope, or has a non-array
 * `scopes`. A justification "counts" only when it is a string with non-whitespace
 * content — an empty/whitespace value, a non-string value, or a missing key all
 * leave the sensitive scope unjustified.
 *
 * SINGLE SOURCE OF TRUTH for the "sensitive scopes must be justified" rule: the
 * manifest validator (`validate`) and the submit path (`submitVersion`) both
 * call this so the two enforcement sites can never drift. Pure + client-safe.
 */
export function unjustifiedSensitiveScopes(manifest: SensitiveScopeManifestInput): string[] {
  if (!Array.isArray(manifest.scopes)) return [];
  const justifications =
    manifest.scopeJustifications &&
    typeof manifest.scopeJustifications === 'object' &&
    !Array.isArray(manifest.scopeJustifications)
      ? (manifest.scopeJustifications as Record<string, unknown>)
      : {};
  return [
    ...new Set(
      (manifest.scopes as unknown[])
        .filter((s): s is string => typeof s === 'string')
        .filter((scope) => isSensitiveBlockScope(scope))
        .filter((scope) => {
          const raw = justifications[scope];
          return !(typeof raw === 'string' && raw.trim().length > 0);
        })
    ),
  ];
}

/**
 * The exact operator-facing message both enforcement sites raise for an
 * unjustified sensitive scope. Single-sourced so the validator's
 * `errors.push(...)` string and `submitVersion`'s `throw` stay byte-identical.
 */
export function sensitiveScopeJustificationError(unjustifiedScopes: string[]): string {
  return `sensitive scopes require a justification — add a non-empty scopeJustifications entry for: ${unjustifiedScopes.join(
    ', '
  )}`;
}

/**
 * Throws (with `sensitiveScopeJustificationError`) when any declared sensitive
 * scope lacks a justification; a no-op when the manifest is compliant. This is
 * the imperative form used by `submitVersion` at submit time — the validator
 * uses `unjustifiedSensitiveScopes` directly so it can accumulate the message
 * into its `errors[]` alongside the other checks.
 */
export function assertSensitiveScopesJustified(manifest: SensitiveScopeManifestInput): void {
  const unjustifiedScopes = unjustifiedSensitiveScopes(manifest);
  if (unjustifiedScopes.length > 0) {
    throw new Error(sensitiveScopeJustificationError(unjustifiedScopes));
  }
}
