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
 *   - off-site with NO usable target → **informational** ("Unavailable"),
 *     regardless of whether an OAuth client is connected. There is nowhere to
 *     send the viewer, and the page says so.
 *
 * 🔴 THE "CONNECT" STUB IS DELETED (#4208) — DO NOT REINTRODUCE IT.
 *
 * History, because the shape recurs. The stub was once UNCONDITIONAL for the
 * `connect` sub-kind: every off-site listing with a linked OAuth client rendered
 * a dead affordance — no href, disabled button, and a note promising the flow
 * was coming soon — because the sub-kind routed on `connectClientId != null`
 * alone, so linking a client was the ONLY thing that moved a listing off the
 * working `Visit ↗` path. Three approved, live listings were in that state.
 * #4200 fixed that by routing on the destination, which left the stub reachable
 * only for a connect listing with genuinely no destination.
 *
 * #4208 removes what was left. The stub promised an action and delivered
 * nothing: there is no connect flow behind it, and a CTA that costs a click and
 * returns nowhere reads as broken rather than incomplete. Measured against
 * production before removing it — ZERO listings sat in that state (all five
 * off-site rows, every status, carry an https destination), so nothing regressed
 * for a live listing.
 *
 * 🔴 The state is still REACHABLE — `submitExternalListingSchema`
 * (`src/server/schema/blocks/offsite-listing.schema.ts`) requires
 * `connectClientId` but leaves `externalUrl` OPTIONAL, so a submission with no
 * URL lands here. Closing that is an API-contract change, deliberately NOT made
 * a rider on this one. So this branch must keep failing safe; it now does so by
 * saying "Unavailable" instead of lying.
 *
 * 🔴 `'connect'` IS GONE FROM `DetailActionMode`. That is the guard: reintroducing
 * the stub is a COMPILE ERROR, not a silent behaviour change a reviewer has to
 * notice. Do not re-add the member to make a new branch type-check.
 *
 * (For the record, the stub's stated premise — "a complete OAuth authorize URL is
 * NOT derivable from the public DTO" — was true and irrelevant. These are
 * CONFIDENTIAL clients that own their own `redirect_uri` / `state` / PKCE and
 * start the flow from their own site; the store never needed to build an
 * authorize URL, only to get the viewer to the app, which `externalUrl` already
 * does.)
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
 *   - `info`    → informational affordance. NO href is produced for this mode
 *                 today (the only "learn more" target was the retired
 *                 `/apps/[appBlockId]`); the field stays optional on the type
 *                 and both renderers keep their text-only fallback.
 *
 * 🔴 There is deliberately NO `'connect'` member (#4208). It described a CTA with
 * no flow behind it. Its absence from this union is what makes the dead button
 * un-reintroducible without a compile error — see the module docstring. If you
 * are here to add it back because a new branch won't type-check, build the
 * connect flow first.
 */
export type DetailActionMode = 'open' | 'visit' | 'info';

export type DetailPrimaryAction = {
  /** Button / affordance copy. */
  label: string;
  mode: DetailActionMode;
  /** Nav target (internal for `open`, external for `visit`), or undefined. Never
   *  set for `info` — see the mode docs above. */
  href?: string;
  /** True → open in a new tab as an external anchor (rel=noopener noreferrer). */
  external: boolean;
  /** Informational copy for the `info` mode. */
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

  // NO usable destination → ONE informational fallback, whether or not an OAuth
  // client is connected.
  //
  // 🔴 This used to fork on `kd.connectClientId`, giving the OAuth arm a
  // "Connect" stub for a flow that does not exist. #4208 deleted that arm: the
  // capability is real, but it is not a NAVIGATION target, and the store has
  // nowhere to send this viewer either way. Do NOT reintroduce a
  // `connectClientId` test here — the capability is communicated by the
  // permission signal on the page body (`shouldShowOffsiteDisclosure` and its
  // positive counterpart), not by a button that does nothing.
  //
  // The note is accurate for both arms: a listing in this state has no valid
  // external link, which is exactly why there is no action to offer.
  return {
    label: 'Unavailable',
    mode: 'info',
    external: false,
    note: 'This app has no valid external link.',
  };
}

/**
 * Does the detail page show the "runs entirely off-platform — no Civitai
 * install, account access, or permissions" disclosure?
 *
 * 🔴 EXTRACTED FROM THE JSX ON PURPOSE. This predicate makes a SECURITY CLAIM to
 * the viewer, and it is FALSE of a listing with an OAuth app connected — that
 * app can be granted account access, which is the whole point of connecting it.
 * Inline in `AppListingDetailBody` it was unreachable by the blocking node
 * `unit` project, and the report-only browser suite asserted it nowhere at all,
 * so deleting the condition — printing "no account access" over every off-site
 * listing — was a change no test could catch. Here it is a pure function with
 * its own truth-table tests.
 *
 * Three conjuncts, each load-bearing:
 *   - `offsite` — an on-site app runs ON platform, so the sentence is simply
 *     wrong about it;
 *   - no `connectClientId` — the capability check; see above;
 *   - a non-null `externalUrl` — there is no "runs off-platform" claim to make
 *     about a listing with nowhere to run.
 *
 * Truthiness on `connectClientId`, matching `app-listing.service`'s `|| null`,
 * so both read the capability the same way.
 *
 * 🔴 This used to say "and the no-destination fallback above, so all THREE read
 * the capability the same way". #4208 deleted that fallback's `connectClientId`
 * test outright — the primary action no longer reads the capability at all — so
 * there are two readers here, not three. This predicate is now the ONLY place in
 * this module that branches on it.
 *
 * 🔴 TWO PRODUCERS FEED THIS, and only one is the store read path.
 * `OffsiteReviewQueue`'s `ListingPreviewSection` renders `AppListingDetailBody`
 * with a detail from `buildListingDetailPreview` whenever the mod-only
 * projection query is loading, errors, or the row has no `appListingId` — so
 * that builder's `connectClientId` is load-bearing for THIS claim, and it has
 * its own passthrough test for exactly that reason. If you add a third
 * producer, give it one too.
 *
 * That preview builder passes the field through with `?? null` while its old
 * sub-kind used `!= null`, so at `connectClientId === ''` this predicate now
 * SHOWS the disclosure where the old code hid it. Practically unreachable
 * (`connect_client_id` is an FK to `OauthClient.id`; `offsite-listing.schema.ts`
 * requires `z.string().min(1)` on create) and the safer of the two answers — an
 * empty string is not a connected OAuth app — but it is a real difference, so
 * do not read "identical rendering" as universal across both producers.
 */
export function shouldShowOffsiteDisclosure(kindData: ListingDetail['kindData']): boolean {
  return kindData.kind === 'offsite' && !kindData.connectClientId && !!kindData.externalUrl;
}
