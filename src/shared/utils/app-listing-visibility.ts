/**
 * Per-listing VISIBILITY LEVEL — the closed value set, the fail-closed narrowing rule,
 * the breadth ordering, and the one predicate that decides whether a viewer's cohort
 * may see a listing at a given level.
 *
 * ## Why an enum and not a Flipt segment key
 *
 * 🔴 A LISTING STORES A LEVEL, NEVER A SEGMENT KEY. Flag state is a file a bot rewrites
 * wholesale, and a rollout naming a segment that is undefined in the same file is not
 * caught by its gate — so a stale segment reference could degrade toward matching
 * everyone, which is the one failure direction that must be impossible here. A closed
 * enum mapped to a cohort SERVER-SIDE means a flag-state rename cannot widen a listing,
 * an unknown level fails closed, and the whole value space is reviewable in one place.
 *
 * ## Why this lives in its own dependency-free module
 *
 * Same structural reason as `src/shared/utils/store-visibility-scope.ts`: the level is
 * read by the server data layer and the owner-facing editor, so the value set and the
 * ordering must be reachable from both without dragging a server dependency into the
 * browser bundle. The only import is a TYPE, which is erased.
 */

import type { AppListingStatus } from '~/server/services/blocks/app-listing-status.constants';

/** The closed value set. The runtime source of truth for the type below. */
export const APP_LISTING_VISIBILITIES = ['private', 'moderators', 'testers', 'public'] as const;

/**
 * One listing's visibility level — WHO may see it, within whatever the surface already
 * admits:
 *   - `private`    — nobody reaches it through the store; the owner's own authoring
 *                    surfaces and the private-run path are unaffected.
 *   - `moderators` — moderators only. Deliberately NOT counted as real usage.
 *   - `testers`    — the App Blocks tester cohort (and moderators, who are inside it).
 *   - `public`     — everyone the SURFACE admits. See {@link viewerSeesListingVisibility}
 *                    for why that is not "everyone on the internet".
 */
export type AppListingVisibility = (typeof APP_LISTING_VISIBILITIES)[number];

/** Runtime membership test for the closed set above. */
export function isAppListingVisibility(value: unknown): value is AppListingVisibility {
  return (
    typeof value === 'string' && (APP_LISTING_VISIBILITIES as readonly string[]).includes(value)
  );
}

/**
 * Narrow an untrusted, absent or unrecognized level to a real one, FAILING CLOSED.
 *
 * 🔴 Every value that is not exactly one of {@link APP_LISTING_VISIBILITIES} maps to
 * `private` — `undefined` (the column absent while the manual migration is outstanding),
 * `null`, a typo, a level from a future branch this build does not understand. A value we
 * cannot interpret is not evidence of an audience.
 */
export function narrowListingVisibility(value: unknown): AppListingVisibility {
  return isAppListingVisibility(value) ? value : 'private';
}

/**
 * Parse a STORED column value into a level, preserving "no choice expressed".
 *
 * 🔴 `null` IS NOT THE `private` LEVEL, AND CONFLATING THEM IS THE ONE MISTAKE THIS WHOLE
 * SHAPE EXISTS TO PREVENT. The column is nullable with no default because a NOT NULL
 * column has no safe default: `private` would make every FUTURE approval mint a row that
 * vanishes from the store (eight scattered writes set `status='approved'`, with no
 * chokepoint), and `public` would make every new draft publicly visible. `null` means
 * "apply the pre-feature rule for this row's status", which is correct for every status at
 * once and needs no write at any approve site.
 *
 * So: `null` / `undefined` ⇒ `null`. Anything else goes through
 * {@link narrowListingVisibility}, i.e. an UNKNOWN string — a level written by a newer
 * deploy than this build — still fails closed to `private` rather than being treated as
 * unset. That asymmetry is deliberate: absence is a known state, an uninterpretable value
 * is not.
 */
export function parseStoredVisibility(value: unknown): AppListingVisibility | null {
  if (value === null || value === undefined) return null;
  return narrowListingVisibility(value);
}

/**
 * The levels RANKED BY BREADTH — a subset lattice, not a preference order:
 *
 *   private  ⊂  moderators  ⊂  testers  ⊂  public
 *      ∅          mods        mods+testers   everyone the surface admits
 *
 * Every pair is comparable, so the set is TOTALLY ordered and a single `>=` decides
 * membership with no tie-break rule to get wrong.
 *
 * 🔴 THE RANKS MUST STAY DISTINCT, and the ORDER IS DECLARED ONCE HERE. A chain of
 * `===` tests has to be re-audited at every call site whenever the set grows, and one
 * site will be missed — the sibling scope module records that bug in its simplest form
 * (`scope !== 'none'` standing in for "at least as wide as the floor"). Pinned by the
 * suite.
 */
export const APP_LISTING_VISIBILITY_RANK: Readonly<Record<AppListingVisibility, number>> = {
  private: 0,
  moderators: 1,
  testers: 2,
  public: 3,
};

/** How much a level admits, as a comparable number. */
export function listingVisibilityRank(visibility: AppListingVisibility): number {
  return APP_LISTING_VISIBILITY_RANK[visibility];
}

/**
 * A viewer's cohort, as the NARROWEST level that still admits them.
 *
 * A moderator is admitted by every non-private level, so their floor is `moderators`; a
 * tester is admitted by `testers` and `public`; everyone else only by `public`. Phrasing
 * the cohort as a floor on the same scale as the level is what collapses the whole
 * decision to one rank comparison.
 */
export type ListingAudienceFloor = Exclude<AppListingVisibility, 'private'>;

/**
 * Runtime membership test for the floor.
 *
 * 🔴 DERIVED FROM THE LEVEL SET MINUS `private`, NOT A SECOND LITERAL LIST. A hand-written
 * tuple here would be a closed set that cannot grow with the enum, and the member it would
 * most likely miss is a newly added cohort — which would then narrow to the fail-closed
 * default and silently lock that cohort out of its own listings.
 */
export function isListingAudienceFloor(value: unknown): value is ListingAudienceFloor {
  return isAppListingVisibility(value) && value !== 'private';
}

/**
 * May a viewer in this cohort see a listing at this level?
 *
 * 🔴 THIS IS AN `AND` WITH THE SURFACE GATE, NEVER AN OVERRIDE. It answers only "does
 * the LEVEL admit this cohort". A listing at `public` is still invisible to a viewer the
 * surface flags (`app-listings` / `app-blocks-enabled`, both base-off with a segment
 * rollout) refuse — so an owner choosing `public` pre-GA does not publish their app to
 * the internet, it makes it as visible as the surface already allows. Do not "simplify"
 * this later by letting a level bypass the surface gate: that inverts the property and
 * is how a pre-GA leak ships.
 *
 * `private` admits nobody, including a moderator — a moderator reaching a `private`
 * listing does so through a moderation surface, not through a level. That falls out of the
 * rank map rather than needing its own branch: `private` holds the LOWEST rank and
 * {@link ListingAudienceFloor} excludes it, so no floor can rank at or below it.
 *
 * ⚠️ AN EXPLICIT `if (visibility === 'private') return false` STOOD HERE AND WAS REMOVED,
 * because a mutation sweep showed it was UNREACHABLE: deleting it killed no test, since the
 * rank comparison already answers `false` for every floor. A guard an earlier check always
 * wins reads as coverage and provides none, so the property is carried by the two rank
 * tests instead — ranks are DISTINCT and MONOTONIC in the declared order — which is what
 * would actually go red if `private` were ever reranked above a floor.
 *
 * Takes an ALREADY-NARROWED level: run untrusted input through
 * {@link narrowListingVisibility} first.
 */
export function viewerSeesListingVisibility(
  floor: ListingAudienceFloor,
  visibility: AppListingVisibility
): boolean {
  return listingVisibilityRank(visibility) >= listingVisibilityRank(floor);
}

/**
 * The levels a viewer in this cohort can see, for a data-layer `IN (...)` filter.
 *
 * Derived from {@link viewerSeesListingVisibility} rather than hand-listed, so the filter
 * and the predicate cannot disagree — the defect class the sibling scope module was built
 * to close was exactly a read path and a write path each deriving their own answer.
 */
export function visibilitiesVisibleTo(floor: ListingAudienceFloor): AppListingVisibility[] {
  return APP_LISTING_VISIBILITIES.filter((v) => viewerSeesListingVisibility(floor, v));
}

/**
 * The listing statuses on which a level may WIDEN who reaches the store, and the only
 * statuses on which a level may be SET.
 *
 * 🔴 AN ALLOWLIST, NOT A DENYLIST, AND THAT IS THE FAIL-CLOSED DIRECTION. `removed` and
 * `rejected` are both negative moderation outcomes, and letting an owner-settable
 * audience apply to either is a partial un-takedown of their own app — the owner may
 * RUN a delisted app to diagnose it (the private-run path), never make it VISIBLE. A
 * sixth lifecycle status this build has never heard of is excluded by default, which is
 * the whole reason this is not `APP_LISTING_STATUSES.filter(...)`.
 *
 * 🔴 DELIBERATELY NOT `AUTHORABLE_LISTING_STATUSES`, which has the same three members
 * today. That set answers "may the owner still edit this listing's content" — a WRITE
 * question — and its own docblock reserves the right to widen (to a `removed` listing
 * the owner unpublished themselves). Widening a write gate must not silently widen a
 * READ gate, which is exactly the direction that would re-open the un-takedown above.
 * The duplication is the point.
 *
 * `satisfies` pins every member to a real status, so a typo is a compile error rather
 * than a silently inert allowlist entry.
 */
export const VISIBILITY_ELIGIBLE_LISTING_STATUSES = [
  'draft',
  'pending',
  'approved',
] as const satisfies readonly AppListingStatus[];

/** May a level widen, or be set on, a listing in this state? Unknown ⇒ `false`. */
export function isVisibilityEligibleListingStatus(status: string): boolean {
  return (VISIBILITY_ELIGIBLE_LISTING_STATUSES as readonly string[]).includes(status);
}

/**
 * The WIDEST level a listing in this state may be seen at, regardless of what its column
 * says.
 *
 * 🔴 THE REVIEW CEILING, AND ITS ABSENCE WAS A MODERATOR-REVIEW BYPASS. Without it a set
 * level binds identically at every eligible status, so an owner could put
 * `visibility='public'` on a `draft` — a listing whose name, description, external URL,
 * icon, cover and content rating NO MODERATOR HAS EVER SEEN — and it would be served by
 * `GET /api/v1/apps` and `/api/v1/apps/<slug>`, both of which are anon-capable under the
 * deliberate public-catalog grant. For an offsite listing there is no deploy gate either,
 * so the row would carry an owner-controlled unreviewed URL on a civitai.com store page;
 * and because `contentRating` on a draft is self-declared and only re-derived at approve,
 * a self-rated `g` draft with unscanned assets would pass the maturity gate too.
 *
 * So the level can only ever be as wide as the listing's REVIEW STATE permits:
 *   · `approved` — reviewed, so all four levels bind. This is the restrict direction.
 *   · `draft` / `pending` — never reviewed, so the ceiling is `moderators`. That is exactly
 *     the review-sandbox audience the non-approved half of this feature exists for; a wider
 *     level on an unreviewed listing is refused at the READ as well as the write, because a
 *     row can carry a level set before it was withdrawn for re-review.
 *
 * ── 🔴🔴 OPERATOR RULING, 2026-10-02 — THIS IS **D7**, AND IT NARROWS D2 ON PURPOSE ──
 * NOT AN OVERSIGHT AND NOT A TODO.
 *
 * This ceiling was introduced by a correctness lane of the W14 PR, not by an operator ask —
 * and an `/audit-pr` round then found that it NARROWS decision D2 ("the owner sets the level
 * freely within the enum"), which is a narrowing the operator had **explicitly rejected**
 * when they chose resolution (3) for the D4/D5 collision over the mirror-image option (2).
 * So a lane took a decision that had been declined. It was escalated rather than kept
 * quietly, and the operator **ratified it**: the ceiling stays, as D7.
 *
 * 🔴 WHAT D7 CHANGES ABOUT D2, STATED PLAINLY: D2's "freely" now means **freely within what
 * review has cleared**. An owner picks any of the four levels on an `approved` listing, and
 * only `private`/`moderators` on one that has never been reviewed.
 *
 * Grounds, which the audit verified rather than assumed: BOTH `/api/v1/apps` endpoints are
 * anonymous-capable under the deliberate public-catalog grant, so without the ceiling an
 * owner could put an unreviewed listing — their own URL, their own self-declared content
 * rating, no moderator having seen any of it — in front of anonymous traffic.
 *
 * Rejected alternatives: honour D2 as written (no ceiling, which is the exposure above); and
 * a ceiling at `public` only, which would still admit `testers` — a real cohort of real
 * accounts — to content review has never looked at.
 *
 * 🔴 UI COPY REQUIREMENT. The control must tell an owner WHY `testers`/`public` are
 * unavailable before review, or the greyed-out options read as a bug and get filed as one.
 *
 * ⚠️ A LEVEL SURVIVES APPROVAL, AND THAT IS A UI REQUIREMENT RATHER THAN A CODE ONE.
 * The review-sandbox workflow is "set `moderators` so a mod can see my draft" — and on
 * approval that level STAYS, so the listing goes live visible to moderators only, with no
 * owner-side signal that it is still restricted. Nothing here clears it: doing so would mean
 * the approve path WRITING this column, which is the eight-scattered-writes problem the
 * no-type shape exists to avoid, and it would silently discard a deliberate choice for an
 * owner who really did want `moderators` on a live listing. So the UI must surface the
 * current level on the listing and prompt after approval. Recorded as a required behaviour
 * for the follow-up PR rather than left to be discovered.
 *
 * Returns `null` for a status no level may reach at all.
 *
 * 🔴 THE CEILING IS ALSO WHERE D4'S GUARANTEE ENDS — OPERATOR RULING, 2026-10-01: D4 binds
 * PRE-APPROVAL ONLY. Below the ceiling (`draft`/`pending`) a `moderators`-level run reaches
 * the private-run predicate and inherits every owner-invisibility rail. At `approved` it
 * does not, so a moderator's review run there IS debited Buzz and DOES pay the publisher the
 * author fee. That is a decision, not a gap; the full reasoning and the rejected
 * alternatives are at gate (3) of
 * `src/server/services/blocks/private-run-access.service.ts`, and
 * `src/server/services/blocks/__tests__/app-listing-visibility.d4-ruling.test.ts` fails if
 * someone completes the exclusion without revisiting it.
 */
export function maxVisibilityForStatus(status: string): AppListingVisibility | null {
  if (!isVisibilityEligibleListingStatus(status)) return null;
  return status === 'approved' ? 'public' : 'moderators';
}

/**
 * The levels a viewer in this cohort can see ON A LISTING IN THIS STATE — the cohort rule
 * and the review ceiling composed, for a data-layer `IN (...)` list.
 *
 * May be EMPTY (a non-moderator cohort against an unreviewed listing), and a caller
 * building SQL must emit a FALSE predicate rather than an empty `IN ()`, which is a syntax
 * error.
 */
export function visibilitiesVisibleToForStatus(
  floor: ListingAudienceFloor,
  status: string
): AppListingVisibility[] {
  const cap = maxVisibilityForStatus(status);
  if (cap === null) return [];
  return visibilitiesVisibleTo(floor).filter(
    (v) => listingVisibilityRank(v) <= listingVisibilityRank(cap)
  );
}

/**
 * Is this listing visible in the store to a viewer in this cohort?
 *
 * Three rules, in order, and each is load-bearing:
 *
 * 1. 🔴 AN INELIGIBLE STATUS IS REFUSED FIRST. `removed` and `rejected` are negative
 *    moderation outcomes, and a row can carry a level that was set BEFORE it was taken
 *    down — so the allowlist is checked at the READ as well as at the write. Without this
 *    ordering, a stale level on a delisted listing would partially un-take-down the app.
 *
 * 2. 🔴 A `null` LEVEL MEANS "NO CHOICE EXPRESSED" AND FALLS BACK TO THE PRE-FEATURE RULE
 *    for the status: `approved` is visible, everything else is not. This is what makes the
 *    feature inert on every existing row and on every row a future approval mints, with no
 *    write at any of the eight scattered `status='approved'` sites. It can only ever grant
 *    the approved baseline, so it never admits anything the store does not already show.
 *
 * 3. A level that IS set is AUTHORITATIVE, at every eligible status including `approved`,
 *    but never wider than the REVIEW CEILING for that status
 *    ({@link maxVisibilityForStatus}). So an owner can RESTRICT a live `approved` listing to
 *    `testers`, `moderators`, or out of the store entirely with `private`, and can WIDEN an
 *    unreviewed `draft`/`pending` listing as far as `moderators` — the review-sandbox
 *    audience — and no further.
 *
 * ⚠️ RESTRICTING AN APPROVED LISTING IS DISCOVERY-ONLY, and the UI copy has to say so. The
 * run route gates on the backing BLOCK's status and never consults this column, so a
 * restricted approved listing is hidden from the store while anyone holding the slug can
 * still open the app. That is a real and useful behaviour — unlisting — but it is not
 * access control, and `private` here does not mean "nobody can open it".
 *
 * 🔴 AND IT IS STILL AN `AND` WITH THE SURFACE GATE. This predicate never sees the surface
 * scope; the caller applies both. See {@link viewerSeesListingVisibility}.
 */
export function listingVisibleInStore(args: {
  status: string;
  visibility: AppListingVisibility | null;
  floor: ListingAudienceFloor;
}): boolean {
  if (!isVisibilityEligibleListingStatus(args.status)) return false;
  if (args.visibility === null) return args.status === 'approved';
  // 🔴 THE REVIEW CEILING, BEFORE THE COHORT RULE. A level wider than the listing's review
  // state permits is refused outright — see `maxVisibilityForStatus` for the bypass this
  // closes. Checked here as well as at the write, because a row can carry a level set
  // before it was withdrawn for re-review.
  const cap = maxVisibilityForStatus(args.status);
  if (cap === null) return false;
  if (listingVisibilityRank(args.visibility) > listingVisibilityRank(cap)) return false;
  return viewerSeesListingVisibility(args.floor, args.visibility);
}

/**
 * The levels that RESTRICT who reaches a listing — every level except `public`.
 *
 * Derived from the enum rather than hand-listed, so a new restricted cohort is a member
 * automatically and the badge cannot silently skip it.
 */
export type RestrictedListingAudience = Exclude<AppListingVisibility, 'public'>;

/**
 * The listing's restricted audience AS THIS VIEWER MAY KNOW IT, for the store's
 * "Testers only" / "Moderators only" / "Unlisted" badge — or `null`.
 *
 * 🔴 VIEWER-SCOPED, AND THAT IS WHY THIS IS NOT THE RAW COLUMN ON THE PUBLIC DTO. The level
 * is an owner-only setting; `ListingVisibilityMenuModal` records why it stays off the card
 * and detail DTOs. A viewer learns it only when they are:
 *   · the OWNER, or a MODERATOR — the two parties who can already read or set it; or
 *   · in a cohort the level ADMITS, by {@link listingVisibleInStore} — the same predicate the
 *     store's own read gate uses, so there is no second rule here to drift from it. A tester
 *     looking at a `testers` listing learns nothing they could not infer from seeing it.
 *
 * `private` admits no cohort, so it reaches only the owner and moderators: a `private`
 * listing stays openable by URL (it is a discoverability setting, not access control), and
 * an anonymous holder of that URL must not be told how it is restricted.
 *
 * 🔴 THE COHORT ARM RE-CHECKS THE LEVEL EVEN WHEN THE CALLER HAS ALREADY ADMITTED THE ROW.
 * The store grid's id page is cached and the level is read live, so a page cached before an
 * owner narrowed their listing can still carry it; re-deriving here means that stale row
 * shows NO badge rather than disclosing the new, narrower level to a viewer it excludes.
 *
 * `null` / `public` ⇒ `null`: an unset level means "no choice expressed", and `public` is
 * not a restriction, so neither renders anything.
 */
export function restrictedAudienceForViewer(args: {
  visibility: AppListingVisibility | null;
  status: string;
  floor: ListingAudienceFloor;
  isOwner: boolean;
  isModerator: boolean;
}): RestrictedListingAudience | null {
  const { visibility } = args;
  if (visibility === null || visibility === 'public') return null;
  if (args.isOwner || args.isModerator) return visibility;
  return listingVisibleInStore({ status: args.status, visibility, floor: args.floor })
    ? visibility
    : null;
}
