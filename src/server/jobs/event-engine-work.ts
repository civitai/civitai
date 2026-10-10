import { eventEngine } from '~/server/events';
import { syncEventHats } from '~/server/events/points/sync';
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

export const eventEngineLeaderboardUpdate = createJob(
  'event-engine-leaderboard-update',
  '0 * * * *',
  async () => {
    await eventEngine.updateLeaderboard();
  },
  // Outlasts both referee queries (REFEREE_QUERY_MAX_SECONDS each), and stays held when the
  // scheduler hangs up, so its retry cannot start a second run beside a long one.
  { lockExpiration: 15 * 60, keepLockOnDisconnect: true }
);

// export const eventEngineApplyDiscordRoles = createJob(
//   'event-engine-apply-discord-roles',
//   '*/5 * * * *',
//   async () => {
//     await eventEngine.processAddRoleQueue();
//   }
// );
