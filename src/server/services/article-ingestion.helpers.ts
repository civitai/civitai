import {
  TEXT_MODERATION_RETRY_LIMIT,
  TEXT_MODERATION_RETRY_STATUSES,
} from '~/server/jobs/text-moderation-retry.constants';
import { ArticleIngestionStatus, type EntityModerationStatus } from '~/shared/utils/prisma/enums';
import { removeTags } from '~/utils/string-helpers';

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

/**
 * The images stored on the `Article` row itself rather than in `ImageConnection`: the card cover
 * and the optional page banner. Each is scanned, rated, rescanned and cleaned up like a content
 * image, so every path that folds in "the cover" must fold in this list instead.
 */
export function articleOwnImageIds(article: {
  coverId: number | null;
  bannerId: number | null;
}): number[] {
  const ids = [article.coverId, article.bannerId].filter((id): id is number => id != null);
  return [...new Set(ids)];
}

/**
 * The text an article's XGuard check scans. Every submitter and the verdict-hash comparison build
 * it here, so a verdict's stored hash can be compared with the article's current text.
 */
export function articleModerationText(title: string | null | undefined, content: string | null) {
  return [title ?? '', removeTags(content ?? '')].filter(Boolean).join(' ');
}

/** The fields an article's text scan reads, hashed into the verdict's `textHash`. */
export function articleTextScanFields(title: string | null, content: string | null) {
  return [
    { heading: 'Title', text: title },
    { heading: 'Content', text: content ? removeTags(content) : null },
  ];
}

/**
 * `Article.metadata.ingestionError`: one Error episode of an article, kept until it reaches Scanned
 * or Blocked. A retry round sends its images back to Rescan, which can recompute the article
 * through Pending, so the episode outlives a stay in Pending; an author's save keeps it too. While
 * it lasts, the article never goes public past an image held for a moderator.
 */
export type ArticleIngestionErrorState = {
  enteredAt: number;
  rounds: number;
  lastRoundAt?: number;
  exhaustedAt?: number;
  /** When its owner was told. */
  notifiedAt?: number;
  /** When the reconcile job last looked at it. */
  checkedAt?: number;
  /** Recorded after the fact (the article was at Error before episodes were): its owner is not told. */
  silent?: boolean;
};

/** Days after the episode was recorded that each retry round is due. */
export const INGESTION_ERROR_ROUND_DAYS = [1, 3, 7];
const DAY_MS = 24 * 60 * 60 * 1000;

export function readIngestionErrorState(metadata: unknown): ArticleIngestionErrorState | null {
  const state = (metadata as { ingestionError?: unknown } | null)?.ingestionError as
    | Partial<ArticleIngestionErrorState>
    | undefined;
  if (typeof state?.enteredAt !== 'number') return null;
  return { ...state, enteredAt: state.enteredAt, rounds: Number(state.rounds) || 0 };
}

/** A recorded-after-the-fact episode, for an article found at Error without one. */
export const silentIngestionErrorState = (now: number): ArticleIngestionErrorState => ({
  enteredAt: now,
  rounds: 0,
  silent: true,
});

/**
 * What the reconcile job does with an article still at Error: `start` an episode it never recorded,
 * `round` when the next retry is due, `exhaust` a day after the last one (once its scans are back),
 * and otherwise `check` it once a day, since a moderator clearing a held image recomputes nothing.
 */
export function ingestionErrorStep(
  state: ArticleIngestionErrorState | null,
  now: number
): 'start' | 'round' | 'exhaust' | 'check' | 'wait' {
  if (!state) return 'start';
  const due = INGESTION_ERROR_ROUND_DAYS[state.rounds];
  if (due !== undefined && now >= state.enteredAt + due * DAY_MS) return 'round';
  if (due === undefined && !state.exhaustedAt && now >= (state.lastRoundAt ?? 0) + DAY_MS)
    return 'exhaust';
  return now >= (state.checkedAt ?? state.enteredAt) + DAY_MS ? 'check' : 'wait';
}

/**
 * The metadata an author's save writes: the stored keys under the sent ones, with the stored Error
 * episode and never one the client sent, and a silent one for an article already at Error without
 * one, so the save cannot lift the review hold.
 */
export function savedArticleMetadata<T extends object>({
  stored,
  sent,
  ingestion,
  now,
}: {
  stored: T | null;
  sent: T | undefined;
  ingestion: ArticleIngestionStatus | undefined;
  now: number;
}): T & { ingestionError?: ArticleIngestionErrorState } {
  const { ingestionError: _sent, ...merged } = { ...stored, ...sent } as T & {
    ingestionError?: unknown;
  };
  const episode =
    readIngestionErrorState(stored) ??
    (ingestion === ArticleIngestionStatus.Error ? silentIngestionErrorState(now) : null);
  return { ...(merged as T), ...(episode ? { ingestionError: episode } : {}) };
}

/**
 * Whether a retry round sends the article's text check again: only one that failed and spent the
 * retry job's attempts. A check that succeeded is never sent again.
 */
export function textCheckSpentRetries(
  moderation: { status: EntityModerationStatus; retryCount: number } | null
) {
  return (
    !!moderation &&
    TEXT_MODERATION_RETRY_STATUSES.includes(moderation.status) &&
    moderation.retryCount >= TEXT_MODERATION_RETRY_LIMIT
  );
}
