/**
 * App Store Listings (W13) — P2c detail VIEW MODEL (pure, React-free).
 *
 * The kind-aware PRIMARY-ACTION logic for the unified listing detail
 * (`AppListingDetailBody`), extracted into a pure function so the correctness
 * coverage lives in the node `unit` project — the fast, deterministic suite,
 * which CI runs `continue-on-error` on every PR, whereas the browser-mode
 * component suites run only in the PR preview pipeline, report-only and behind a
 * preview build that fails intermittently. Neither BLOCKS a merge; this is simply
 * where the detail action matrix is actually pinned, mirroring
 * `appListingCardView`.
 *
 * DARK / parallel-run: consumed by the mod-only `/apps/store-preview/<slug>`
 * detail surface (`AppListingDetailBody`) AND by `MySubmissionsList`'s owner
 * "open the running app" affordance, which reuses this same matrix. Both
 * callsites already degrade gracefully to text when an action carries no href.
 *
 * 🔴 `/apps/[appBlockId]` IS RETIRED (#3493) — nothing here may link to it.
 * It is now a `getServerSideProps`-only route with two terminal branches (see
 * `resolveLegacyAppRedirect.ts`): an app WITH an approved `AppListing` 302s to
 * `/apps/store-preview/<slug>`, and an app without one 404s. Its page body is
 * retained but UNREACHABLE and is slated for deletion. So there is no state in
 * which that URL resolves to something new: from the store detail it redirects
 * straight back to the page the viewer is already on.
 *
 * PRIMARY-ACTION policy (kind × hasPage × destination), all with NO dead 404 nav:
 *   - on-site + hasPage + canOpenPage → **Open** (`/apps/run/<slug>`, the LIVE
 *     W10 in-host page route; flag-gated on `appBlocksPages`). The raw-origin
 *     "Open live" action is HIDDEN here: the app opens properly in-page, so a
 *     second button shipping the viewer to `<slug>.civit.ai` is pure redundancy.
 *   - on-site + hasPage + !canOpenPage + an https liveUrl → **Open live ↗** to
 *     the raw `<slug>.civit.ai` origin. 🔴 This escape hatch is deliberately
 *     RETAINED for exactly this state — it is the only route to the app when a
 *     viewer can see the store but cannot open `/apps/run`. ⚠️ **No production
 *     viewer is in that state today** (measured 2026-08-02 against live Flipt):
 *     `app-blocks-enabled`, `app-listings` and `app-blocks-pages-enabled` are
 *     all base `enabled: false` with the SAME rollout segments
 *     `[moderators, app-dev-testers]`, and the store page gates on
 *     `appListings || appBlocks` while `canOpenPage` is `appBlocksPages` — so
 *     everyone who can reach the detail also has `canOpenPage === true` and gets
 *     `Open` above, never this branch. Do not read "appBlocksPages is dark" as
 *     meaning this branch is the live one; it is reachable only if those cohorts
 *     ever diverge. The store detail briefly also carried an in-page `<iframe>`
 *     preview; it was REMOVED because
 *     nothing posted the framed block a `BLOCK_INIT`, so it never initialised
 *     and only painted the block's pre-init light-theme shell. Its note used to
 *     read "…You can also run it in the live preview below" — do not reinstate
 *     that sentence without a real host bridge behind it. Pinned by tests in
 *     `__tests__/appListingDetailView.test.ts`.
 *   - on-site + !hasPage (model-slot app) → **informational** ("Runs on model
 *     pages"), TEXT ONLY — deliberately NO href. Install happens on a model
 *     page, so there is no standalone install here. 🔴 This branch used to link
 *     to `/apps/<appBlockId>`; post-#3493 that is a circular self-link from the
 *     store detail (see the retirement note above). There is nothing to retarget
 *     it TO: `AppListingDetailBody` has no install surface at all, and building
 *     one is the tracked gap #3493 names, explicitly NOT done here. This state
 *     therefore offers the viewer no navigable route at all — enumerated
 *     explicitly in the "no on-site state strands the viewer" matrix test — but
 *     the branch is vacuous today: every approved on-site listing declares a
 *     page, so nothing takes it.
 *   - off-site with an https `externalUrl` → **Visit ↗** → external anchor.
 *     🔴 The presence of a destination decides this, and nothing else.
 *   - off-site with NO usable target and no OAuth client connected →
 *     **informational** (guarded out; no target).
 *   - off-site with NO usable target but an OAuth client connected → **Connect**
 *     STUB with a note — the only remaining state with nowhere to send the
 *     viewer. That last test is a CAPABILITY check on `connectClientId`, not a
 *     kind: off-site is one kind (the `connect` / `external-link` display
 *     sub-kind was removed).
 *
 * 🔴 THE CONNECT STUB USED TO BE UNCONDITIONAL, AND THAT WAS THE BUG. Every
 * off-site listing with a linked OAuth client rendered a dead
 * "Connecting this app will be available soon." affordance — no href, disabled
 * button — because the sub-kind routed on `connectClientId != null` alone, so
 * linking a client was the ONLY thing that moved a listing off the working
 * `Visit ↗` path. Three approved, live listings were in that state; a fourth,
 * with no client, worked.
 *
 * The stub's stated premise — "a complete OAuth authorize URL is NOT derivable
 * from the public DTO" — is true and irrelevant. These are CONFIDENTIAL clients
 * that own their own `redirect_uri` / `state` / PKCE and start the flow from
 * their own site; the store never needed to build an authorize URL, only to get
 * the viewer to the app. That destination is already on the public DTO as
 * `externalUrl`, https-guarded, and the external-link branch has always
 * rendered it correctly. So connect now reuses that same proven path rather
 * than growing a second one, and the stub survives only for a connect listing
 * with genuinely no destination — where it still fails safe.
 */

import { safeExternalHref } from '~/components/Apps/appListingCardView';
import type { ListingDetail } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * Owner "Edit" deep-link gating + href builders are shared with the store card,
 * so they live in the base card view-model. Re-exported here so the detail body
 * (and its unit test) import the owner-edit logic from the DETAIL view-model.
 */
export {
  canOwnerEditListing,
  getOwnerEditHref,
  isEditableListingStatus,
} from '~/components/Apps/appListingCardView';

/**
 * Primary-action mode:
 *   - `open`    → internal nav to the in-host page runner.
 *   - `visit`   → external new-tab anchor (Visit / Open live).
 *   - `connect` → the OAuth connect affordance (stubbed until cutover; `note` set).
 *   - `info`    → informational affordance. NO href is produced for this mode
 *                 today (the only "learn more" target was the retired
 *                 `/apps/[appBlockId]`); the field stays optional on the type
 *                 and both renderers keep their text-only fallback.
 */
export type DetailActionMode = 'open' | 'visit' | 'connect' | 'info';

export type DetailPrimaryAction = {
  /** Button / affordance copy. */
  label: string;
  mode: DetailActionMode;
  /** Nav target (internal for `open`, external for `visit`), or undefined. Never
   *  set for `info`/`connect` — see the mode docs above. */
  href?: string;
  /** True → open in a new tab as an external anchor (rel=noopener noreferrer). */
  external: boolean;
  /** Informational copy for the `info` / `connect`-stub modes. */
  note?: string;
};

/**
 * Kind-aware primary action for the unified detail. `canOpenPage` mirrors the
 * `appBlocksPages` flag (dark/mod-only today) so an on-site page app never
 * routes to a `/apps/run` link the viewer can't open.
 */
export function getDetailPrimaryAction(
  detail: Pick<ListingDetail, 'slug' | 'kind' | 'kindData'>,
  opts: { canOpenPage: boolean }
): DetailPrimaryAction {
  const kd = detail.kindData;

  if (kd.kind === 'onsite') {
    if (kd.hasPage && opts.canOpenPage) {
      return {
        label: 'Open',
        mode: 'open',
        href: `/apps/run/${encodeURIComponent(detail.slug)}`,
        external: false,
      };
    }
    if (kd.hasPage) {
      // Page app, but this viewer can't launch the in-host page. The raw-origin
      // "Open live" escape hatch is then the only way to run the app from the
      // store, exactly as the legacy `/apps/[appBlockId]` page offered it; it is
      // hidden in the `canOpenPage` branch above, where the app opens in-page.
      //
      // ⚠️ Unreached in production today: the store-visibility flags and
      // `app-blocks-pages-enabled` share one cohort, so any viewer who can see
      // this page also has `canOpenPage === true`. See the flag note in the
      // module docstring before reasoning about this branch as the live one.
      //
      // 🔴 The note must not promise a surface this page does not have. It used
      // to end "…You can also run it in the live preview below", pointing at an
      // in-page `<iframe>` that has been REMOVED — it was a bridge-less frame
      // that never sent the block `BLOCK_INIT`, so it only ever painted the
      // block's pre-init light-theme shell. Keep this copy about the link it is
      // attached to; see the `AppListingDetailBody` docstring before adding any
      // preview reference back.
      const live = safeExternalHref(kd.liveUrl);
      if (live) {
        return {
          label: 'Open live',
          mode: 'visit',
          href: live,
          external: true,
          note: 'Opens the app at its own address.',
        };
      }
    }
    // Model-slot app (no launch page): install happens on a model page.
    //
    // 🔴 NO href, and do not reintroduce one pointing at `/apps/<appBlockId>`.
    // That route is retired (#3493): it 302s to `/apps/store-preview/<slug>`,
    // which from this very page is a circular self-link, and 404s for an app
    // with no approved listing. `AppListingDetailBody` has no install surface to
    // retarget to — closing that is the follow-up #3493 tracks, not this. The
    // affordance is therefore informational text only, which is the honest
    // signal: this app is not openable from the store, it installs on a model
    // page. Both renderers already fall back to text when `href` is undefined.
    return {
      label: 'Runs on model pages',
      mode: 'info',
      external: false,
      note: 'This app installs into a slot on model pages — open a model where it appears to add it.',
    };
  }

  // Off-site — ONE kind. An off-site app lives at its own address, and that
  // address is the only thing this page can route to; an OAuth-connected app
  // then runs its own confidential-client OAuth flow from there. So the
  // destination decides the action: one https-guarded path
  // (`safeExternalHref`). Do NOT reintroduce a `connectClientId` test above this
  // line — that is precisely what made a linked OAuth client the sole cause of a
  // dead CTA.
  const href = safeExternalHref(kd.externalUrl);
  if (href) return { label: 'Visit', mode: 'visit', href, external: true };

  // NO usable destination. The two fallbacks below differ by a CAPABILITY, not
  // by a kind: an app with no OAuth client connected has simply nowhere to send
  // you ("Unavailable"), whereas an app that DOES connect to your Civitai
  // account has a second, not-yet-built route ("Connect", stubbed). This test
  // used to read `kd.subKind === 'external-link'`; `subKind` was derived from
  // `connectClientId` by a truthiness test and nothing else, so reading the
  // field directly is the SAME predicate with no derived taxonomy in between —
  // behaviour is byte-identical for every input. Whether the stub should exist
  // at all is a product question this change deliberately does not answer.
  if (!kd.connectClientId) {
    return {
      label: 'Unavailable',
      mode: 'info',
      external: false,
      note: 'This app has no valid external link.',
    };
  }

  // OAuth-connected, with NO usable destination — the honest stub, reached only
  // in that genuinely-nowhere-to-go state. Fails safe: no dead nav.
  return {
    label: 'Connect',
    mode: 'connect',
    external: false,
    note: 'Connecting this app will be available soon.',
  };
}
