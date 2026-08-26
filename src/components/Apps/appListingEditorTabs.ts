import { OWNER_UNPUBLISH_ACTION } from '~/components/Apps/offsiteOwnerControls';
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
  /**
   * The listing's most-recent STATUS-CHANGING moderation action, NORMALISED
   * (`'owner-unpublish' | 'other' | null`) — straight off
   * `AppListingAuthoringContext.lastModerationAction`.
   *
   * 🔴 `status` ALONE CANNOT ANSWER "MAY THIS BE EDITED?" ON `removed`, and this is the
   * bit that can. `app_listings.status = 'removed'` is written by BOTH an owner
   * self-unpublish and a moderator takedown; only the last status-changing event
   * separates them. See {@link isOwnerUnpublishedTabContext}.
   *
   * 🔴 OPTIONAL, AND ABSENT MEANS "NOT PROVEN TO BE THE OWNER'S OWN", i.e. today's
   * narrowed behaviour. Same fail-closed direction as the server predicate
   * (`app-listing-owner-unpublish`): a caller that has not wired the field through gets
   * the narrow set, never the wide one.
   */
  lastModerationAction?: string | null;
};

/**
 * Is this listing in the OWNER-REPAIR state — `removed`, because the owner unpublished it
 * themselves?
 *
 * 🔴 THIS IS THE CLIENT MIRROR OF THE SERVER PREDICATE, NOT A SECOND OPINION.
 * `isOwnerUnpublishedListing` in `app-listing-owner-unpublish` is authoritative and is what
 * `getMyListingForEdit` / `updateListing` / `getMyListingForApp` actually branch on; this
 * decides only whether the caller is OFFERED the surface those procs will accept. The two
 * read the same normalised fact, and the action name comes from
 * {@link OWNER_UNPUBLISH_ACTION} — the client literal `app-listing-owner-unpublish.test.ts`
 * pins against the server's `OWNER_UNPUBLISH_EVENT` — so they cannot drift into different
 * spellings.
 *
 * 🔴 BOTH CLAUSES ARE LOAD-BEARING AND NEITHER IS REDUNDANT.
 *   - Without the STATUS clause a stale `owner-unpublish` on a listing that has since been
 *     relisted (`approved`) or reset to `pending` would report `true`. That is harmless for
 *     the tab set (those statuses are authorable anyway) but this predicate is exported, and
 *     the next caller's default must not be "an old event still speaks for the row".
 *     `getAppListingAuthoringContext` additionally refuses to even READ the event on a
 *     non-`removed` listing, so the two agree.
 *   - Without the ACTION clause every moderator takedown re-opens the content tabs — the
 *     exact hazard the narrowing exists to prevent.
 *
 * 🔴 FAIL-CLOSED ON ABSENCE. `null` (no recorded event) and `'other'` (a moderator verb,
 * collapsed by `normalizeLastModerationAction` before it leaves the server) are both
 * `false`. A listing whose events were pruned, or that predates the taxonomy, is treated as
 * a moderator removal — the safe direction, and a REAL branch rather than a degenerate one.
 */
export function isOwnerUnpublishedTabContext(
  ctx: Pick<EditorTabContext, 'status' | 'lastModerationAction'>
): boolean {
  return ctx.status === 'removed' && ctx.lastModerationAction === OWNER_UNPUBLISH_ACTION;
}

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
 * 🔴 SECOND, THE OWNER-REPAIR BRANCH, AND IT IS NARROWER THAN THE FIRST ON PURPOSE.
 * `status='removed'` is written by BOTH an owner self-unpublish and a moderator takedown,
 * and civitai/civitai#4413 made the SERVER tell them apart: `getMyListingForEdit`,
 * `updateListing` and `getMyListingForApp` now ACCEPT an owner-unpublished listing (trivial
 * scalars in place, media edited directly) and still refuse a moderator takedown. Until this
 * change nothing in the UI could reach that: `editorTabsFor` gated `details` and `media` on
 * `isAuthorableListingStatus`, which excludes `removed`, so the owner had a repair loop with
 * no repair step — a server capability with zero callers, which is how #4401's
 * `messageAppOwner` shipped dark.
 *
 *   🔴 SO THE FIX BRANCHES ON THE LAST ACTION, IT DOES NOT WIDEN
 *   `AUTHORABLE_LISTING_STATUSES`. That set has THREE consumers, and the other one is
 *   `assertSeatGrantable` in `app-collaborator.service` — the server gate on
 *   `inviteCollaborator` / `respondToInvite`. Adding `removed` to it would unlock
 *   collaborator invites on MODERATOR-DELISTED listings, where accepting still mints
 *   Forgejo `write` on the app's repo: exactly the hazard the first branch exists to
 *   close, re-opened from the other end and server-side rather than merely in the UI.
 *
 *   🔴 AND THE REPAIR BRANCH GRANTS `details` + `media` ONLY. `collaborators` stays
 *   withheld (its server gate refuses this status, so the tab would 403 — and it is the
 *   Forgejo surface). `manifest` and `earnings` stay withheld too: nothing in this change
 *   opens a version-submit or an earnings read on an unpublished app, and withholding a
 *   tab is always safe — a tab set is a UI narrowing, never a gate.
 *
 * 🔴 AND THE TAB SET IS A UI NARROWING, NEVER A GATE. Measured on this tree:
 * `appCollaborators.list`, `inviteCollaborator` and `respondToInvite` did NOT check
 * listing status at all — only `getAppListingAuthoringContext`'s refusal stood between a
 * removed listing and a fresh repo grant. `inviteCollaborator`/`respondToInvite` now
 * refuse a non-authorable listing server-side (see `app-collaborator.service.ts`), and
 * THAT is the enforcement point. This function only stops the caller being offered a
 * surface the server is going to refuse.
 *
 *   - `details`       — every AUTHORABLE status, PLUS the owner-repair state. `getMyListingForEdit` /
 *                       `updateListing` are
 *                       LISTING-keyed and seat-aware (both route through
 *                       `resolveListingAccess` via `loadOwnedEditableListing`), and
 *                       `capabilitiesForKind(...).listingContent` is `true` for BOTH
 *                       kinds. There is no shape in which this tab is unreachable.
 *                       🔴 On the repair state the panel is NOT fully editable: the server
 *                       refuses a MATERIAL scalar change with `MATERIAL_CHANGE_BLOCKED`, so
 *                       `ExternalListingEditForm` renders those four inputs disabled with
 *                       the refusal's reason. Offering the tab and NOT doing that is an
 *                       input the author can fill and can never save.
 *
 *   - `media`         — BOTH `capabilities.listingMedia` AND a backing block; on the
 *                       AUTHORABLE statuses and on the repair state.
 *                       🔴 The repair arm MIRRORS `listingMediaEditBlockedReason`, which
 *                       returns `null` (editable) for an owner-unpublished listing and the
 *                       moderator-takedown message otherwise. Offering this tab where that
 *                       verdict is non-null would mount an editor over its own red alert.
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
 *   - `collaborators` — every AUTHORABLE status, and NEVER on a non-authorable one — the
 *                       owner-repair state INCLUDED, which is why the repair branch is
 *                       separate from `authorable` rather than folded into it. Seats
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
  const authorable = isAuthorableListingStatus(ctx.status);
  // 🔴 THE REPAIR BRANCH — strictly narrower than `authorable`, and deliberately NOT a
  // widening of `AUTHORABLE_LISTING_STATUSES`. See the block above.
  const ownerRepair = isOwnerUnpublishedTabContext(ctx);
  if (authorable || ownerRepair) {
    tabs.push('details');
    if (ctx.capabilities.listingMedia === true && ctx.appBlockId != null) tabs.push('media');
  }
  if (authorable) {
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
