/**
 * App Store Listings (W13) — P2c detail VIEW MODEL (pure, React-free).
 *
 * The kind-aware PRIMARY-ACTION logic for the unified listing detail
 * (`AppListingDetailBody`), extracted into a pure function so the correctness
 * coverage lives in the node `unit` project — the fast, deterministic suite,
 * which CI runs `continue-on-error` while not running the browser-mode component
 * suites at all. Neither BLOCKS a merge; this is simply where the detail action
 * matrix is actually pinned, mirroring `appListingCardView`.
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
 * PRIMARY-ACTION policy (kind × hasPage × subKind), all with NO dead 404 nav:
 *   - on-site + hasPage + canOpenPage → **Open** (`/apps/run/<slug>`, the LIVE
 *     W10 in-host page route; flag-gated on `appBlocksPages`). The raw-origin
 *     "Open live" action is HIDDEN here: the app opens properly in-page, so a
 *     second button shipping the viewer to `<slug>.civit.ai` is pure redundancy.
 *   - on-site + hasPage + !canOpenPage + a previewable liveUrl → **Open live ↗**
 *     to the raw `<slug>.civit.ai` origin, PLUS a note pointing at the in-page
 *     preview. 🔴 This escape hatch is deliberately RETAINED for exactly this
 *     state. With `appBlocksPages` dark (today's live posture) the in-page
 *     preview is the ONLY route to the app, and that preview is a 420px iframe
 *     with `sandbox="allow-scripts allow-same-origin"` — no `allow-forms`, no
 *     `allow-popups`, no `allow-downloads`. Any block that uses a form, a popup
 *     or a download is UNUSABLE inside it. The now-retired `/apps/[appBlockId]`
 *     page wrapped the same iframe in an unsandboxed "Open live" escape hatch,
 *     so dropping it here would make the canonical page strictly LESS capable
 *     than the page it replaced — that is a capability-parity argument about
 *     what the retired page OFFERED, not a claim that it still serves.
 *     (Widening the iframe sandbox is a separate security decision and
 *     explicitly NOT made here.) Both the action href and the
 *     preview derive from the SAME `kindData.liveUrl` + `safeExternalHref`
 *     guard, so "the note says there is a preview" and "the preview renders"
 *     cannot disagree. Pinned by tests in
 *     `__tests__/appListingDetailView.test.ts`.
 *   - on-site + !hasPage (model-slot app) → **informational** ("Runs on model
 *     pages"), TEXT ONLY — deliberately NO href. Install happens on a model
 *     page, so there is no standalone install here. 🔴 This branch used to link
 *     to `/apps/<appBlockId>`; post-#3493 that is a circular self-link from the
 *     store detail (see the retirement note above). There is nothing to retarget
 *     it TO: `AppListingDetailBody` has no install surface at all, and building
 *     one is the tracked gap #3493 names, explicitly NOT done here. The viewer
 *     is still not stranded — the in-page live preview renders for this state
 *     (`getListingPreview` gates on kind + https `liveUrl`, not on `hasPage`) —
 *     and the branch is vacuous today: every approved on-site listing declares a
 *     page, so nothing takes it.
 *   - off-site external-link (https) → **Visit ↗** → external anchor.
 *   - off-site external-link (missing / non-https) → **informational** (guarded
 *     out; no target).
 *   - off-site connect (OAuth) → **Connect** STUB: a complete OAuth authorize
 *     URL is NOT derivable from the public DTO (needs redirect_uri /
 *     response_type / scope), so the connect flow is an honest stub with a note
 *     until the cutover wires it — no dead 404 nav.
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
      // Page app, but this viewer can't launch the in-host page (appBlocksPages
      // dark). The in-page preview below IS the in-store way to run it — but it
      // is a SANDBOXED 420px frame (`allow-scripts allow-same-origin` only), so
      // a block that needs a form / popup / download cannot be used through it.
      // The raw-origin "Open live" escape hatch therefore STAYS in this state,
      // exactly as the legacy `/apps/[appBlockId]` page offered it; it is hidden
      // only in the `canOpenPage` branch above, where the app opens properly
      // in-page.
      //
      // 🔴 The note must only claim a preview exists when one really will
      // render. The href and the preview both derive from `kindData.liveUrl`
      // through the SAME https guard (`safeExternalHref`, also used by
      // `getListingPreview`), so they agree by construction. If the guard drops
      // the URL there is neither an escape hatch nor a preview, and we fall
      // through to the informational branch below rather than promising one.
      const live = safeExternalHref(kd.liveUrl);
      if (live) {
        return {
          label: 'Open live',
          mode: 'visit',
          href: live,
          external: true,
          note: 'Opens the app at its own address. You can also run it in the live preview below.',
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

  // Off-site.
  if (kd.subKind === 'external-link') {
    const href = safeExternalHref(kd.externalUrl);
    if (href) return { label: 'Visit', mode: 'visit', href, external: true };
    return {
      label: 'Unavailable',
      mode: 'info',
      external: false,
      note: 'This app has no valid external link.',
    };
  }

  // Off-site connect (OAuth) — honest stub (see docstring: no derivable authorize URL).
  return {
    label: 'Connect',
    mode: 'connect',
    external: false,
    note: 'Connecting this app will be available soon.',
  };
}
