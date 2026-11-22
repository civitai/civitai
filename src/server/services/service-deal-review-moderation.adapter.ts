import { NsfwLevel } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { syncReviewPublication } from '~/server/services/creator-service-deal-review-publish';
import { logToAxiom } from '~/server/logging/client';
import type { ModerationAdapter } from '~/server/services/entity-moderation.service';
import { withCsamHold } from '~/server/services/text-scan/actions/csam-hold';
import type { ApplyTextScanArgs } from '~/server/services/text-scan/actions/types';
import {
  settleSkippedScan,
  type SkipReason,
} from '~/server/services/text-scan/actions/settle-skipped';
import { csamHoldBars } from '~/server/services/text-scan/csam-hold-bars';
import {
  csamHoldState,
  csamQueueClearSql,
  readCsamHolds,
} from '~/server/services/text-scan/csam-hold-state';
import {
  loadServiceDealReviewSubjects,
  SERVICE_DEAL_REVIEW_TEXTS,
  type ServiceDealReviewTextType,
} from '~/server/services/text-scan/profiles/service-deal-review.profile';
import { spendTextScanRetry } from '~/server/services/text-scan/adapter';
import { unansweredTextScanLabels } from '~/server/services/text-scan/profiles';
import { submitTextModerationOrScan } from '~/server/services/text-scan/route';
import type { TextScanOutput } from '~/server/services/text-scan/types';
import { EntityModerationStatus } from '~/shared/utils/prisma/enums';

type TextType = ServiceDealReviewTextType;
/**
 * A result applies only to the text it was for: `workflowId` is the check that produced it, `text`
 * the text a result reached without one (a stored verdict for unchanged text) was about.
 */
type CurrentText = { workflowId?: string; text?: string };

type Verdict = {
  level: number;
  blocked?: boolean;
  /** The check's own csam verdict, when it has one to give. */
  csam?: Parameters<typeof csamHoldBars>[0];
};

const loadSubject = async (type: TextType, reviewId: number) =>
  (await loadServiceDealReviewSubjects(type, [reviewId])).get(reviewId);

/**
 * Pending or Error to Scanned, or to Blocked when the check blocked it or read it above the deal's
 * level: nothing raises a deal's or an offering's level, so text above it is never shown.
 */
async function settleReviewText(
  type: TextType,
  reviewId: number,
  { workflowId, text }: CurrentText,
  { level, blocked = false }: Pick<Verdict, 'level' | 'blocked'>
) {
  const cols = SERVICE_DEAL_REVIEW_TEXTS[type];
  await dbWrite.$executeRaw`
    UPDATE "ServiceDealReview" r
    SET ${cols.status} = (CASE WHEN ${blocked} OR ${level}::int > d."maxNsfwLevel"
      THEN 'Blocked' ELSE 'Scanned' END)::"ServiceOfferingIngestionStatus"
    FROM "ServiceDeal" d
    WHERE r."id" = ${reviewId}::int AND d."id" = r."dealId"
      AND r.${cols.status} IN ('Pending', 'Error')
      AND (${workflowId ?? null}::text IS NULL OR r.${cols.workflow} = ${workflowId ?? null}::text)
      AND (${text ?? null}::text IS NULL OR r.${cols.text} = ${text ?? null}::text)`;
  if (type === 'ServiceDealReview') await syncReviewPublication(reviewId);
}

/**
 * Text whose verdict cannot settle it stays unshown and is left for the reconcile in the deals job
 * to send again: Pending, with no check recorded.
 */
async function resendReviewText(
  type: TextType,
  reviewId: number,
  { workflowId, text }: CurrentText
) {
  const cols = SERVICE_DEAL_REVIEW_TEXTS[type];
  await dbWrite.$executeRaw`
    UPDATE "ServiceDealReview" r
    SET ${cols.status} = 'Pending', ${cols.workflow} = NULL
    WHERE r."id" = ${reviewId}::int AND r.${cols.status} IN ('Pending', 'Error')
      AND (${workflowId ?? null}::text IS NULL OR r.${cols.workflow} = ${workflowId ?? null}::text)
      AND (${text ?? null}::text IS NULL OR r.${cols.text} = ${text ?? null}::text)`;
}

/** Settles a check, blocked instead while the csam queue holds the text. */
async function settleUnlessHeld(
  type: TextType,
  reviewId: number,
  current: CurrentText,
  { csam = null, ...verdict }: Verdict
) {
  const held = csamHoldBars(csam, await readCsamHolds(type, reviewId));
  await settleReviewText(type, reviewId, current, { ...verdict, blocked: verdict.blocked || held });
}

/** Applies a stored verdict for unchanged text; text whose stored verdict is not about it stays unshown. */
async function settleStored(type: TextType, reviewId: number, text: string, level: number) {
  const state = await csamHoldState(type, reviewId, (id) => loadSubject(type, id));
  if (state === 'unverified') return;
  await settleReviewText(type, reviewId, { text }, { level, blocked: state === 'held' });
}

const settleSkipped = (type: TextType, reviewId: number, reason: SkipReason, text: string) =>
  // A hidden review is never shown, so its skipped scan has nothing to settle.
  reason === 'not-public'
    ? Promise.resolve()
    : reason === 'incomplete'
    ? Promise.all([
        resendReviewText(type, reviewId, { text }),
        spendTextScanRetry(type, reviewId),
      ]).then(() => undefined)
    : settleSkippedScan(
        type,
        reviewId,
        reason,
        (level, { stored }) =>
          stored
            ? settleStored(type, reviewId, text, level)
            : settleUnlessHeld(type, reviewId, { text }, { level }),
        { reviewId }
      );

/**
 * Review text is checked only by the text scan, which asks for csam; the fallback check does not.
 * While the text scan is off for reviews the fallback is declined, so no check is recorded and the
 * text stays unshown: turning the text scan on for reviews is a launch gate.
 */
const declineFallback = async () => ({ id: null });

/**
 * Records the check submitted for the text as it was read, unless the text changed since. A result
 * that landed before the check was recorded was matched to nothing, so it is applied here.
 */
async function trackSubmit(
  type: TextType,
  reviewId: number,
  text: string,
  submit: () => Promise<{ id?: string | null } | null | undefined>
) {
  const workflow = await submit();
  const workflowId = workflow?.id;
  if (!workflowId) return workflow;
  const cols = SERVICE_DEAL_REVIEW_TEXTS[type];
  const recorded = await dbWrite.$executeRaw`
    UPDATE "ServiceDealReview" SET ${cols.workflow} = ${workflowId}
    WHERE "id" = ${reviewId}::int AND ${cols.text} = ${text}
      AND ${cols.status} IN ('Pending', 'Error')`;
  if (!recorded) return workflow;
  // primary: a result written moments ago, before the check was recorded.
  const early = await dbWrite.entityModeration.findFirst({
    where: {
      entityType: type,
      entityId: reviewId,
      workflowId,
      status: EntityModerationStatus.Succeeded,
    },
    select: { blocked: true, nsfwLevel: true, triggeredLabels: true, result: true },
  });
  if (!early || (!early.blocked && early.nsfwLevel === null)) return workflow;
  const answers = (early.result as { labels?: TextScanOutput } | null)?.labels;
  if (!early.blocked && unansweredTextScanLabels(type, answers).length)
    await resendReviewText(type, reviewId, { workflowId });
  else
    await settleUnlessHeld(
      type,
      reviewId,
      { workflowId },
      { blocked: !!early.blocked, level: early.nsfwLevel ?? NsfwLevel.PG, csam: early }
    );
  return workflow;
}

/**
 * Queues a review's text (the buyer's comment or the seller's reply) for the content check; the
 * adapters below apply the result. Every writer of either text resets its status to Pending first.
 */
export async function scanServiceDealReviewText(
  type: TextType,
  reviewId: number,
  submitCheck = submitTextModerationOrScan
) {
  // The primary: called right after a write, and a lagging replica would scan the old text.
  const text = (await loadSubject(type, reviewId))?.fields[0]?.text;
  if (!text) return;
  try {
    await trackSubmit(type, reviewId, text, () =>
      submitCheck({
        entityType: type,
        entityId: reviewId,
        onActiveSkip: (reason) => settleSkipped(type, reviewId, reason, text),
        xguard: declineFallback,
      })
    );
  } catch (e) {
    // The text stays Pending, so unshown; saving must not fail on this.
    logToAxiom({
      type: 'error',
      name: 'service-deal-review-scan',
      message: e instanceof Error ? e.message : String(e),
      reviewId,
      entityType: type,
    });
  }
}

/** A csam hold's removal: the text is kept for the record and never shown. */
export async function blockServiceDealReviewText(type: TextType, reviewId: number) {
  const cols = SERVICE_DEAL_REVIEW_TEXTS[type];
  await dbWrite.$executeRaw`
    UPDATE "ServiceDealReview" SET ${cols.status} = 'Blocked'
    WHERE "id" = ${reviewId}::int AND ${cols.text} IS NOT NULL`;
  if (type === 'ServiceDealReview') await syncReviewPublication(reviewId);
}

/**
 * A dismissed csam hold sends the blocked text back to its check, unless the csam queue still holds
 * it; the reconcile in the deals job rechecks it. Text blocked for its level is blocked again by the
 * stored verdict.
 */
export async function requeueBlockedServiceDealReviewText(type: TextType, reviewId: number) {
  const cols = SERVICE_DEAL_REVIEW_TEXTS[type];
  await dbWrite.$executeRaw`
    UPDATE "ServiceDealReview" SET ${cols.status} = 'Pending', ${cols.workflow} = NULL
    WHERE "id" = ${reviewId}::int AND ${cols.status} = 'Blocked'
      AND ${csamQueueClearSql(type, reviewId)}`;
}

const createReviewTextAdapter = (type: TextType): ModerationAdapter => ({
  resolveContent: async (ids) => {
    const subjects = await loadServiceDealReviewSubjects(type, ids);
    return new Map([...subjects].map(([id, s]) => [id, s.fields[0]?.text ?? '']));
  },

  // Only the retry cron calls submit.
  submit: ({ entityId, content }) =>
    trackSubmit(type, entityId, content, () =>
      submitTextModerationOrScan({
        entityType: type,
        entityId,
        fromRetry: true,
        onActiveSkip: (reason) => settleSkipped(type, entityId, reason, content),
        xguard: declineFallback,
      })
    ),

  // Only a fallback check submitted before the decline can land here: it may block, never show.
  applyResult: async ({ entityId, workflowId, blocked }) => {
    if (blocked)
      await settleReviewText(
        type,
        entityId,
        { workflowId },
        { level: NsfwLevel.PG, blocked: true }
      );
  },

  // A failed check leaves the text unshown; scoped to its own check, so a stale failure for
  // replaced text changes nothing.
  applyFailure: async ({ entityId, workflowId }) => {
    const cols = SERVICE_DEAL_REVIEW_TEXTS[type];
    await dbWrite.$executeRaw`
      UPDATE "ServiceDealReview" SET ${cols.status} = 'Error'
      WHERE "id" = ${entityId}::int AND ${cols.status} = 'Pending'
        AND ${cols.workflow} = ${workflowId}`;
  },

  applyTextScan: (args) => withCsamHold(type, applyVerdict(type))(args),
});

const applyVerdict =
  (type: TextType) =>
  async ({ entityId, workflowId, outcome, textHash }: ApplyTextScanArgs) => {
    const unanswered = unansweredTextScanLabels(type, outcome);
    if (unanswered.length || !outcome.nsfw) {
      logToAxiom({
        type: 'error',
        name: 'service-deal-review-scan',
        message: 'verdict does not answer every label; text left unshown and sent again',
        reviewId: entityId,
        entityType: type,
        workflowId,
        payload: { labels: unanswered },
      });
      await resendReviewText(type, entityId, { workflowId });
      return;
    }
    await settleUnlessHeld(
      type,
      entityId,
      { workflowId },
      {
        level: outcome.nsfw.detectedLevel,
        csam: { triggeredLabels: outcome.csam?.detected ? ['csam'] : [], result: { textHash } },
      }
    );
  };

export const serviceDealReviewModerationAdapter = createReviewTextAdapter('ServiceDealReview');
export const serviceDealReviewReplyModerationAdapter =
  createReviewTextAdapter('ServiceDealReviewReply');
