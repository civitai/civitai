import * as z from 'zod';
import { DomainColor } from '~/shared/utils/prisma/enums';

// Stamped by `applyRequestBoardDomainColor`, never sent by the client. It has to reach
// `cacheIt`'s key: a domain read off ctx.req inside the service would leave one
// cache entry shared across colors, and .red would serve .com's boards. Carrying
// it on the input is one way; `cacheIt`'s `varyBy` is the other.
const domainColorEnum = z.enum(DomainColor);

// `isModerator` is resolved from ctx by the router and is deliberately absent from
// these two wire schemas: a client value would be overwritten anyway, and leaving
// it in the input puts it in `cacheIt`'s key as the constant the schema defaults
// it to. The procedures declare it through `varyBy` instead.
export type GetLeaderboardPositionsInput = z.infer<typeof getLeaderboardPositionsSchema> & {
  isModerator?: boolean;
};
export const getLeaderboardPositionsSchema = z.object({
  userId: z.number().optional(), // This is ok, it's used for caching purposes
  date: z.date().optional(),
  top: z.number().optional(),
  domain: domainColorEnum.optional(),
});

export type GetLeaderboardInput = z.infer<typeof getLeaderboardSchema> & {
  isModerator?: boolean;
};
export const getLeaderboardSchema = z.object({
  id: z.string(),
  date: z.date().optional(),
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
