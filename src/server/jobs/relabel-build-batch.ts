import type { RelabelBuildBatchInput } from '@civitai/moderation';
import { logToAxiom } from '~/server/logging/client';
import { moderatorApp } from '~/server/services/moderator-app.service';
import { createJob } from './job';

/** Per-stratum caps on one day's batch. */
export const RELABEL_DAILY_CAPS = { removed: 100, notRemoved: 40 };

/**
 * How far back removed items are drawn. Overlapping daily windows give an image several chances to be
 * sampled before its purge, and the set never holds an image twice.
 */
export const RELABEL_WINDOW_DAYS = 5;

/** The UTC day names the batch, so a second run that day only fills what the first left short. */
export const relabelBatchName = (now: Date) => now.toISOString().slice(0, 10);

export async function runRelabelBuildBatch({
  now,
  send,
  log,
}: {
  now: Date;
  send: (input: RelabelBuildBatchInput) => Promise<unknown>;
  log: (data: Record<string, unknown>) => void;
}) {
  const batch = relabelBatchName(now);
  const result = await send({
    batch,
    ...RELABEL_DAILY_CAPS,
    days: RELABEL_WINDOW_DAYS,
    dryRun: false,
  });
  log({ batch, result });
  return { batch, result };
}

/**
 * Builds the day's removal-label relabel batch on the moderator spoke (`relabel-build-batch`
 * mod-action), which owns the tables and holds the ClickHouse and replica reads.
 *
 * 🔴 DAILY IS A REQUIREMENT, NOT A PREFERENCE. Removed images are hard-deleted 7 days after the
 * block, and labels must land before that. A skipped day loses the removals that age out of the
 * window, which nothing re-samples.
 */
export const relabelBuildBatchJob = createJob(
  'relabel-build-batch',
  '17 13 * * *',
  async () =>
    runRelabelBuildBatch({
      now: new Date(),
      send: (input) => moderatorApp.relabelBuildBatch(input),
      log: (data) =>
        void logToAxiom({ type: 'info', name: 'relabel-build-batch', ...data }, 'moderation').catch(
          () => undefined
        ),
    }),
  { lockExpiration: 10 * 60 }
);
