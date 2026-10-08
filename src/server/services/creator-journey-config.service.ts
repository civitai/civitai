import { z } from 'zod';
import { dbRead } from '~/server/db/client';

/**
 * Creator Journey settings that differ per environment: the Discord role and channel IDs for the
 * guild, and who is told when a creator becomes a Legend. Kept in `KeyValue` so no guild-specific
 * ID or staff account lives in the code; the row is written by hand.
 */
export const CREATOR_JOURNEY_CONFIG_KEY = 'creator-journey:config';

const snowflake = z.string().regex(/^\d{17,20}$/);

const fieldSchemas = {
  supernovaRoleId: snowflake,
  legendRoleId: snowflake,
  legendsChannelId: snowflake,
  legendAlertUserIds: z.array(z.number().int().positive()).max(20),
};

export type CreatorJourneyConfig = {
  [K in keyof typeof fieldSchemas]?: z.infer<(typeof fieldSchemas)[K]>;
};

/**
 * Each field is parsed on its own, so one malformed value drops only that field. A missing row is an
 * empty config: every consumer skips what it has no value for.
 */
export async function getCreatorJourneyConfig(): Promise<CreatorJourneyConfig> {
  const row = await dbRead.keyValue.findUnique({ where: { key: CREATOR_JOURNEY_CONFIG_KEY } });
  const value =
    row?.value && typeof row.value === 'object' ? (row.value as Record<string, unknown>) : {};

  const config: Record<string, unknown> = {};
  for (const [field, schema] of Object.entries(fieldSchemas)) {
    const parsed = schema.safeParse(value[field]);
    if (parsed.success) config[field] = parsed.data;
  }
  return config as CreatorJourneyConfig;
}
