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
 * Does this level count as REAL USAGE — owner analytics and the author fee?
 *
 * 🔴 ONE PREDICATE FOR BOTH DECISIONS, because they are one decision. `moderators` is a
 * review audience: a run by it must be invisible in the owner's analytics (a visible
 * review run tells a bad actor exactly when review is happening) and must not pay the
 * author fee (the reviewer would be debited and the publisher credited for a review).
 * `testers` and `public` are real audiences whose usage counts and pays.
 *
 * `private` is unreachable through a level, so it can produce no run; it answers `false`
 * because an unreachable audience has no usage, not because it is excluded.
 */
export function listingVisibilityCountsAsUsage(visibility: AppListingVisibility): boolean {
  return visibility === 'testers' || visibility === 'public';
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
 * Is this listing visible in the store to a viewer in this cohort?
 *
 * 🔴 THE LEVEL ONLY EVER WIDENS. `approved` is the PRE-FEATURE baseline and is never
 * revoked by a level: before this feature the store showed exactly the approved
 * listings, so making an approved row's visibility authoritative would mean a newly
 * approved listing (whose column carries the `private` default) silently vanished from
 * the store. The level's job is to admit a NON-approved listing to the cohort it names.
 *
 * Narrowing an approved listing is therefore NOT expressible here, and that is a
 * deliberate omission rather than an oversight: taking an approved app out of the store
 * already has a feature (owner unpublish → `status='removed'`), and a second mechanism
 * for it would need the approve path to stamp a level as well.
 *
 * 🔴 AND IT IS STILL AN `AND` WITH THE SURFACE GATE. This predicate never sees the
 * surface scope; the caller applies both. See {@link viewerSeesListingVisibility}.
 *
 * Takes an ALREADY-NARROWED level.
 */
export function listingVisibleInStore(args: {
  status: string;
  visibility: AppListingVisibility;
  floor: ListingAudienceFloor;
}): boolean {
  if (!isVisibilityEligibleListingStatus(args.status)) return false;
  if (args.status === 'approved') return true;
  return viewerSeesListingVisibility(args.floor, args.visibility);
}
