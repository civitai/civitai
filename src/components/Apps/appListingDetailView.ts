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
 *     W10 in-host page route; flag-gated on `appBlocksPages`).
 *   - on-site + hasPage + !canOpenPage → **Open live** → the already-public
 *     standalone block origin (`liveUrl`, https-guarded) — no dead run link.
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
      // dark) — offer the already-public standalone origin instead of a dead
      // /apps/run link.
      const live = safeExternalHref(kd.liveUrl);
      if (live) return { label: 'Open live', mode: 'visit', href: live, external: true };
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
