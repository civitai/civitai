import * as z from 'zod';

// getBlocklist + removeItems moved to the spoke (apps/moderator). upsert stays — the sync-email-blocklist
// cron and blocklist.service's upsertBlocklist use it.
export type UpsertBlocklistSchema = z.infer<typeof upsertBlocklistSchema>;
export const upsertBlocklistSchema = z.object({
  id: z.number().optional(),
  type: z.string(),
  blocklist: z.string().array(),
});
