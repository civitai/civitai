/**
 * Relations that must never receive a foreign key, with the reason each one is here.
 *
 * This list is NOT a tuning knob and there is no flag that overrides it. Every entry is a
 * relation the schema declares and the database deliberately does not enforce, for a
 * reason that lives outside the schema — a trigger, a table-rebuild job, or a migration
 * that removed the constraint on purpose. A planner that reads only the declared
 * referential action cannot see any of those, so it would happily add all of them.
 *
 * 🔴 THE DECLARED ACTION USED TO CARRY SOME OF THIS SIGNAL, AND NO LONGER DOES. Before
 * `fix(schema): correct 8 referential actions that misdescribe the database` (#3589) the
 * seven `*Rank` relations and `TagsOnImageNew.imageId` resolved to `NoAction` / `Restrict`,
 * so an action-aware planner refused them for free. #3589 corrected all eight to `Cascade`
 * — correctly, since `Cascade` is the semantics the trigger and the rebuild job implement.
 * The effect on this module is that eight relations moved from "refused by the action
 * guard" to "looks like an ordinary cascade delete". This list is now the only thing
 * standing between them and an `ADD CONSTRAINT`, and the only reason a reader can tell the
 * difference. Do not collapse it into the action check.
 */

export interface Exclusion {
  /** `Model.column`, matching `RelationPlan.key`. */
  key: string;
  reason: string;
}

/**
 * Reason shared by every relation on a `*Rank` table.
 *
 * `recreateRankTable` (`src/server/metrics/base.metrics.ts`) rebuilds a rank table with
 * `CREATE TABLE "<X>Rank_New" AS SELECT * FROM "<X>Rank_Live"`, then `DROP TABLE` and
 * rename. `CREATE TABLE ... AS SELECT` copies no constraints — which is why the function
 * manually re-adds the primary key and every index — so any foreign key added to a rank
 * table is gone at the next refresh, without an error anywhere.
 *
 * A constraint that can be added and cannot be kept is recurring drift, which is worse
 * than permanent drift: the detector reports it, someone adds it, and it is missing again
 * before the ticket is closed.
 */
const RANK_REBUILD_REASON =
  'Rank tables are rebuilt by recreateRankTable (src/server/metrics/base.metrics.ts) with ' +
  'CREATE TABLE "<X>Rank_New" AS SELECT * FROM "<X>Rank_Live" -> DROP -> rename. A CTAS ' +
  'copies no constraints, so a foreign key added here disappears at the next refresh. ' +
  'The fix is to make these proper Prisma view blocks, not to add the constraint.';

export const EXCLUSIONS: readonly Exclusion[] = Object.freeze([
  {
    key: 'TagsOnImageNew.imageId',
    reason:
      'Enforcement is a live trigger, not a constraint. The foreign key was created ' +
      'ON DELETE CASCADE in 20250303170613_tags_on_image_new and dropped deliberately in ' +
      '20250314203912_drop_tags_on_image, one day after after_image_delete_trigger took ' +
      'over; the trigger body is DELETE FROM "TagsOnImageNew" WHERE "imageId" = OLD.id. ' +
      'Re-adding the constraint duplicates the trigger and puts a per-insert reference ' +
      'check on one of the largest write-hot tables in the database for no benefit. The ' +
      'schema comment on this model says the same thing.',
  },

  // --- the rank family ------------------------------------------------------------
  // The brief for this module named SIX rank relations. There are SEVEN, and the seventh
  // is `ArticleRank.articleId`. It is excluded here for the same mechanism, deliberately
  // and as a departure from that list — see the note under EXCLUDED_RANK_KEYS below.
  {
    key: 'BountyRank.bountyId',
    reason: `${RANK_REBUILD_REASON} BountyRank refreshes every 5 minutes.`,
  },
  { key: 'TagRank.tagId', reason: RANK_REBUILD_REASON },
  { key: 'ClubRank.clubId', reason: RANK_REBUILD_REASON },
  { key: 'BountyEntryRank.bountyEntryId', reason: RANK_REBUILD_REASON },
  { key: 'CollectionRank.collectionId', reason: RANK_REBUILD_REASON },
  { key: 'UserRank.userId', reason: RANK_REBUILD_REASON },
  {
    key: 'ArticleRank.articleId',
    reason:
      `${RANK_REBUILD_REASON} ArticleRank is one of the two rank tables whose refresh is ` +
      'still ACTIVE (src/server/metrics/article.metrics.ts declares table: "ArticleRank"; ' +
      'the TagRank, BountyEntryRank, UserRank and CollectionRank declarations are ' +
      'commented out), so it is among the most exposed to this, not the least.',
  },

  {
    key: 'Article.coverId',
    reason:
      'Removed on purpose by migration 20250614053144_remove_article_cover_id_fkey, a ' +
      'migration whose entire content is that one DROP CONSTRAINT. It was originally ' +
      'added ON DELETE NO ACTION by 20240307231126_nsfw_level_update_queue, which never ' +
      "matched the schema's SetNull declaration either. The reason for the removal is " +
      'not recorded in the migration, so restoring it would revert a decision nobody here ' +
      'has the context for. The 610 orphan cover references are real and worth fixing — ' +
      'but as a data fix with an owner, not as a side effect of a constraint run.',
  },
]);

/**
 * The rank keys, so a test can pin the departure from the six-relation brief explicitly
 * rather than have it hide inside a total.
 */
export const EXCLUDED_RANK_KEYS: readonly string[] = Object.freeze(
  EXCLUSIONS.filter((e) => e.key.split('.')[0].endsWith('Rank')).map((e) => e.key)
);

const BY_KEY = new Map(EXCLUSIONS.map((e) => [e.key, e]));

/** The exclusion for a relation key, or `null`. */
export function findExclusion(key: string): Exclusion | null {
  return BY_KEY.get(key) ?? null;
}
