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
 * note that "THE mint" is itself the ambiguity that produced the false claim. There are THREE
 * scope-sourcing sites in `src/pages/api/v1/block-tokens/index.ts`, and none of them computes
 * this intersection. The two DEV-TUNNEL sites are each named by their RESOLVER, because both are
 * author mints and "the dev-tunnel mint" does not identify either one. The production site is
 * named by ROLE instead, because it has no single resolver: `BlockRegistry.resolvePageBlock`
 * (`:835`, the page shape) and `BlockRegistry.resolveBlockInstance` (`:908`, the
 * install/subscription shape) both converge on the one scope-sourcing line at `:1054`.
 *
 *   - `:1054` — the PRODUCTION run-token mint (the install/subscription/page path). Sources the
 *     MANIFEST: `requestedScopes = knownManifestScopes`, the manifest filtered to the known
 *     vocabulary. `approved_scopes` is an ALL-OR-NOTHING VETO here
 *     (`outsideApproved.length > 0` → 403), never a source, and the path refuses outright unless
 *     `status === 'approved'`.
 *   - `:469` — the EPHEMERAL dev-tunnel mint, resolved by `resolveDevPageBlockForAuthor`.
 *     Sources the AUTHOR'S OWN declared scopes: `clampTunnelDeclaredScopes(app.scopes)`. NOT
 *     `approvedScopes` — that app was never reviewed, so there is no approval to source.
 *   - `:650` — the OWNED-NON-APPROVED dev-tunnel mint, resolved by
 *     `resolveOwnedNonApprovedPageBlock`. Sources the column:
 *     `clampTunnelDeclaredScopes(app.approvedScopes)`. This is the ONLY one of the three that
 *     reads `approvedScopes` as its scope source.
 *
 * `block-registry.service.ts`'s sentence "The mint sources scopes from `approvedScopes` … NEVER
 * the raw manifest" is TRUE of `:650` ONLY. It sits at
 * `src/server/services/block-registry.service.ts:329`, in the docblock of
 * `OwnedNonApprovedPageBlockResolution` — that path's own type, not the ephemeral path's and not
 * the production path's. Reading it as a statement about either of those is the error; the
 * sentence itself is not wrong.
 *
 * 🔴 WHY THE ATTRIBUTION MATTERS, AND THE ONE THING NOT TO TRANSPLANT.
 * `block-tokens/index.ts:640-650` carries a LOAD-BEARING SPEND-SAFETY INVARIANT stated in terms
 * of the column — `approvedScopes` non-empty ⟹ the app was moderator-approved at some point, so
 * `clampTunnelDeclaredScopes([])` cannot invent `ai:write:budgeted` for a never-approved app.
 * That argument is written at, and is about, `:650`. It CANNOT be carried over to `:469`, which
 * does not read the column at all — do not infer `:469`'s spend safety from `:650`'s comment.
 *
 * ⚠️ AN EARLIER REVISION ADDED "What `:469`'s own spend safety rests on is NOT established here",
 * and a restatement of it dropped the "here" — which read as an open question and invited the next
 * reader to answer it in. It IS established, in two places, both read rather than inferred:
 *   - `src/pages/api/v1/block-tokens/index.ts:375-389` — the `resolveDevPageBlockForAuthor` branch's
 *     own docblock. SPEND CONTAINMENT (`:375-382`): the token is self-bound (`sub` = the session
 *     user), so `submitWorkflow` spends the AUTHOR's OWN Buzz, gated by
 *     `assertViewerIsAppDeveloper(sub)` plus the per-call (`DEV_BUZZ_BUDGET_CAP`) / per-session /
 *     per-day caps. SCOPE SOURCE (`:383-389`): real spend on a brand-new, never-reviewed app is
 *     additionally gated by the `app-blocks-dev-tunnel-unsubmitted-spend` flag.
 *   - `src/server/services/block-registry.service.ts:2117-2119` — where that flag gate actually
 *     bites: `if (!opts?.unsubmittedSpendAllowed) ephemeralScopes = ephemeralScopes.filter((s) =>
 *     s !== 'ai:write:budgeted')`. ⚠️ It sits in the `else` (BRAND-NEW) branch only. The PENDING
 *     branch (`:2104-2114`) applies no such strip, so for an author's own pending submission the
 *     caps-and-author-flag argument above is the whole of it.
 * `:455-480` is the call side of the same thing (the resolver call at `:455-459` passes
 * `unsubmittedSpendAllowed`; `resolveDevBuzzBudget` runs on the clamp's output at `:470`).
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
 *   - **De-duplicated, first occurrence wins.** The pre-existing sites did NOT de-duplicate, so
 *     this is the one deliberate behaviour change of the consolidation — and it is a real FIX,
 *     not a no-op, because a duplicate IS reachable:
 *       · `BlockManifestValidator.validate` ACCEPTS a duplicated scope. Measured:
 *         `scopes: ['models:read:self','models:read:self']` returns `{valid:true}`, against a
 *         negative control (`scopes:['models:read:all']` → `{valid:false}`) proving the
 *         validator can reject. `block-manifest-validator.service.ts:478-496` is a per-element
 *         loop with no uniqueness check, and `public/schemas/app-block/v1.json`
 *         `properties.scopes` declares no `uniqueItems`.
 *       · So pre-change `getInstallConfig` could return `['x','x']`, and that array reaches
 *         `src/components/Apps/AppSettingsModal.tsx` (`declaredScopes = installConfig?.scopes`)
 *         → `src/components/Apps/BlockScopeList.tsx`, which renders one `<Group key={scope}>`
 *         per element — i.e. two siblings with the SAME React key.
 *     Two consumers would have absorbed the duplicate anyway — `grantScopes` puts the result in
 *     a `new Set` ceiling (`src/server/routers/blocks.router.ts:2787-2789`) and
 *     `recordScopeGrant` de-dups its own input
 *     (`src/server/services/blocks/scope-grant.service.ts:222-224`) — but the RENDER path had no
 *     such absorber, which is what makes de-duplicating here load-bearing rather than cosmetic.
 *
 * Both arguments are treated as untrusted JSON/DB values: a non-array on either side yields
 * `[]` rather than throwing, and a non-string element never reaches the output. That is
 * deliberate even though Prisma types `approvedScopes` as `string[]` — the approve paths write
 * `manifest.scopes as string[]`, a bare cast with no per-element check, so a malformed
 * manifest can put a non-string into the column.
 *
 * 🔴 THERE IS EXACTLY ONE NON-STRING GUARD, AND THAT IS A DELIBERATE REDUCTION FROM TWO.
 * An earlier revision also filtered the APPROVED side to strings before building the Set. That
 * filter could not change this function's output for ANY input, and the test titled "drops
 * non-string elements on the APPROVED side" could not reach it. Measured, with the fixture
 * `effectiveBlockScopes({scopes:[42,'buzz:read:self']}, [42,'buzz:read:self'])`:
 *
 *   | variant                                   | result                      |
 *   | both guards present                       | `['buzz:read:self']`        |
 *   | approved-side filter deleted only         | `['buzz:read:self']`        |
 *   | manifest-side `typeof` guard deleted only | `['buzz:read:self']`        |
 *   | BOTH deleted                              | `[42,'buzz:read:self']` ← leak |
 *
 * The two were MUTUALLY REDUNDANT: a non-string in the approved Set is unmatchable because the
 * only values tested against it are strings, and a non-string manifest entry is unmatchable
 * because the Set held only strings. So neither could be killed alone and each made the other
 * untestable. Keeping the loop guard (it is the one standing between the column and `out.push`)
 * and dropping the filter leaves a SINGLE guard that the fixture above kills on its own — i.e. a
 * guard proven reachable, not merely breakable. Do not re-add the approved-side filter without a
 * fixture that fails when ONLY that filter is removed. ⚠️ An earlier revision said flatly "there
 * is no such input"; that absolute is wrong. A hand-built `Proxy` whose reads differ between the
 * `filter` pass and the `new Set` pass can make the filtered Set LACK a value the unfiltered one
 * holds, so it distinguishes them — and it WIDENS rather than narrows. It is also unreachable from
 * Prisma or `JSON.parse`, which only ever produce plain arrays, so the operative advice is
 * unchanged: no plain-array input distinguishes them.
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
  // 🔴 EACH CLAUSE IS KILLED BY A DIFFERENT FIXTURE, AND NEITHER BY A STRING SCALAR. Measured:
  // the `declared` clause fails "returns [] for a missing manifest.scopes, a null manifest, and an
  // undefined manifest" (iterating `undefined` throws); the `approvedScopes` clause fails ONLY the
  // NON-ITERABLE case, `effectiveBlockScopes({scopes:['buzz:read:self']}, 42)` → `TypeError: number
  // 42 is not iterable`. A string scalar kills NEITHER — `new Set('buzz:read:self')` and
  // `for (const s of 'buzz:read:self')` both iterate single CHARACTERS that match no scope id, so
  // the result is `[]` with or without the clause. Both fixtures are in
  // `src/shared/constants/__tests__/block-effective-scopes.test.ts`.
  if (!Array.isArray(declared) || !Array.isArray(approvedScopes)) return [];
  // NOT filtered to strings — see "EXACTLY ONE NON-STRING GUARD" above. A non-string in this
  // Set is unmatchable, because the only values tested against it are the strings that clear
  // the guard in the loop.
  const approved = new Set<unknown>(approvedScopes);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const scope of declared) {
    // 🔴 THE non-string guard. Removing it leaks a non-string into `out` whenever the SAME
    // non-string also sits in the column — pinned by the both-sides fixture in
    // `block-effective-scopes.test.ts`. Do not delete on the strength of the `string[]` type.
    if (typeof scope !== 'string') continue;
    if (!approved.has(scope) || seen.has(scope)) continue;
    seen.add(scope);
    out.push(scope);
  }
  return out;
}
