import type {
  AppRole,
  ListingCapability,
  ListingKind,
} from '~/server/services/blocks/app-access.service';
import {
  isAuthorableListingStatus,
  isPublishableListingStatus,
} from '~/shared/constants/app-capabilities.constants';

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
export type EditorTab =
  | 'details'
  | 'media'
  | 'manifest'
  | 'earnings'
  | 'collaborators'
  | 'publishing'
  | 'history';

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
export const ALL_EDITOR_TABS: EditorTab[] = [
  'details',
  'media',
  'manifest',
  'earnings',
  'collaborators',
  'publishing',
  'history',
];

/** What the caller sees on each tab. Rendered in this order. */
export const EDITOR_TAB_LABELS: Readonly<Record<EditorTab, string>> = Object.freeze({
  details: 'Details',
  media: 'Media',
  manifest: 'Manifest',
  earnings: 'Earnings',
  collaborators: 'Collaborators',
  publishing: 'Publishing',
  history: 'History',
});

/** The inputs the tab set is derived from. Nothing else may influence it. */
export type EditorTabContext = {
  kind: ListingKind;
  /** `null` for an off-site listing. */
  appBlockId: string | null;
  role: AppRole;
  /** The listing's kind-derived capability row (`capabilitiesForKind`). */
  capabilities: Readonly<Record<ListingCapability, boolean>>;
  /**
   * The LISTING's own status — `draft|pending|approved|rejected|removed`.
   *
   * 🔴 LOAD-BEARING, AND THE REASON THIS FUNCTION IS NOW A SECURITY SURFACE. A
   * non-authorable status (`removed`/`rejected`) collapses the set to the narrowed
   * publishing/history pair; see {@link editorTabsFor}.
   */
  status: string;
};

/**
 * The tabs this caller may actually open, in display order.
 *
 * 🔴 EVERY CLAUSE BELOW IS THE *REASON* A PROC WOULD REFUSE, not a style preference.
 * A tab rendered outside these rules is a guaranteed 403/404 one click later.
 *
 * 🔴 FIRST, THE STATUS BRANCH — AND IT IS THE ONE SECURITY-CRITICAL CLAUSE IN THIS FILE.
 * On a NON-AUTHORABLE status (`removed`, `rejected`) the set collapses to at most
 * `publishing` + `history`, and EVERY content tab is withheld — `details`, `media`,
 * `manifest`, `earnings` and, above all, `collaborators`. `details` and `collaborators`
 * used to be pushed UNCONDITIONALLY, which is precisely why the route was previously
 * forbidden outright on those statuses: leaving the page open on a delisted app left a
 * LIVE Collaborators tab, where accepting an invite still mints Forgejo `write` on the
 * app's repo. Opening the route so an owner can Republish (rather than being stuck behind
 * a one-way door only a moderator can reopen — civitai/civitai#4218) is only safe because
 * this branch exists, so:
 *
 *   🔴 DO NOT MAKE `details` OR `collaborators` UNCONDITIONAL AGAIN, and do not "simplify"
 *   this branch into a filter over the full set. Each withheld tab has its OWN negative
 *   test in `appListingEditorTabs.test.ts`; the `collaborators` one names the Forgejo
 *   consequence.
 *
 * 🔴 AND THE TAB SET IS A UI NARROWING, NEVER A GATE. Measured on this tree:
 * `appCollaborators.list`, `inviteCollaborator` and `respondToInvite` did NOT check
 * listing status at all — only `getAppListingAuthoringContext`'s refusal stood between a
 * removed listing and a fresh repo grant. `inviteCollaborator`/`respondToInvite` now
 * refuse a non-authorable listing server-side (see `app-collaborator.service.ts`), and
 * THAT is the enforcement point. This function only stops the caller being offered a
 * surface the server is going to refuse.
 *
 *   - `details`       — every AUTHORABLE status. `appListings.getMyListingForEdit` /
 *                       `updateListing` are
 *                       LISTING-keyed and seat-aware (both route through
 *                       `resolveListingAccess` via `loadOwnedEditableListing`), and
 *                       `capabilitiesForKind(...).listingContent` is `true` for BOTH
 *                       kinds. There is no shape in which this tab is unreachable.
 *
 *   - `media`         — BOTH `capabilities.listingMedia` AND a backing block.
 *                       🔴 The capability is the AUTHORITY here; the block check is the
 *                       renderability floor. That ordering used to be reversed — this arm
 *                       gated on block-presence ALONE, because `listingContent` was `true`
 *                       for off-site and so could never withhold anything. That made the
 *                       gate an incidental PROXY: it happened to correlate with the truth
 *                       (off-site listings usually have no block) without ever expressing
 *                       it. `listingMedia` was split out of `listingContent` so the table
 *                       states the real constraint, and this gate now reads it.
 *                       🟡 That constraint is no longer "the host resolver is block-keyed":
 *                       civitai/civitai#3984 re-keyed `getMyListingForApp` to take
 *                       `appBlockId` OR `slug`, so the resolver reaches an off-site listing
 *                       fine. What withholds the tab TODAY is the `ctx.appBlockId != null`
 *                       clause below — the panel hands an `appBlockId` to
 *                       `<ListingMediaEditor>`, and an off-site listing has none. Off-site
 *                       media is still editable inside the details wizard, which is why
 *                       withholding the TAB loses nothing today. Widening it (flip the cell
 *                       AND re-key the panel onto the slug) is civitai/civitai#3893.
 *
 *   - `manifest`      — BOTH `capabilities.submitVersion` AND a backing block.
 *
 *   - `earnings`      — BOTH `capabilities.earnings` AND a backing block, MIRRORING the
 *                       proc's own refusal exactly: `getAppEarnings` returns
 *                       `unsupportedKind` when `!listingKindSupports(kind,'earnings') ||
 *                       !appBlockId`, so any other predicate here would render a tab whose
 *                       query is guaranteed to refuse. Visible to an accepted EDITOR as
 *                       well as the owner — that is the capability the invite disclosure
 *                       promises, and this panel is what makes the promise true.
 *
 * 🔴 NEITHER TWO-CLAUSE ARM IS REDUNDANT, and the reason is the same for both: the
 * capability and the block-presence check disagree in OPPOSITE directions, so each clause
 * is the sole cause of an answer somewhere and each is individually killable.
 *
 *   - An OFF-SITE listing that CARRIES a block — the shape `mapAppBlockToListing` can
 *     mint (`kind:'offsite'` + non-null `appBlockId`; 0 rows in production, measured
 *     2026-08-11, see `resolveAccessibleAppBlockIds`). A block id exists, so the block
 *     check alone would offer BOTH tabs; `submitVersion:false` / `listingMedia:false` are
 *     what withhold surfaces the store presents as external.
 *   - An ON-SITE listing with NO block yet — both capabilities are `true`, so the
 *     capability alone would offer both tabs; the block check is what stops a tab that has
 *     no id to render with.
 *
 * `appListingEditorTabs.test.ts` pins one case per direction, so dropping either clause
 * reddens exactly one of them.
 *
 *   - `collaborators` — every AUTHORABLE status, and NEVER on a non-authorable one. Seats
 *                       are listing-keyed, so both kinds have a roster, and
 *                       `appCollaborators.list` admits the OWNER **and** an ACCEPTED
 *                       editor. (Which CONTROLS render inside the panel is a separate,
 *                       narrower question — owner-only for invite/remove.) The status
 *                       clause is the Forgejo-write guard described at the top.
 *
 *   - `publishing`    — OWNER only, and only where a publishing control actually exists
 *                       (`isPublishableListingStatus`: `approved` ⇒ Unpublish, `removed` ⇒
 *                       Republish). This is the first clause for which `role` has ever been
 *                       load-bearing here: both `unpublishOwnListing` and
 *                       `republishOwnListing` are owner-scoped server-side and throw for a
 *                       seated editor, so offering an editor the tab would be offering a
 *                       guaranteed red toast.
 *
 *   - `history`       — ALWAYS, for BOTH roles and EVERY status the route opens on.
 *                       `listingHistory` authorizes through `resolveListingAccess` (owner
 *                       OR accepted seat) and reads no status, so it refuses nothing this
 *                       page can reach. It is also what keeps the set non-empty: an editor
 *                       on a `removed` listing gets `['history']`, never `[]`, so
 *                       `resolveEditorTab`'s `allowed[0]` fallback always has an answer.
 */
export function editorTabsFor(ctx: EditorTabContext): EditorTab[] {
  const tabs: EditorTab[] = [];
  // 🔴 THE SECURITY BRANCH. See the block above before touching it.
  if (isAuthorableListingStatus(ctx.status)) {
    tabs.push('details');
    if (ctx.capabilities.listingMedia === true && ctx.appBlockId != null) tabs.push('media');
    if (ctx.capabilities.submitVersion === true && ctx.appBlockId != null) tabs.push('manifest');
    if (ctx.capabilities.earnings === true && ctx.appBlockId != null) tabs.push('earnings');
    tabs.push('collaborators');
  }
  if (ctx.role === 'owner' && isPublishableListingStatus(ctx.status)) tabs.push('publishing');
  tabs.push('history');
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
