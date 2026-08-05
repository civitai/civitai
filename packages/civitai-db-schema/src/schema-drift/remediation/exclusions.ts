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
 *
 * HOW THIS SET WAS DERIVED, because a handed list is not a population. Two enumerations
 * over primary sources, not a spot check:
 *
 *   A. Every one of the 688 files under `prisma/migrations` was scanned for
 *      `ADD CONSTRAINT` / `DROP CONSTRAINT` on each expected constraint name, keeping
 *      those whose LAST recorded operation is a DROP. Absence is intentional and
 *      recorded; "restoring" one reverts a decision. Yields three:
 *      `Article.coverId`, `ImageConnection.imageId`, `TagsOnImageNew.imageId`.
 *   B. Every relation on a table rebuilt by `recreateRankTable` — a `CREATE TABLE ... AS
 *      SELECT` copies no constraints. SEVEN of the nine owning-side `*Rank` relations have
 *      a `rank: { table }` declaration in `src/server/metrics/*.metrics.ts` to point at.
 *      The remaining two (`QuestionRank`, `AnswerRank`) do NOT — they are included on the
 *      strength of the NAME alone, are backed by views today, and are marked as such at
 *      their entry below. Do not read this criterion as verified for all nine.
 *   C. `TagsOnImageNew.imageId` again, independently: enforcement is a live trigger.
 *
 * **Union: 12** — nine rank relations plus `Article.coverId` and `ImageConnection.imageId`
 * (`TagsOnImageNew.imageId` is in both A and C). That is the number of entries in the
 * array below; if the two ever disagree, the array is authoritative and this comment is
 * stale.
 *
 * 🔴 WHAT CRITERION A ACTUALLY DEPENDS ON, because the number is not reproducible from the
 * sentence alone. Applied literally to every constraint name in the schema it returns
 * EIGHT, not three; it narrows to three only in conjunction with the live catalog, i.e.
 * restricted to relations that are ALSO currently missing their foreign key. Two further
 * dependencies are load-bearing and neither is obvious:
 *   - A `RENAME CONSTRAINT` is invisible to a last-operation timeline. One did materialise
 *     (`ModelHash.modelVersionId`) and was filtered out incidentally by the catalog
 *     restriction rather than by the method noticing it.
 *   - The scan assumes Prisma's `<Table>_<column>_fkey` name. Six foreign keys in this
 *     database do not follow it, one of them (`DownloadHistory.modelVersionId`) inside the
 *     37 — matched only because its name happens to coincide.
 * Re-run the derivation rather than trusting this paragraph if the schema has moved.
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

  // --- deliberately dropped by a committed migration --------------------------------
  // Derived by scanning all 688 files under prisma/migrations for ADD/DROP CONSTRAINT on
  // each expected constraint name and keeping those whose LAST operation is a DROP. That
  // enumeration returns exactly three, all listed here. See the header note above.
  // `QuestionRank` and `AnswerRank` are the remaining two `*Rank` models. They are backed
  // by VIEWS today, so the planner already refuses them three times over (no table, no
  // columns, `NoAction`) and nothing here is load-bearing at present.
  //
  // They are listed anyway because every one of those three protections is incidental.
  // `NoAction` in particular is exactly the protection that #3589 removed from the other
  // seven when it corrected their declared actions — the same correction applied here
  // would leave these relying only on being views. Listing them costs nothing and makes
  // the list agree with its own stated criterion instead of with today's accident.
  //
  // 🔴 NOT VERIFIED, and deliberately not claimed: whether these two are rebuilt by
  // `recreateRankTable`. No metrics file declares them, so the CTAS mechanism is asserted
  // here by NAME only, unlike the seven above which have a declaration to point at.
  {
    key: 'QuestionRank.questionId',
    reason: `${RANK_REBUILD_REASON} Backed by a view today, so this entry is defence in depth rather than the active protection — see the note above it.`,
  },
  {
    key: 'AnswerRank.answerId',
    reason: `${RANK_REBUILD_REASON} Backed by a view today, so this entry is defence in depth rather than the active protection — see the note above it.`,
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
  {
    key: 'ImageConnection.imageId',
    reason:
      'Removed on purpose by 20240307231126_nsfw_level_update_queue (created by ' +
      '20230904155529_add_bounty_schema; never re-added by any later migration). That is ' +
      'the SAME migration that drops all four CollectionItem entity foreign keys and ' +
      'introduces JobQueue with its CleanUp and CleanIfEmpty job types — i.e. the team ' +
      'deliberately replaced foreign-key-enforced cascade cleanup with an ' +
      'application-level job queue. Restoring this constraint reverts that decision ' +
      'without engaging with the mechanism that replaced it, and may race or duplicate ' +
      'the JobQueue path. Whether that queue is actually keeping up is a real and ' +
      'currently unanswered question — but it is a question to answer before re-adding ' +
      'the constraint, not by re-adding it.',
  },
]);

/**
 * Whether a model's table is rebuilt by `recreateRankTable`, and so cannot keep a
 * constraint.
 *
 * 🔴 DELIBERATELY NOT DERIVED FROM `EXCLUSIONS`. The previous revision exported the rank
 * keys by filtering the exclusion list for names ending in `Rank`, and asserted its length
 * was 7. That assertion is a tautology: it reads the list, so deleting a rank entry moves
 * BOTH the actual and the expected number and the test stays green. It could never have
 * detected the omission it was written to prevent.
 *
 * This predicate is about the schema instead, so a test can enumerate the rank relations
 * the SCHEMA declares and assert each one is excluded — which fails when an entry is
 * missing, and fails again when a new rank model appears.
 */
export function isCtasRebuiltModel(model: string): boolean {
  // 🔴 A SPELLED GUARD, and knowingly so. This matches a NAME, not the mechanism: there are
  // ten `*Rank` models and `NewOrderRank` is a static enum-keyed lookup table, not a
  // CTAS-rebuilt metrics table. It is over-inclusive rather than under-inclusive, which is
  // the safe direction for a never-add list, and harmless today because `NewOrderRank`
  // declares no owning-side relation. The authoritative signal would be a `rank: { table }`
  // declaration in `src/server/metrics/*.metrics.ts`; this module cannot read that without
  // depending on the application, so the name is used and the limitation is written down.
  return model.endsWith('Rank');
}

const BY_KEY = new Map(EXCLUSIONS.map((e) => [e.key, e]));

/** The exclusion for a relation key, or `null`. */
export function findExclusion(key: string): Exclusion | null {
  return BY_KEY.get(key) ?? null;
}

/**
 * Fail CLOSED when an exclusion no longer matches any declared relation.
 *
 * The key is `ModelName.dbColumnName`, which mixes a Prisma model name with a *mapped*
 * column name — so adding `@map("image_id")` to `TagsOnImageNew.imageId` silently stops
 * the exclusion matching, and the relation reappears as an ordinary `Cascade` DELETE
 * against a table with billions of rows. That is failing open, which is the wrong
 * direction for a list whose whole job is to say "never".
 *
 * A test cannot cover this on its own: the mismatch would be introduced by a schema change
 * in some unrelated PR, and the guard has to hold at the moment the planner runs rather
 * than at the moment someone remembers to run this suite. So a stale entry is a hard
 * error, not a warning — the planner refuses to produce a plan at all.
 */
export function assertExclusionsResolve(
  declaredKeys: ReadonlySet<string>,
  knownModels: ReadonlySet<string>
): void {
  // Scoped to exclusions whose MODEL the schema still declares.
  //
  // Without that scope the guard fires on any partial schema — every unit fixture in this
  // suite declares two models and none of the excluded ones — so it would have to be
  // switched off in tests, which is the same as not having it. Restricted this way it
  // still catches the failure the guard exists for: the column key drifting out from
  // under a model that is still there, which is what an added `@map` does.
  //
  // 🔴 WHAT THIS DOES NOT CATCH: renaming the MODEL itself removes it from `knownModels`,
  // so the entry goes quiet here. That case is covered instead by the suite-level test
  // asserting every exclusion key resolves against the REAL schema — a different check at
  // a different time, and the reason both exist.
  const stale = EXCLUSIONS.map((e) => e.key).filter(
    (k) => knownModels.has(k.split('.')[0]) && !declaredKeys.has(k)
  );
  if (stale.length === 0) return;
  throw new Error(
    `Exclusion(s) no longer match any declared relation: ${stale.join(', ')}. ` +
      'These relations must NEVER receive a foreign key, so a key that stops matching ' +
      'fails open — the relation would be planned as an ordinary remediation. This is a ' +
      'hard error rather than a warning for that reason. The usual cause is a newly ' +
      '@map()-ed column; update the key in exclusions.ts to match.'
  );
}
