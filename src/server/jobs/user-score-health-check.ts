/**
 * Alerts when the nightly `update-user-score` run has stopped succeeding. It stalled for 39 nights in
 * 2026 with nobody noticing, and score tier badges are granted by that run.
 *
 * Reads one checkpoint per score category plus one for tier grants rather than a single heartbeat,
 * because each can freeze while the rest of the run succeeds, and that partial failure is the one
 * this needs to see.
 */

import { notifyModAlert } from '~/server/common/mod-alert';
import { dbRead } from '~/server/db/client';
import { createJob } from '~/server/jobs/job';
import { userScoreCheckpointKeys } from '~/server/jobs/update-user-score';
import { logToAxiom } from '~/server/logging/client';
import { createLogger } from '~/utils/logging';

const log = createLogger('jobs:user-score-health-check', 'yellow');

// The score job runs at 23:55 and this at 12:00, so a healthy checkpoint is ~12h old and one missed
// night makes it ~36h.
const STALE_AFTER_HOURS = 30;

export async function checkUserScoreHealth(now = new Date()) {
  const rows = await dbRead.keyValue.findMany({
    where: { key: { in: userScoreCheckpointKeys } },
    select: { key: true, value: true },
  });
  const lastSuccessByKey = new Map(rows.map((row) => [row.key, new Date(row.value as number)]));

  const stale = userScoreCheckpointKeys.flatMap((key) => {
    const lastSuccess = lastSuccessByKey.get(key);
    const ageHours = lastSuccess ? (now.getTime() - lastSuccess.getTime()) / 3_600_000 : Infinity;
    return ageHours > STALE_AFTER_HOURS ? [{ key, lastSuccess: lastSuccess ?? null }] : [];
  });

  if (!stale.length) {
    log('user score checkpoints fresh');
    return { healthy: true as const };
  }

  const lines = stale.map(
    ({ key, lastSuccess }) =>
      `\`${key}\` last succeeded ${lastSuccess ? lastSuccess.toISOString() : 'never'}`
  );
  const message =
    `Part of the nightly Creator Score run has not succeeded in over ${STALE_AFTER_HOURS}h. A stale ` +
    `category means those scores are frozen; a stale \`tierGrants\` means tier badges are not being ` +
    `granted. Check \`update-user-score\` (55 23 * * *).\n\n${lines.join('\n')}`;

  await logToAxiom({
    type: 'warning',
    name: 'user-score-health-check',
    details: { stale: stale.map(({ key, lastSuccess }) => ({ key, lastSuccess })) },
    message,
  }).catch(() => null);
  const alert = await notifyModAlert(`🚨 Creator Score job stalled`, message);

  return { healthy: false as const, stale: stale.length, alert };
}

export const userScoreHealthCheckJob = createJob('user-score-health-check', '0 12 * * *', () =>
  checkUserScoreHealth()
);
