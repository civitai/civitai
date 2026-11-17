import { eventEngine } from '~/server/events';
import { SETTLE_LOCK_S } from '~/server/events/points/referee';
import { reconcileEventRosters } from '~/server/events/points/roster-sync';
import { syncEventHats } from '~/server/events/points/sync';
import { reconcileAllTurf } from '~/server/events/turf/turf.service';
import { createJob } from '~/server/jobs/job';

export const eventEngineDailyReset = createJob(
  'event-engine-daily-reset',
  '0 0 * * *',
  async () => {
    await eventEngine.dailyReset();
  }
);

// The safety net under the hat write-through: repairs and logs any hat the equip path missed. Named
// apart from the old every-minute sync because the scheduler keeps an existing name's cron.
export const eventPointsHatReconcile = createJob(
  'event-points-hat-reconcile',
  '0 * * * *',
  async () => {
    await syncEventHats();
  }
);

// The safety net under the roster write-through (events/points/roster-sync.ts): re-derives every
// listed member, so points the referee re-based on the hour, a missed hat and a missed ban come
// right. A quarter past, after the referee's hourly run has settled.
export const eventRosterReconcile = createJob('event-roster-reconcile', '15 * * * *', async () => {
  await reconcileEventRosters();
});

// The safety net under the turf write-through (events/turf): hides, bans, opt-outs, the credited
// cap stepping up, and anything a placement's sync missed.
export const eventTurfReconcile = createJob('event-turf-reconcile', '*/5 * * * *', async () => {
  await reconcileAllTurf();
});

export const eventEngineLeaderboardUpdate = createJob(
  'event-engine-leaderboard-update',
  '0 * * * *',
  async () => {
    await eventEngine.updateLeaderboard();
  },
  // Outlasts a settle (REFEREE_CLICKHOUSE_BUDGET_S), and stays held when the
  // scheduler hangs up, so its retry cannot start a second run beside a long one.
  { lockExpiration: SETTLE_LOCK_S, keepLockOnDisconnect: true }
);

// export const eventEngineApplyDiscordRoles = createJob(
//   'event-engine-apply-discord-roles',
//   '*/5 * * * *',
//   async () => {
//     await eventEngine.processAddRoleQueue();
//   }
// );
