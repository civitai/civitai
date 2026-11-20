import { Prisma } from '@prisma/client';
import { FEEDBACK_SYNC_HOLD_KEY } from '@civitai/shared/feedback.constants';
import { env } from '~/env/server';
import { dbWrite } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import { recordFeedbackHqSyncEvent } from '~/server/prom/feedback-hq-sync.metrics';
import {
  createHqFeedbackReader,
  runFeedbackHqSyncGuarded,
  type FeedbackSyncRow,
} from '~/server/services/feedback-hq-sync.service';
import { setFeedbackTriage } from '~/server/services/feedback-triage.service';
import { createJob } from './job';

const log = (data: Record<string, unknown>) =>
  void logToAxiom({ name: 'feedback-hq-sync', type: 'info', ...data });

/**
 * The rows the links name, read from the primary: the write that follows is a compare-and-set on
 * the status read here, and a lagging replica would only turn more of them into conflicts.
 */
async function readRows(ids: number[]): Promise<FeedbackSyncRow[]> {
  if (!ids.length) return [];
  return dbWrite.$queryRaw<FeedbackSyncRow[]>(Prisma.sql`
    SELECT f."id", f."area", f."status", f."handledById",
           CASE WHEN jsonb_typeof(f."context"->'hq') = 'object'
             THEN f."context"->'hq'->>'id' END AS "hqTaskId",
           (f."context" ? ${FEEDBACK_SYNC_HOLD_KEY}) AS "held"
    FROM "Feedback" f
    WHERE f."id" = ANY(${ids}::int[])
    ORDER BY f."id"
  `);
}

/**
 * A feedback row's triage status follows the HQ task it was filed under (see
 * `feedback-hq-sync.service.ts` for the mapping and what it never touches). Off unless the
 * `feedback-hq-sync` flag is on AND `HQ_FEEDBACK_SYNC_TOKEN` and `CIVITAI_MODERATION_USER_ID` are
 * set; the writes are attributed to that account.
 *
 * 🔴 THE TOKEN IS BROADER THAN THIS JOB. HQ issues no app- or collection-scoped server credential:
 * a collection's `{app: "feedback"}` grant applies only to an HQ app frame acting for a signed-in
 * member, and the off-ladder scopes (`intake`, `projects`, `agents`, …) each open fixed routes, none
 * of them the data API. So the narrowest token that reads `feedback_items` and `tasks` is a member's
 * ladder `read` token, which also reads recordings and transcripts — set it only on the deployment
 * that runs jobs. A dedicated off-ladder HQ scope for these two reads would be the narrow fix.
 */
export const feedbackHqSyncJob = createJob(
  'feedback-hq-sync',
  '*/15 * * * *',
  async () => {
    const result = await runFeedbackHqSyncGuarded({
      flagOn: () => isFlipt(FLIPT_FEATURE_FLAGS.FEEDBACK_HQ_SYNC),
      token: env.HQ_FEEDBACK_SYNC_TOKEN || undefined,
      actorId: env.CIVITAI_MODERATION_USER_ID || undefined,
      make: (token, actorId) => ({
        ...createHqFeedbackReader({ token }),
        readRows,
        triage: (request) => setFeedbackTriage({ ...request, actorId }),
        actorId,
        count: recordFeedbackHqSyncEvent,
        log,
      }),
      log,
    });
    if (!('skipped' in result)) log({ step: 'run', ...result });
    return result;
  },
  { lockExpiration: 10 * 60 }
);
