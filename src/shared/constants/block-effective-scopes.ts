/**
 * The EFFECTIVE scope set of an App Block: `manifest.scopes ∩ approved_scopes`.
 *
 * 🔴 WHY AN INTERSECTION AND NOT EITHER COLUMN ALONE. The two columns diverge in BOTH
 * directions, so neither one alone describes what the app can do:
 *
 *   - `manifest.scopes` is the developer's DECLARATION. It is replaced on every publisher
 *     push — `src/pages/api/v1/developer/block-manifests.ts` updates `manifest` + `version`
 *     and sets `status: 'pending'` WITHOUT touching `approved_scopes`.
 *   - `approved_scopes` is the moderator-reviewed SNAPSHOT. The three approve paths in
 *     `src/server/services/blocks/publish-request.service.ts` write it as
 *     `approvedScopes = manifestScopes` — the manifest's own array, verbatim — and that
 *     flow is the only writer.
 *
 * So a v2 manifest that ADDS a scope gives `manifest ⊋ approved` (the approval is stale and
 * narrower), and a v2 manifest that DROPS one gives `manifest ⊊ approved` (the approval is
 * stale and WIDER, naming a scope the current manifest no longer requests). Showing or
 * enforcing either column alone is wrong in one of those two rows; the intersection is
 * correct in both.
 *
 * 🔴 THIS IS NOT "WHAT THE MINT WILL ISSUE A TOKEN FOR" — do not re-describe it that way, and
 * note that "THE mint" is itself the ambiguity that produced the false claim. There are TWO
 * scope-sourcing paths in `src/pages/api/v1/block-tokens/index.ts`:
 *
 *   - The PRODUCTION run-token mint (the install/subscription/page path) derives the signed set
 *     from the MANIFEST — `requestedScopes = knownManifestScopes`, the manifest filtered to the
 *     known vocabulary — and uses `approved_scopes` as an ALL-OR-NOTHING VETO
 *     (`outsideApproved.length > 0` → 403), never as a source. It also refuses outright unless
 *     `status === 'approved'`.
 *   - The DEV-TUNNEL author mint (`resolveDevPageBlockForAuthor`) DOES source from the column:
 *     `clampTunnelDeclaredScopes(app.approvedScopes)`. `block-registry.service.ts`'s sentence
 *     "The mint sources scopes from `approvedScopes` … NEVER the raw manifest" is TRUE, and is
 *     about THIS path — it sits in that path's own docblock. Reading it as a statement about the
 *     production mint is the error; the sentence itself is not wrong.
 *
 * The production signed set is narrower than this function's result in any case:
 * `manifest ∩ known-vocabulary ∩ approved ∩ per-user-grant ∩ anon/page rules`. This function
 * computes the first and third terms only, so the honest claim is "the scopes this app may be
 * granted and exercised with", NOT "the scopes a token will carry".
 *
 * 🔴 THERE IS NO PER-SCOPE MODERATOR NARROWING MECHANISM. An earlier generation of comments
 * at several call sites claimed `approved_scopes` was a moderator-narrowed subset of the
 * manifest. It is not — see the verbatim write above. The only skew is the publisher-push
 * path. `src/server/services/blocks/app-listing.service.ts` carries the same retraction for
 * its own (deliberately NON-intersected) public pre-launch disclosure.
 *
 * 🔴 DEPENDENCY-FREE LEAF MODULE, DELIBERATELY. It must not live on a service module:
 * `src/server/routers/blocks.router.ts` reaches
 * `src/server/services/blocks/user-app-surface.service.ts` ONLY through `await import(...)`,
 * never a static import, and a single eager import of that service would make every one of
 * those call sites inert and break the one-key `vi.mock` factories in the router suites.
 * (Deliberately no count here — a count in a comment goes stale; the call sites are asserted
 * in `src/shared/constants/__tests__/block-effective-scopes.call-sites.test.ts`.) Keep this
 * file free of runtime imports.
 */

/** A manifest as it comes off the JSON column — shape is not a runtime guarantee. */
export type BlockScopeManifestInput = { scopes?: unknown } | null | undefined;

/**
 * `manifest.scopes ∩ approvedScopes`, de-duplicated, in MANIFEST ORDER.
 *
 * 🔴 ORDER AND DE-DUPLICATION ARE OBSERVABLE — the permissions tab and the install modal
 * both render this array as a list of badges, so both are part of the contract and are
 * pinned by tests rather than left to chance:
 *
 *   - **Manifest order.** It is what the two pre-existing open-coded sites already produced
 *     (`getInstallConfig` and `recordInstallConsent` both `filter` the manifest array), and
 *     what the mint uses (`requestedScopes = knownManifestScopes`). Adopting it is what makes
 *     every site agree; sorting would have changed three sites to suit one.
 *   - **De-duplicated, first occurrence wins.** A repeated scope would render a duplicate
 *     React `key` on the same badge list. The pre-existing sites did NOT de-duplicate; this
 *     is the one deliberate behaviour change of the consolidation, and it is a no-op for
 *     every current consumer (a `Set` ceiling, a `recordScopeGrant` that unions, and a
 *     manifest the validator already rejects duplicates in).
 *
 * Both arguments are treated as untrusted JSON/DB values: a non-array on either side yields
 * `[]` rather than throwing, and non-string elements are dropped. That is deliberate even
 * though Prisma types `approvedScopes` as `string[]` — the approve paths write
 * `manifest.scopes as string[]`, a bare cast with no per-element check, so a malformed
 * manifest can put a non-string into the column.
 *
 * NOT filtered to the known scope vocabulary (`isKnownBlockScope`). None of the call sites
 * did that, and adding it here would silently change what they enforce and disclose; the
 * mint applies that filter itself.
 */
export function effectiveBlockScopes(
  manifest: BlockScopeManifestInput,
  approvedScopes: unknown
): string[] {
  const declared = (manifest ?? {}).scopes;
  if (!Array.isArray(declared) || !Array.isArray(approvedScopes)) return [];
  const approved = new Set(approvedScopes.filter((s): s is string => typeof s === 'string'));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const scope of declared) {
    if (typeof scope !== 'string') continue;
    if (!approved.has(scope) || seen.has(scope)) continue;
    seen.add(scope);
    out.push(scope);
  }
  return out;
}
