import { logToAxiom } from '~/server/logging/client';
import { createJob } from './job';

/**
 * APP ASSISTANT SESSION TRACING — the retry of unfinished trace deletions, hourly
 * (`sweepDeletedAccountTraces` in `services/app-assistant/submission-trace.service.ts`). Account
 * deletion's `delete-app-assistant-traces` step deletes an account's frozen chat transcripts first
 * and its trace rows last, keeping the rows when the store refused a delete; those rows are the
 * durable record of an unfinished deletion, and this finishes it.
 *
 * Deliberately NOT gated on the `app-assistant-tracing` flag: it only finishes deletions of deleted
 * accounts, which must happen whether or not tracing is still on. While the trace table is not
 * applied there is nothing to do. Any other error fails the run: the job runner counts and logs
 * it, and the next run retries.
 */
export const sweepAppAssistantTracesJob = createJob(
  'sweep-app-assistant-traces',
  '41 * * * *',
  async () => {
    const [{ sweepDeletedAccountTraces, liveTraceSweepDeps }, { isMissingTableError }] =
      await Promise.all([
        import('~/server/services/app-assistant/submission-trace.service'),
        import('~/server/services/blocks/app-access.service'),
      ]);
    const summary = await sweepDeletedAccountTraces(
      await liveTraceSweepDeps({ isMissingTable: isMissingTableError })
    );
    logToAxiom({ name: 'sweep-app-assistant-traces', type: 'info', ...summary }, 'webhooks');
    return summary;
  },
  { lockExpiration: 30 * 60 }
);
