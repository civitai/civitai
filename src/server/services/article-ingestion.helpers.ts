import { ArticleIngestionStatus } from '~/shared/utils/prisma/enums';

export type ArticleIngestionInputs = {
  imageBlocked: boolean;
  imageError: boolean;
  imageDone: boolean;
  textBlocked: boolean;
  textError: boolean;
  textDone: boolean;
  hasModeratorOverride: boolean;
};

/**
 * Pure decision for the article ingestion state machine, called from
 * `recomputeArticleIngestionInTx` (the single choke point every scan/webhook/
 * edit/reconcile recompute flows through). Lives in its own light module so the
 * moderator-override precedence is unit-testable without dragging in the whole
 * article.service dependency graph.
 *
 * Precedence, highest first:
 *  1. Blocked — a policy-blocked image/text is a moderation signal, not a rating
 *     question, so a moderator NSFW override never bypasses it. `ingestion =
 *     Blocked` is the sole guard keeping a blocked image out of the feed and the
 *     search index: `updateArticleNsfwLevels` derives the level from
 *     `ingestion = 'Scanned'` images only and COALESCEs the override over it, so
 *     a blocked (incl. pHash/CSAM) image's level never reaches `nsfwLevel`.
 *  2. Override → Scanned — a moderator override supplies the article's rating
 *     outright, so it supersedes both a still-Pending scan AND an Error. An
 *     unscannable content image (e.g. animated webp, which the image scanner
 *     errors on) must not drag an overridden article to Error and hide it; the
 *     override is a human rating decision the scan can't reproduce. (#3314 only
 *     let the override replace Pending, which is why an overridden article with
 *     an unscannable embedded image still went Error.)
 *  3. Error — an unresolvable scan/text failure with no override in force.
 *  4. Scanned — everything terminal and clean.
 *  5. Pending — still waiting on a scan/moderation callback.
 */
export function deriveArticleIngestionState({
  imageBlocked,
  imageError,
  imageDone,
  textBlocked,
  textError,
  textDone,
  hasModeratorOverride,
}: ArticleIngestionInputs): ArticleIngestionStatus {
  if (imageBlocked || textBlocked) return ArticleIngestionStatus.Blocked;
  if (hasModeratorOverride) return ArticleIngestionStatus.Scanned;
  if (imageError || textError) return ArticleIngestionStatus.Error;
  if (imageDone && textDone) return ArticleIngestionStatus.Scanned;
  return ArticleIngestionStatus.Pending;
}
