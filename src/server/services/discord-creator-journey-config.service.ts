import { z } from 'zod';
import { dbRead } from '~/server/db/client';

/**
 * Discord IDs for the Creator Journey roles and channel, read from `KeyValue` so no guild-specific ID
 * lives in the code. The row is written by hand from what the Discord API reports for the guild.
 */
export const CREATOR_JOURNEY_DISCORD_CONFIG_KEY = 'discord:creator-journey';

const snowflake = z.string().regex(/^\d{17,20}$/);

const FIELDS = ['supernovaRoleId', 'legendRoleId', 'legendsChannelId'] as const;
export type CreatorJourneyDiscordConfig = Partial<Record<(typeof FIELDS)[number], string>>;

/**
 * Each field is parsed on its own, so one malformed ID drops only that field. A missing or unreadable
 * row is an empty config: every consumer skips what it has no ID for.
 */
export async function getCreatorJourneyDiscordConfig(): Promise<CreatorJourneyDiscordConfig> {
  const row = await dbRead.keyValue.findUnique({
    where: { key: CREATOR_JOURNEY_DISCORD_CONFIG_KEY },
  });
  const value =
    row?.value && typeof row.value === 'object' ? (row.value as Record<string, unknown>) : {};

  const config: CreatorJourneyDiscordConfig = {};
  for (const field of FIELDS) {
    const parsed = snowflake.safeParse(value[field]);
    if (parsed.success) config[field] = parsed.data;
  }
  return config;
}
