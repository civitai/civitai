/**
 * App Store Listings (W13) — P2c detail VIEW MODEL (pure, React-free).
 *
 * The kind-aware PRIMARY-ACTION logic for the unified listing detail
 * (`AppListingDetailBody`), extracted into a pure function so the correctness
 * gate lives in the node `unit` project (the civitai browser-mode component
 * suites are REPORT-ONLY / non-blocking — so the real, blocking coverage for the
 * detail action matrix is here, mirroring `appListingCardView`).
 *
 * DARK / parallel-run: consumed only by the mod-only `/apps/store-preview/<slug>`
 * detail surface. The live `/apps/[appBlockId]` detail + `AppDetailsModal` are
 * untouched; the cutover to a canonical `/apps/[slug]` is a later PR (P2d).
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
 *     or a download is UNUSABLE inside it. The legacy `/apps/[appBlockId]` page
 *     wrapped the same iframe in an unsandboxed "Open live" escape hatch, so
 *     dropping it here would make the canonical page strictly LESS capable than
 *     the page it replaces. (Widening the iframe sandbox is a separate security
 *     decision and explicitly NOT made here.) Both the action href and the
 *     preview derive from the SAME `kindData.liveUrl` + `safeExternalHref`
 *     guard, so "the note says there is a preview" and "the preview renders"
 *     cannot disagree. Pinned by tests in
 *     `__tests__/appListingDetailView.test.ts`.
 *   - on-site + !hasPage (model-slot app) → **informational** ("Runs on model
 *     pages"): install happens on a model page, so there is no standalone
 *     install here; link out to the live per-app detail (`/apps/<appBlockId>`)
 *     where the install affordance lives. (Deeper install wiring = cutover.)
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
 *   - `info`    → informational affordance, optional `href` "learn more" link.
 */
export type DetailActionMode = 'open' | 'visit' | 'connect' | 'info';

export type DetailPrimaryAction = {
  /** Button / affordance copy. */
  label: string;
  mode: DetailActionMode;
  /** Nav target (internal for `open`/`info` link, external for `visit`), or undefined. */
  href?: string;
  /** True → open in a new tab as an external anchor (rel=noopener noreferrer). */
  external: boolean;
  /** Informational copy for the `info` / `connect`-stub modes. */
  note?: string;
};

/** The live per-AppBlock detail page (where a model-slot on-site app installs). */
function liveAppDetailHref(appBlockId: string | null): string | undefined {
  return appBlockId ? `/apps/${encodeURIComponent(appBlockId)}` : undefined;
}

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
    return {
      label: 'Runs on model pages',
      mode: 'info',
      href: liveAppDetailHref(kd.appBlockId),
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
