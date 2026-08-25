import { logToAxiom } from '~/server/logging/client';
import { runBlurbFanout } from '~/server/services/blurb-fanout.service';
import { createJob } from './job';

const BATCH_LIMIT = 500;

// Rewrites entities whose stored blurb text is behind the blurb itself. Each rewrite
// goes through that entity's normal update function, so its existing moderation scan,
// search-index sync and cache invalidation fire without any of it being duplicated here.
//
// Every 5 minutes. A blurb edit is not urgent, and a shorter period buys nothing while
// making a large fan-out overlap itself.
export const blurbFanoutJob = createJob('blurb-fanout', '*/5 * * * *', async () => {
  const counts = await runBlurbFanout({ limit: BATCH_LIMIT });

  // Emitted on every non-empty run, not only on error. There is no cap on how many
  // entities one blurb reaches, so the scale of these runs is the number we do not
  // yet know — and the point of measuring is to find out before it surprises us.
  if (counts.rewritten || counts.gone || counts.unsupported) {
    await logToAxiom({
      type: 'blurb-fanout',
      name: 'blurb-fanout',
      level: counts.unsupported ? 'warn' : 'info',
      message: 'fan-out pass complete',
      ...counts,
      batchLimit: BATCH_LIMIT,
      saturated: counts.rewritten + counts.skipped + counts.gone >= BATCH_LIMIT,
    }).catch(() => undefined);
  }

  return counts;
});
