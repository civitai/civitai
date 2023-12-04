import { eventEngine } from '~/server/events';
import { createJob } from '~/server/jobs/job';

export const eventEngineDailyReset = createJob(
  'event-engine-daily-reset',
  '0 0 * * *',
  async () => {
    await eventEngine.dailyReset();
  }
);

export const eventEngineLeaderboardUpdate = createJob(
  'event-engine-leaderboard-update',
  '0 * * * *',
  async () => {
    await eventEngine.updateLeaderboard();
  }
);

export const eventEngineApplyDiscordRoles = createJob(
  'event-engine-apply-discord-roles',
  '*/5 * * * *',
  async () => {
    await eventEngine.processAddRoleQueue();
  }
);
