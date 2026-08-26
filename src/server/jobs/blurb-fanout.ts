import { logToAxiom } from '~/server/logging/client';
import { runBlurbFanout } from '~/server/services/blurb-fanout.service';
import { createJob } from './job';

const BATCH_LIMIT = 500;

// Rewrites entities whose stored blurb text is behind the blurb itself, through each entity's
// `apply<Entity>ContentChange` — which owns whatever follow-up that entity needs, so none of it
// is duplicated here.
//
// Every 5 minutes. A blurb edit is not urgent, and a shorter period buys nothing while
// making a large fan-out overlap itself.
export const blurbFanoutJob = createJob(
  'blurb-fanout',
  '*/5 * * * *',
  async () => {
    const counts = await runBlurbFanout({
      limit: BATCH_LIMIT,
      // unsupportedBacklog is a full table scan (see the service) and changes slowly — a
      // misconfigured entityType is a one-time wiring gap, not per-run churn — so twice an
      // hour is enough to catch it without paying the scan every 5 minutes.
      includeUnsupportedBacklog: new Date().getMinutes() % 30 === 0,
    });

    const batchTotal = counts.rewritten + counts.skipped + counts.gone + counts.failed;
    // Batch-capacity signal only: whether this run filled its LIMIT. unsupportedBacklog is
    // a table-wide count with no relation to BATCH_LIMIT, so it must never be summed in here
    // — a batch of 0 real rows behind a 600-row unsupported backlog is not a full batch.
    const saturated = batchTotal >= BATCH_LIMIT;

    // Emitted whenever the batch did something, or the (occasional) backlog check found a
    // number worth reporting. `failed` alone earns `warn` — it's the actionable, per-row
    // signal; unsupportedBacklog does not, since there's nothing to do about it on any
    // single tick and it would otherwise warn every run forever in steady state.
    if (batchTotal > 0 || counts.unsupportedBacklog) {
      await logToAxiom({
        type: 'blurb-fanout',
        name: 'blurb-fanout',
        level: counts.failed > 0 ? 'warn' : 'info',
        message: 'fan-out pass complete',
        ...counts,
        batchLimit: BATCH_LIMIT,
        saturated,
      }).catch(() => undefined);
    }

    return counts;
  },
  // The lock has to outlive a full batch, not just match the cron cadence: at
  // lockExpiration === the cron period, a pass running long self-releases mid-run and
  // the next tick starts a second, unclaimed-row overlap (the selector is a plain
  // SELECT, no row locking). 15 minutes gives a 500-row batch real headroom over the
  // 5-minute cadence instead of the two numbers matching by coincidence.
  { lockExpiration: 15 * 60 }
);
