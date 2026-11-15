import { COM_FACE_INTENT_DISPUTE, LOCK_REVIEW_KIND } from '@civitai/shared/lock-review';
import { constants } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  LOCK_REVIEW_LATER_VERDICT,
  resolveLockReviewAppeal,
} from '~/server/services/lock-review.service';
import {
  checkComFaceIntentVerdict,
  getOwnTriggerWords,
} from '~/server/services/model-sfw-face.service';
import type { ModelMeta } from '~/server/schema/model.schema';
import {
  COM_FACE_INTENT_LOCK_SOURCE,
  comFaceIntentTextHash,
} from '~/server/services/model-com-face-intent.service';
import { moderatorRuledNsfwSince } from '~/server/services/rating-review.entities';
import { hasLaterVerdictUnderLock, readSystemNsfwLockAt } from '~/server/utils/minor-flag-meta';

const SYSTEM_USER_ID = constants.system.user.id;
// BATCH_SIZE x the slower pass's wait (up to a minute each) must stay well inside the job's run lock.
const BATCH_SIZE = 4;
/** Runs without a verdict before the dispute is left to a moderator. */
const MAX_ATTEMPTS = 3;

export type ComFaceIntentDisputeOutcome =
  /** The slower pass allowed it: the lock is lifted and the owner told. */
  | 'overturned'
  /** The slower pass still detects intent: left pending for a moderator. */
  | 'upheld'
  /** Allowed, but the approval was refused (a hold, a detection waiting, an owner change). */
  | 'needs-moderator'
  /** No verdict after {@link MAX_ATTEMPTS} runs. */
  | 'unavailable'
  /** Allowed, but a system rating verdict landed under the lock: left for a moderator. */
  | 'later-verdict'
  | 'retry';

type PendingDispute = {
  id: number;
  modelId: number;
  userId: number;
  attempts: number;
  name: string;
  description: string | null;
  ownerId: number;
  meta: unknown;
  lockedProperties: string[];
};

/**
 * Re-judges owners' disputes of a listing intent lock with the slower pass (thinking on). A clear
 * allow approves the lock review as the system, which lifts the lock, overturns the stored verdict
 * and tells the owner. Anything else stays pending in the moderators' lock review queue, marked so
 * the job does not judge it again. Each verdict of the slower pass is logged beside the first, as a
 * sample for tuning the prompt.
 */
export async function processComFaceIntentDisputes() {
  const rows = await dbWrite.$queryRaw<PendingDispute[]>`
    SELECT a.id, a."entityId" AS "modelId", a."userId",
      COALESCE((a.context->>'autoReviewAttempts')::int, 0) AS attempts,
      m.name, m.description, m."userId" AS "ownerId", m.meta,
      COALESCE(m."lockedProperties", ARRAY[]::text[]) AS "lockedProperties"
    FROM "Appeal" a
    JOIN "Model" m ON m.id = a."entityId"
    WHERE a."entityType" = 'Model' AND a.status = 'Pending' AND a.category IS NULL
      AND a.context->>'kind' = ${LOCK_REVIEW_KIND}
      AND a.context->>'dispute' = ${COM_FACE_INTENT_DISPUTE}
      -- Only the nsfw lock: an approval lifts every lock the request names.
      AND a.context->'locks' = '["nsfw"]'::jsonb
      AND NOT (a.context ? 'autoReview')
    ORDER BY a."createdAt"
    LIMIT ${BATCH_SIZE}
  `;
  const counts: Record<ComFaceIntentDisputeOutcome | 'failed', number> = {
    overturned: 0,
    upheld: 0,
    'needs-moderator': 0,
    unavailable: 0,
    'later-verdict': 0,
    retry: 0,
    failed: 0,
  };
  for (const row of rows) {
    try {
      counts[await judgeDispute(row)]++;
    } catch (error) {
      counts.failed++;
      logToAxiom({
        type: 'error',
        name: 'model-com-face-intent-dispute',
        message: error instanceof Error ? error.message : String(error),
        appealId: row.id,
        modelId: row.modelId,
      }).catch(() => undefined);
    }
  }
  return counts;
}

async function judgeDispute(row: PendingDispute): Promise<ComFaceIntentDisputeOutcome> {
  // A transferred model: the review can only be rejected, which is a moderator's call.
  if (row.userId !== row.ownerId) return markJudged(row, 'needs-moderator');

  const triggerWords = await getOwnTriggerWords({
    modelId: row.modelId,
    userId: row.ownerId,
    db: dbWrite,
  });
  const verdict = await checkComFaceIntentVerdict({
    name: row.name,
    description: row.description,
    triggerWords,
    thinking: true,
  });

  if (verdict.status === 'unavailable') {
    if (row.attempts + 1 < MAX_ATTEMPTS) {
      await dbWrite.$executeRaw`
        UPDATE "Appeal"
        SET context = context || jsonb_build_object('autoReviewAttempts', ${row.attempts + 1}::int)
        WHERE id = ${row.id} AND status = 'Pending'
      `;
      return 'retry';
    }
    return markJudged(row, 'unavailable');
  }

  // The detection was read from one text; an allow of other text must not overturn it. A listing
  // edited since goes to a moderator, whose approval overturns only a detection of the text it sees.
  const recorded = (row.meta as ModelMeta | null)?.comFaceIntent?.textHash;
  if (
    verdict.status === 'allowed' &&
    recorded !== comFaceIntentTextHash({ ...row, triggerWords })
  ) {
    logSample(row, 'text-changed', verdict.promptId);
    return markJudged(row, 'needs-moderator');
  }

  if (verdict.status === 'detected') {
    logSample(row, 'upheld', verdict.promptId, verdict.reason);
    return markJudged(row, 'upheld');
  }

  // The tag was stamped at filing: a moderator's ruling on the lock since then makes it theirs.
  if (!(await stillIntentLock(row))) return markJudged(row, 'needs-moderator');
  // A system rating verdict the lock kept from applying would be lost with it: a moderator decides.
  if (hasLaterVerdictUnderLock(row.meta)) return markJudged(row, 'later-verdict');
  const intentLockAt = (row.meta as ModelMeta | null)?.systemNsfwLock?.at;
  if (typeof intentLockAt !== 'string') return markJudged(row, 'needs-moderator');

  try {
    await resolveLockReviewAppeal({
      appealId: row.id,
      modelId: row.modelId,
      approve: true,
      userId: SYSTEM_USER_ID,
      // Both re-read under the row lock: a ruling or a verdict can land during the re-check above.
      asDisputeJob: { intentLockAt },
      internalNotes:
        'Approved automatically: the listing intent check allowed it on a second pass.',
    });
  } catch (error) {
    if (error instanceof Error && error.message === LOCK_REVIEW_LATER_VERDICT)
      return markJudged(row, 'later-verdict');
    logToAxiom({
      type: 'info',
      name: 'model-com-face-intent-dispute',
      message: 'allowed, approval refused; left for a moderator',
      appealId: row.id,
      modelId: row.modelId,
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
    return markJudged(row, 'needs-moderator');
  }
  logSample(row, 'overturned', verdict.promptId);
  return 'overturned';
}

/** The nsfw lock is still the intent check's, with no moderator ruling (a rejection included) since. */
async function stillIntentLock(row: PendingDispute) {
  const marker = (row.meta as ModelMeta | null)?.systemNsfwLock;
  const at = readSystemNsfwLockAt(row.meta);
  if (!row.lockedProperties.includes('nsfw')) return false;
  if (marker?.source !== COM_FACE_INTENT_LOCK_SOURCE || !at) return false;
  return !(await moderatorRuledNsfwSince(row.modelId, at, { alsoRejections: true }));
}

async function markJudged(row: PendingDispute, outcome: ComFaceIntentDisputeOutcome) {
  await dbWrite.$executeRaw`
    UPDATE "Appeal"
    SET context = context || jsonb_build_object('autoReview', ${outcome}::text, 'autoReviewedAt', now())
    WHERE id = ${row.id} AND status = 'Pending'
  `;
  return outcome;
}

/** A prompt-tuning sample: what the face-time pass said, and what the slower pass said of it. */
function logSample(
  row: PendingDispute,
  outcome: 'overturned' | 'upheld' | 'text-changed',
  promptId?: number,
  reason?: string
) {
  const first = (row.meta as ModelMeta | null)?.comFaceIntent;
  logToAxiom({
    type: 'info',
    name: 'model-com-face-intent-dispute',
    message: outcome,
    appealId: row.id,
    modelId: row.modelId,
    firstPromptId: first?.promptId,
    firstReason: first?.reason,
    secondPromptId: promptId,
    secondReason: reason,
  }).catch(() => undefined);
}
