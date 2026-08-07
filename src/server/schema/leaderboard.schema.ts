import * as z from 'zod';
import { DomainColor } from '~/shared/utils/prisma/enums';

// Stamped by `applyRequestDomainColor`, never sent by the client. It must live on
// the INPUT rather than be read from ctx.req inside the service: `cacheIt` builds
// its Redis key by hashing the input object only, so a domain resolved off the
// request would leave one cache entry shared across colors and .red would serve
// .com's boards.
const domainColorEnum = z.enum(DomainColor);

export type GetLeaderboardPositionsInput = z.infer<typeof getLeaderboardPositionsSchema>;
export const getLeaderboardPositionsSchema = z.object({
  userId: z.number().optional(), // This is ok, it's used for caching purposes
  date: z.date().optional(),
  top: z.number().optional(),
  isModerator: z.boolean().optional().default(false),
  domain: domainColorEnum.optional(),
});

export type GetLeaderboardInput = z.infer<typeof getLeaderboardSchema>;
export const getLeaderboardSchema = z.object({
  id: z.string(),
  date: z.date().optional(),
  isModerator: z.boolean().optional().default(false),
  maxPosition: z.number().optional().default(1000),
  domain: domainColorEnum.optional(),
});

export type GetLeaderboardsInput = z.infer<typeof getLeaderboardsSchema>;
export const getLeaderboardsSchema = z.object({
  ids: z.array(z.string()).optional(),
  isModerator: z.boolean().optional().default(false),
  domain: domainColorEnum.optional(),
});
export type GetLeaderboardsWithResultsInput = z.infer<typeof getLeaderboardsWithResultsSchema>;

export const getLeaderboardsWithResultsSchema = z.object({
  ids: z.array(z.string()),
  date: z.date().optional(),
  isModerator: z.boolean().optional().default(false),
  domain: domainColorEnum.optional(),
});
