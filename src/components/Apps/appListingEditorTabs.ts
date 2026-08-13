import type {
  AppRole,
  ListingCapability,
  ListingKind,
} from '~/server/services/blocks/app-access.service';

/**
 * App Store Listings — the CANONICAL owner/editor authoring page's tab set.
 *
 * PURE, and deliberately separate from the page: the rule "never render a tab that will
 * 403" is only testable if the derivation is a function rather than JSX.
 *
 * ## The route
 *
 * `/apps/listing/<appListingId>/edit` is canonical for BOTH store kinds. The legacy
 * block-keyed entry points (`/apps/<appBlockId>/edit`, `/edit-manifest`, `/listing`)
 * redirect into it preserving `?tab=` — see `listingEditNav.ts`.
 *
 * Listing-keyed rather than block-keyed because seats, and therefore collaborators, key
 * to `AppListing`: an OFF-SITE listing has no AppBlock at all, so a block-keyed route is
 * structurally unable to address one of the store's two kinds.
 */
export type EditorTab = 'details' | 'media' | 'manifest' | 'collaborators';

/** The tab a bare `/edit` (no `?tab=`) lands on. Always in the allowed set. */
export const DEFAULT_EDITOR_TAB: EditorTab = 'details';

/**
 * Every tab that exists, in display order — the PARSE-ONLY allowlist.
 *
 * 🔴 NOT an authorization set. It is what an SSR hop uses to sanitise a user-supplied
 * `?tab=` before writing it into a redirect destination; the DESTINATION page then
 * narrows to {@link editorTabsFor} for the actual listing, which is the gate. Keeping the
 * sanitiser wide is what preserves a legacy deep-link's tab across the hop instead of
 * flattening every one of them to the default.
 */
export const ALL_EDITOR_TABS: EditorTab[] = ['details', 'media', 'manifest', 'collaborators'];

/** What the caller sees on each tab. Rendered in this order. */
export const EDITOR_TAB_LABELS: Readonly<Record<EditorTab, string>> = Object.freeze({
  details: 'Details',
  media: 'Media',
  manifest: 'Manifest',
  collaborators: 'Collaborators',
});

/** The inputs the tab set is derived from. Nothing else may influence it. */
export type EditorTabContext = {
  kind: ListingKind;
  /** `null` for an off-site listing. */
  appBlockId: string | null;
  role: AppRole;
  /** The listing's kind-derived capability row (`capabilitiesForKind`). */
  capabilities: Readonly<Record<ListingCapability, boolean>>;
};

/**
 * The tabs this caller may actually open, in display order.
 *
 * 🔴 EVERY CLAUSE BELOW IS THE *REASON* A PROC WOULD REFUSE, not a style preference.
 * A tab rendered outside these rules is a guaranteed 403/404 one click later.
 *
 *   - `details`       — ALWAYS. `appListings.getMyListingForEdit` / `updateListing` are
 *                       LISTING-keyed and seat-aware (both route through
 *                       `resolveListingAccess` via `loadOwnedEditableListing`), and
 *                       `capabilitiesForKind(...).listingContent` is `true` for BOTH
 *                       kinds. There is no shape in which this tab is unreachable.
 *
 *   - `media`         — ONLY with a backing AppBlock, and the discriminator is the BLOCK,
 *                       not the capability. 🔴 This is a real disagreement between the
 *                       capability table and the surface: `listingContent` is `true` for
 *                       off-site, but the standalone media editor is hosted by
 *                       `appListings.getMyListingForApp`, which takes an `appBlockId` — so
 *                       for an off-site listing there is no id to key it with. Off-site
 *                       media is edited INSIDE the details wizard (`ExternalSubmitForm`'s
 *                       asset step), which is why dropping the tab loses nothing.
 *                       Gating on `capabilities.listingContent` here would be an
 *                       UNKILLABLE clause — it is `true` on both kinds, so removing it
 *                       could never change an answer.
 *
 *   - `manifest`      — BOTH `capabilities.submitVersion` AND a backing block, and the two
 *                       are NOT redundant: they disagree on exactly the shape
 *                       `mapAppBlockToListing` can mint, an OFF-SITE listing that CARRIES
 *                       a block (`kind:'offsite'` + non-null `appBlockId`; 0 rows in
 *                       production, measured 2026-08-11 — see
 *                       `resolveAccessibleAppBlockIds`). For that row `submitVersion` is
 *                       `false` while a block id exists, and `blocks.getMyAppManifest`
 *                       would happily answer — so the capability is what withholds a
 *                       surface the store presents as external. They disagree in the
 *                       other direction on an on-site listing with no block yet, where the
 *                       block check is what stops a tab that has no id to render with.
 *
 *   - `collaborators` — ALWAYS. Seats are listing-keyed, so both kinds have a roster, and
 *                       `appCollaborators.list` admits the OWNER **and** an ACCEPTED
 *                       editor. (Which CONTROLS render inside the panel is a separate,
 *                       narrower question — owner-only for invite/remove.)
 */
export function editorTabsFor(ctx: EditorTabContext): EditorTab[] {
  const tabs: EditorTab[] = ['details'];
  if (ctx.appBlockId != null) tabs.push('media');
  if (ctx.capabilities.submitVersion === true && ctx.appBlockId != null) tabs.push('manifest');
  tabs.push('collaborators');
  return tabs;
}

/**
 * Parse a `?tab=` query value against the tabs this caller may open.
 *
 * 🔴 Falls back to {@link DEFAULT_EDITOR_TAB} for anything not in `allowed` — including a
 * tab that EXISTS but is not allowed here (`?tab=manifest` on an off-site listing). A
 * legacy deep link must land somewhere real rather than on a panel whose query 403s.
 */
export function resolveEditorTab(value: unknown, allowed: EditorTab[]): EditorTab {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw === 'string' && (allowed as string[]).includes(raw)) return raw as EditorTab;
  return allowed.includes(DEFAULT_EDITOR_TAB) ? DEFAULT_EDITOR_TAB : allowed[0];
}

/** The canonical authoring href for a listing. ONE place builds this string. */
export function listingEditHref(appListingId: string, tab?: EditorTab): string {
  const base = `/apps/listing/${encodeURIComponent(appListingId)}/edit`;
  return tab ? `${base}?tab=${tab}` : base;
}
