import { isFlipt } from '~/server/flipt/client';
import { narrowStoreScope, type StoreVisibilityScope } from '~/shared/utils/store-visibility-scope';
import {
  recordPublicCatalogDecision,
  type StoreScopeEntrypoint,
} from '~/server/prom/store-scope.metrics';

/**
 * The PUBLIC App-catalog read grant — the deliberate decision that the REST
 * catalog endpoints (`GET /api/v1/apps`, `GET /api/v1/apps/{slug}`) are readable
 * by anyone, including an unauthenticated caller.
 *
 * ## Why this is its own module, and not another term in `resolveStoreVisibilityScope`
 *
 * Public REST catalog access is INTENDED product behaviour, but until now it was
 * not something anyone had decided — it was a side effect. `resolveStoreVisibility
 * Scope` resolved nothing for an anonymous principal, and the listing service's
 * `?? 'full'` turned that missing value into the whole approved catalog
 * (civitai#3983). #4041 makes an absent scope fail CLOSED everywhere, which is
 * correct and must stay — and which, on its own, would have taken a live public
 * endpoint from 14 items to zero. This module is the other half: it re-grants that
 * access ON PURPOSE, in one named place, so the catalog's public reach is a
 * decision a reader can find rather than a `??` nobody meant.
 *
 * 🔴 IT IS DELIBERATELY NOT `hasAppsStoreAccess`, AND NOT A STORE FLAG. The
 * existing store predicate is `appListings || appBlocks || appListingsPublic
 * External`, and it gates the `/apps` PAGE as well as the read scope. Granting
 * public REST access by enabling any of those three flags — or by reusing that
 * predicate here — would also open `/apps` to every visitor, i.e. launch the store.
 * Nobody asked for that. The state this module encodes (catalog readable over the
 * REST API, `/apps` still dark for an anonymous viewer) is not reachable by ANY
 * combination of those flags; that is precisely why it needs its own decision
 * point. Adding a store flag to this module's inputs re-creates the coupling — do
 * not do it.
 *
 * ## What it does, exactly
 *
 * {@link resolvePublicAppsCatalogScope} takes the value `resolveStoreVisibility
 * Scope` produced and answers the only question the REST handlers actually have:
 * *what may this caller read from the public catalog?*
 *
 *   1. NARROW first ({@link narrowStoreScope}) — #4041's fail-closed rule is
 *      applied unchanged and FIRST, so an absent or uninterpretable value can never
 *      be mistaken for an entitlement.
 *   2. A caller who resolved a real scope (`full` for a moderator / app-dev-tester,
 *      `public-external` for the external-only cohort) is returned VERBATIM. The
 *      public grant is a FLOOR, never a ceiling: it can only ever lift a caller who
 *      resolved `none`, and it short-circuits before the kill switch is even read,
 *      so a privileged caller is unaffected by this module in every configuration.
 *   3. Everyone else — `none` — gets {@link PUBLIC_APPS_CATALOG_SCOPE}, unless the
 *      operator kill switch is on, in which case they get `none` and the endpoints
 *      go back to an empty page / 404.
 *
 * ## The fail-closed invariant this preserves (read this before "simplifying" it)
 *
 * #3983's exploit was not that anonymous callers could read the catalog — that is
 * intended. It was that an ABSENT scope produced a WIDER answer than a resolved
 * one: absent → `full`, resolved-`none` → empty, from the same request. Step 1
 * collapses that: absent and `none` are the same input to step 3 and therefore
 * produce the same response. There is no value the resolver can fail to produce
 * that buys a caller more than a correctly-resolved `none` does. Every other
 * consumer of the scope — both listing-service entry points, the three store tRPC
 * procs — keeps failing closed exactly as #4041 left them; this module is scoped to
 * the two public REST handlers and nothing else imports it.
 *
 * ⚠️ Honest consequence, stated rather than discovered later: while the grant is
 * active, `public-external` is not a narrower answer than the public floor at these
 * two endpoints — the floor is already `full`, so a caller in the external-only
 * cohort and an anonymous caller read the same catalog here. The distinction starts
 * to matter again the moment the kill switch is thrown, and it has always mattered
 * on the tRPC/page surfaces, which this module does not touch.
 */

/**
 * What the public catalog is readable AS. `full` — both `onsite` and `offsite`
 * approved listings, which is what `GET /api/v1/apps` has been serving publicly all
 * along (measured: 14 items, 10 onsite + 4 offsite). This constant exists so
 * narrowing the public catalog later (e.g. to `public-external`) is a one-line,
 * reviewable product decision rather than an edit threaded through two handlers.
 *
 * Approved-only, deploy-gated and maturity-gated filtering still applies inside the
 * listing service — `full` is a KIND predicate, not "everything in the table".
 */
export const PUBLIC_APPS_CATALOG_SCOPE: StoreVisibilityScope = 'full';

/**
 * Operator KILL SWITCH for the public catalog. Flipt flag; when it resolves TRUE the
 * public grant is withheld and an unauthenticated caller is back to an empty page /
 * 404. Privileged callers are unaffected (they never reach it).
 *
 * 🔴 THE POLARITY IS THE WHOLE POINT — it is a DISABLE flag, not an ENABLE flag.
 * `isFlipt` returns `false` for a flag that does not exist and for an unreachable
 * Flipt, so the absent/dark/broken state of this switch is **public access stays
 * on**. An enable-shaped flag would have made merging this PR empty the live
 * endpoint until someone remembered to create the flag — the exact regression the
 * grant exists to prevent, re-introduced by its own kill switch. If you ever invert
 * this to an `apps-public-catalog-enabled` flag, you must create AND enable it in
 * flipt-state BEFORE the code merges, and the window between the two is an outage of
 * a public endpoint.
 *
 * The flag does NOT exist in Flipt as merged, and does not need to: the as-merged
 * behaviour is the intended one. To throw the switch, create it as a PLAIN base
 * `enabled: true` boolean (NO segments, NO percentage rollout) — it is evaluated
 * GLOBALLY (entityId `'global'`, empty context) because the callers it governs are
 * unauthenticated and carry no context for a segment to match. A segmented or
 * percentage-rollout shape cannot reliably match a global eval and would read as a
 * switch that does nothing.
 *
 * Propagation is the Flipt eval cache (~10s) plus the config poll (~60s), on top of
 * whatever the CDN is still serving for `s-maxage`. It is not instant; that is
 * acceptable for a catalog-visibility switch and is why it is deliberately NOT in
 * the client's cache-bypass set (these are hot, unauthenticated endpoints).
 */
export const PUBLIC_APPS_CATALOG_DISABLED_FLAG = 'apps-public-catalog-disabled';

/** Global eval — these callers are unauthenticated and carry no Flipt context. */
async function isPublicAppsCatalogDisabled(): Promise<boolean> {
  return isFlipt(PUBLIC_APPS_CATALOG_DISABLED_FLAG);
}

/**
 * Resolve what the PUBLIC REST catalog endpoints may serve this caller.
 *
 * @param resolved the raw value from `resolveStoreVisibilityScope` — typed `unknown`
 *   on purpose. Production has been observed carrying `undefined` across exactly this
 *   boundary while every type checked green (civitai#3983), so the narrowing has to
 *   happen at runtime, here, on the value that actually arrived.
 * @param entrypoint which REST handler is asking — for the decision counter only.
 */
export async function resolvePublicAppsCatalogScope(
  resolved: unknown,
  entrypoint: StoreScopeEntrypoint
): Promise<StoreVisibilityScope> {
  // 1. #4041's rule, first and unchanged: anything uninterpretable becomes `none`.
  const scope = narrowStoreScope(resolved);
  // 2. A caller who resolved a real scope keeps it verbatim — and never pays for the
  //    kill-switch eval, so this module cannot narrow, widen or slow a privileged
  //    read in any configuration.
  if (scope !== 'none') {
    recordPublicCatalogDecision('privileged', entrypoint);
    return scope;
  }
  // 3. The public floor, unless an operator has withheld it.
  if (await isPublicAppsCatalogDisabled()) {
    recordPublicCatalogDecision('withheld', entrypoint);
    return 'none';
  }
  recordPublicCatalogDecision('granted', entrypoint);
  return PUBLIC_APPS_CATALOG_SCOPE;
}
