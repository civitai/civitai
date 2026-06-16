import { Prisma } from '@prisma/client';
import { constants } from '~/server/common/constants';
import { NotificationCategory, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { articlesSearchIndex } from '~/server/search-index';
import { createNotification } from '~/server/services/notification.service';
import { updateArticleNsfwLevels } from '~/server/services/nsfwLevels.service';
import { getBrowsingLevelLabel } from '~/shared/constants/browsingLevel.constants';
import {
  ArticleIngestionStatus,
  ArticleStatus,
  ImageIngestionStatus,
  ReportStatus,
} from '~/shared/utils/prisma/enums';
// Numeric (bitwise) NsfwLevel — `Blocked` is 32. NOT the Prisma string enum of
// the same name in `~/shared/utils/prisma/enums`.
import { NsfwLevel } from '~/server/common/enums';
import { handleLogError } from '~/server/utils/errorHandling';

export type AutoApproveEntryPoint = 'submission' | 'scan-completion';

type ArticleForGate = {
  id: number;
  status: ArticleStatus;
  ingestion: ArticleIngestionStatus;
  nsfwLevel: number;
  moderatorNsfwLevel: number | null;
  moderatorNsfwLevelBasis: number | null;
  coverId: number | null;
};

export type AutoApproveGateResult =
  | { eligible: true; derivedLevel: number }
  | { eligible: false; reason: string; derivedLevel: number | null };

/**
 * Compute the derived NSFW level the article would settle at if no moderator
 * override were active. Mirrors the SQL in `updateArticleNsfwLevels` exactly
 * for the (cover, content images, moderation floor) components, deliberately
 * ignoring `userNsfwLevel` — when an override is in place, `userNsfwLevel` is
 * locked-stale and cannot be trusted as a ceiling.
 *
 * Returns:
 *   - `null` if the article row doesn't exist (caller treats as "not eligible").
 *   - `0` for a text-only / no-images article with no moderation floor — a
 *     legitimate "PG-or-lower" signal that must be allowed to pass gate #5.
 *   - A positive bitwise level otherwise.
 *
 * Intentional divergence from `updateArticleNsfwLevels`: this query joins on
 * `cover.ingestion = 'Scanned'` only (not `IN ('Scanned', 'Blocked')`).
 * `evaluateAutoApproveGate` rejects Blocked covers up front, so the Blocked
 * branch is unreachable here and the tighter join makes that explicit. Any
 * change that allows Blocked covers through the gate must also widen this
 * join to match `updateArticleNsfwLevels`.
 */
export async function computeArticleDerivedNsfwLevel(articleId: number): Promise<number | null> {
  const rows = await dbRead.$queryRaw<{ derived: number | null }[]>(Prisma.sql`
    WITH level AS (
      SELECT
        a.id,
        GREATEST(
          COALESCE(max(cover."nsfwLevel"), 0),
          COALESCE(max(content_imgs."nsfwLevel"), 0)
        ) AS "nsfwLevel"
      FROM "Article" a
      LEFT JOIN "Image" cover
        ON a."coverId" = cover.id
        -- Auto-approve gate rejects Blocked covers up front, so this path
        -- only sees Scanned covers. Keep the join tight to mirror that and
        -- avoid implying Blocked covers ever reach this computation.
        AND cover."ingestion" = 'Scanned'
      LEFT JOIN "ImageConnection" ic
        ON ic."entityId" = a.id
        AND ic."entityType" = 'Article'
      LEFT JOIN "Image" content_imgs
        ON ic."imageId" = content_imgs.id
        AND content_imgs."ingestion" = 'Scanned'
      WHERE a.id = ${articleId}
      GROUP BY a.id
    ),
    moderation_floor AS (
      SELECT
        a.id,
        CASE
          WHEN EXISTS (
            SELECT 1 FROM "EntityModeration" em
            WHERE em."entityType" = 'Article'
              AND em."entityId" = a.id
              AND em.status = 'Succeeded'::"EntityModerationStatus"
              AND (em.blocked = TRUE OR 'nsfw' = ANY(em."triggeredLabels"))
          ) OR EXISTS (
            SELECT 1 FROM "ArticleReport" ar
            JOIN "Report" r ON r.id = ar."reportId"
            WHERE ar."articleId" = a.id
              AND r.reason = 'NSFW'::"ReportReason"
              AND r.status = 'Actioned'::"ReportStatus"
          ) THEN 4
          ELSE 0
        END AS "floor"
      FROM "Article" a
      WHERE a.id = ${articleId}
    )
    SELECT GREATEST(level."nsfwLevel", mf."floor") AS derived
    FROM level
    JOIN moderation_floor mf ON mf.id = level.id;
  `);

  // Distinguish "article row missing" (null/undefined) from "article exists
  // but has no derivable image/floor signal" (0). Text-only articles legit-
  // imately resolve to 0 and must be allowed to pass gate #5 against any
  // suggestedLevel >= 1. Returning null here would permanently block auto-
  // approve for those articles.
  if (rows.length === 0) return null;
  return rows[0]?.derived ?? 0;
}

/**
 * Decide whether a (suggestedLevel, article) pair qualifies for auto-approval.
 *
 * All gate conditions must hold:
 *   1. suggestedLevel < article.nsfwLevel               (down-direction only)
 *   2. moderatorNsfwLevel != null                       (override is what we'd clear)
 *   2b. moderatorNsfwLevel != Blocked                   (never auto-unblock a TOS pin)
 *   3. article fully scanned, no pending/blocked/error  (trust the rescan)
 *   4. article is Published (not UnpublishedViolation)  (sanity)
 *   5. derived <= suggestedLevel                        (content actually agrees)
 *   6. basis != null && derived < basis                 (content GENUINELY dropped
 *                                                        since the override was set)
 *
 * Gate #6 is the guard against clearing a deliberate above-images override. The
 * basis is the content-derived level captured when the override was placed (see
 * `Article.moderatorNsfwLevelBasis`). If current `derived` is still >= that
 * basis, the content hasn't moved — the override encodes human judgment the
 * scanners can't reproduce (text nuance, context) and must NOT be auto-cleared.
 * A null basis (legacy override predating the column, or one set without a
 * snapshot) fails closed → the dispute routes to the mod queue.
 *
 * The caller is responsible for ownership / rate-limit / re-edit-gate checks
 * upstream — this helper only judges the auto-approve decision itself.
 */
export async function evaluateAutoApproveGate({
  article,
  suggestedLevel,
}: {
  article: ArticleForGate;
  suggestedLevel: number;
}): Promise<AutoApproveGateResult> {
  // 1 + 2 + 4: cheap field checks first, no DB round-trip required.
  if (article.moderatorNsfwLevel == null) {
    return { eligible: false, reason: 'no-override', derivedLevel: null };
  }
  // 2b: a Blocked override is a TOS pin — never auto-clear it via a dispute,
  // regardless of what the images currently scan to. The proper unblock path
  // is a moderator action, not an owner-initiated rating dispute.
  if (article.moderatorNsfwLevel === NsfwLevel.Blocked) {
    return { eligible: false, reason: 'override-blocked', derivedLevel: null };
  }
  if (suggestedLevel >= article.nsfwLevel) {
    return { eligible: false, reason: 'not-down-direction', derivedLevel: null };
  }
  if (article.status !== ArticleStatus.Published) {
    return { eligible: false, reason: 'article-not-published', derivedLevel: null };
  }
  if (article.ingestion !== ArticleIngestionStatus.Scanned) {
    return { eligible: false, reason: 'article-not-scanned', derivedLevel: null };
  }

  // 3: per-image scan check.
  const [coverOk, contentImagesProblematic] = await Promise.all([
    article.coverId
      ? dbRead.image
          .findUnique({
            where: { id: article.coverId },
            select: { ingestion: true },
          })
          .then((img) => img?.ingestion === ImageIngestionStatus.Scanned)
      : Promise.resolve(true),
    dbRead.imageConnection.count({
      where: {
        entityId: article.id,
        entityType: 'Article',
        image: {
          ingestion: {
            in: [
              ImageIngestionStatus.Pending,
              ImageIngestionStatus.Rescan,
              ImageIngestionStatus.PendingManualAssignment,
              ImageIngestionStatus.Blocked,
              ImageIngestionStatus.Error,
              ImageIngestionStatus.NotFound,
            ],
          },
        },
      },
    }),
  ]);

  if (!coverOk) {
    return { eligible: false, reason: 'cover-not-scanned', derivedLevel: null };
  }
  if (contentImagesProblematic > 0) {
    return { eligible: false, reason: 'content-images-not-clean', derivedLevel: null };
  }

  // 5: derived must agree with (or be below) suggested.
  const derivedLevel = await computeArticleDerivedNsfwLevel(article.id);
  if (derivedLevel === null) {
    // Nothing to derive from — no signal we trust enough to auto-approve.
    return { eligible: false, reason: 'no-derivable-signal', derivedLevel: null };
  }
  if (derivedLevel > suggestedLevel) {
    return { eligible: false, reason: 'derived-exceeds-suggested', derivedLevel };
  }

  // 6: the override may only be auto-cleared when the content that justified it
  // has genuinely dropped. A null basis fails closed (legacy / unsnapshotted
  // override → mod queue); derived still >= basis means the content hasn't moved
  // and the override is encoding non-image judgment we must not auto-erase.
  if (article.moderatorNsfwLevelBasis == null) {
    return { eligible: false, reason: 'no-override-basis', derivedLevel };
  }
  if (derivedLevel >= article.moderatorNsfwLevelBasis) {
    return { eligible: false, reason: 'content-not-dropped-since-override', derivedLevel };
  }

  return { eligible: true, derivedLevel };
}

type AutoResolveSubmissionArgs = {
  mode: 'create';
  articleId: number;
  ownerUserId: number;
  suggestedLevel: number;
  userComment: string | null;
  /** The article's current effective nsfwLevel (the override that's being cleared). */
  previousLevel: number;
  /** Article title for the notification body. */
  articleTitle: string;
};

type AutoResolveExistingArgs = {
  mode: 'resolve-existing';
  reviewId: number;
  articleId: number;
  ownerUserId: number;
  suggestedLevel: number;
  /** Snapshot of the article's nsfwLevel at the time the review was filed. */
  previousLevel: number;
  articleTitle: string;
};

export type AutoResolveArgs = AutoResolveSubmissionArgs | AutoResolveExistingArgs;

const AUTO_APPROVE_MOD_COMMENT = 'Auto-approved: rescan matched requested rating';

/**
 * Atomic article-mutation + review-row write for the auto-approve path.
 *
 * Two modes:
 *   - `create`           — submission path. No prior review row exists; we
 *                          insert one directly with status=Actioned.
 *   - `resolve-existing` — scan-completion retry path. A Pending review row
 *                          exists; we promote it to Actioned with the same
 *                          status-guard pattern as `resolveArticleRatingReview`.
 *
 * Post-commit (notification + search-index) is best-effort: failures are
 * logged but do not roll back the resolution.
 */
export type AutoResolvedReview = {
  id: number;
  articleId: number;
  userId: number;
  currentLevel: number;
  suggestedLevel: number;
  appliedLevel: number | null;
  userComment: string | null;
  modComment: string | null;
  status: ReportStatus;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedBy: number | null;
};

export async function autoResolveArticleRatingReview(args: AutoResolveArgs): Promise<{
  reviewId: number;
  appliedLevel: number;
  review: AutoResolvedReview;
}> {
  const systemUserId = constants.system.user.id;

  const result = await dbWrite.$transaction(async (tx) => {
    let reviewId: number;

    if (args.mode === 'create') {
      const created = await tx.articleRatingReview.create({
        data: {
          articleId: args.articleId,
          userId: args.ownerUserId,
          currentLevel: args.previousLevel,
          suggestedLevel: args.suggestedLevel,
          userComment: args.userComment,
          status: ReportStatus.Actioned,
          appliedLevel: args.suggestedLevel,
          resolvedAt: new Date(),
          resolvedBy: systemUserId,
          modComment: AUTO_APPROVE_MOD_COMMENT,
        },
        select: { id: true },
      });
      reviewId = created.id;
    } else {
      // resolve-existing: status-guarded updateMany to handle races with a
      // concurrent mod resolution or a duplicate scan-completion fire.
      const claim = await tx.articleRatingReview.updateMany({
        where: { id: args.reviewId, status: ReportStatus.Pending },
        data: {
          status: ReportStatus.Actioned,
          appliedLevel: args.suggestedLevel,
          resolvedAt: new Date(),
          resolvedBy: systemUserId,
          modComment: AUTO_APPROVE_MOD_COMMENT,
        },
      });
      if (claim.count !== 1) {
        // Lost the race — another path resolved this review first. Bail out
        // without mutating the article so the winning resolution stands.
        throw new AutoResolveRaceLost();
      }
      reviewId = args.reviewId;
    }

    // Clear override, unlock userNsfwLevel, and pin userNsfwLevel to the
    // suggested level so the post-update recompute lands on `suggestedLevel`
    // (gate #5 guaranteed derived <= suggestedLevel before we got here).
    const current = await tx.article.findUnique({
      where: { id: args.articleId },
      select: { lockedProperties: true },
    });
    const lockedSet = new Set<string>(current?.lockedProperties ?? []);
    lockedSet.delete('userNsfwLevel');

    await tx.article.update({
      where: { id: args.articleId },
      data: {
        moderatorNsfwLevel: null,
        // Override is gone → its basis snapshot is meaningless. Clear it so a
        // future override starts from a fresh snapshot and the gate doesn't read
        // a stale basis against a null override.
        moderatorNsfwLevelBasis: null,
        userNsfwLevel: args.suggestedLevel,
        lockedProperties: Array.from(lockedSet),
      },
    });

    // Recompute the effective level. With override now null, the formula
    // resolves to GREATEST(userNsfwLevel=suggested, derived, floor). Gate #5
    // ensured derived <= suggested, so effective settles at `suggestedLevel`.
    await updateArticleNsfwLevels([args.articleId], tx);

    const review = await tx.articleRatingReview.findUniqueOrThrow({
      where: { id: reviewId },
      select: {
        id: true,
        articleId: true,
        userId: true,
        currentLevel: true,
        suggestedLevel: true,
        appliedLevel: true,
        userComment: true,
        modComment: true,
        status: true,
        createdAt: true,
        resolvedAt: true,
        resolvedBy: true,
      },
    });

    return { reviewId, review };
  });

  // Post-commit (best-effort).
  await articlesSearchIndex
    .queueUpdate([{ id: args.articleId, action: SearchIndexUpdateQueueAction.Update }])
    .catch((e) =>
      handleLogError(e, 'article-rating-review-auto-search-index', {
        articleId: args.articleId,
        reviewId: result.reviewId,
      })
    );

  const previousLevelLabel = getBrowsingLevelLabel(args.previousLevel);
  const newLevelLabel = getBrowsingLevelLabel(args.suggestedLevel);

  await createNotification({
    userId: args.ownerUserId,
    type: 'article-rating-review-approved',
    category: NotificationCategory.System,
    key: `article-rating-review-approved:${result.reviewId}`,
    details: {
      articleId: args.articleId,
      articleTitle: args.articleTitle,
      previousLevel: previousLevelLabel,
      newLevel: newLevelLabel,
      // Intentionally null — owner doesn't need to know it was automated.
      modComment: null,
    },
  }).catch((e) =>
    handleLogError(e, 'article-rating-review-auto-approved-notification', {
      articleId: args.articleId,
      reviewId: result.reviewId,
    })
  );

  return {
    reviewId: result.reviewId,
    appliedLevel: args.suggestedLevel,
    review: result.review,
  };
}

/**
 * Sentinel error used by the resolve-existing path to signal "another resolver
 * won the race". Caller can detect this and silently skip its post-commit
 * side effects without polluting logs.
 */
export class AutoResolveRaceLost extends Error {
  constructor() {
    super('Auto-resolve race lost — review was already resolved');
    this.name = 'AutoResolveRaceLost';
  }
}

/**
 * Called from `dispatchArticleIngestionPostCommit` when an article's
 * ingestion has just settled. If a Pending dispute exists and the gate
 * passes, auto-resolve it. Non-throwing — wraps its own failures.
 */
export async function maybeAutoResolveDisputeAfterScan(articleId: number): Promise<void> {
  try {
    const pending = await dbRead.articleRatingReview.findFirst({
      where: { articleId, status: ReportStatus.Pending },
      select: {
        id: true,
        suggestedLevel: true,
        userId: true,
        currentLevel: true,
      },
    });
    if (!pending) return;

    const article = await dbRead.article.findUnique({
      where: { id: articleId },
      select: {
        id: true,
        title: true,
        status: true,
        ingestion: true,
        nsfwLevel: true,
        moderatorNsfwLevel: true,
        moderatorNsfwLevelBasis: true,
        coverId: true,
      },
    });
    if (!article) return;

    const gate = await evaluateAutoApproveGate({
      article: {
        id: article.id,
        status: article.status,
        ingestion: article.ingestion,
        nsfwLevel: article.nsfwLevel,
        moderatorNsfwLevel: article.moderatorNsfwLevel,
        moderatorNsfwLevelBasis: article.moderatorNsfwLevelBasis,
        coverId: article.coverId,
      },
      suggestedLevel: pending.suggestedLevel,
    });
    if (!gate.eligible) return;

    try {
      await autoResolveArticleRatingReview({
        mode: 'resolve-existing',
        reviewId: pending.id,
        articleId,
        ownerUserId: pending.userId,
        suggestedLevel: pending.suggestedLevel,
        previousLevel: pending.currentLevel,
        articleTitle: article.title ?? 'your article',
      });

      logToAxiom({
        type: 'info',
        name: 'article-rating-review-auto-resolved',
        articleId,
        reviewId: pending.id,
        suggestedLevel: pending.suggestedLevel,
        derivedLevel: gate.derivedLevel,
        entryPoint: 'scan-completion' as AutoApproveEntryPoint,
      }).catch();
    } catch (e) {
      if (e instanceof AutoResolveRaceLost) return;
      throw e;
    }
  } catch (e) {
    const error = e as Error;
    handleLogError(error, 'article-rating-review-auto-resolve-after-scan', { articleId });
  }
}
