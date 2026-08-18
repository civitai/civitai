import * as z from 'zod';
import { ImageSort } from '~/server/common/enums';
import { MediaType, MetricTimeframe, UserHubSourceType } from '~/shared/utils/prisma/enums';

export const hubLimits = {
  hubsPerUser: 20,
  sourcesPerHub: 50,
  nameLength: 60,
  aliasLength: 60,
} as const;

export const hubSortSchema = z.enum([
  ImageSort.Newest,
  ImageSort.Oldest,
  ImageSort.MostReactions,
  ImageSort.MostComments,
]);

export type HubSort = z.infer<typeof hubSortSchema>;

export const userHubSourceSchema = z.object({
  id: z.number().optional(),
  type: z.enum(UserHubSourceType),
  targetId: z.number().int().positive(),
  alias: z.string().trim().max(hubLimits.aliasLength).nullish(),
  enabled: z.boolean().default(true),
  index: z.number().int().min(0).default(0),
});

export const upsertUserHubSchema = z.object({
  id: z.number().optional(),
  name: z.string().trim().min(1).max(hubLimits.nameLength),
  sort: hubSortSchema.default(ImageSort.Newest),
  period: z.enum(MetricTimeframe).default(MetricTimeframe.AllTime),
  mediaTypes: z.array(z.enum(MediaType)).default([]),
  sources: z.array(userHubSourceSchema).max(hubLimits.sourcesPerHub).default([]),
});

export const setUserHubOrderSchema = z.object({
  ids: z.array(z.number()).max(hubLimits.hubsPerUser),
});

export type UpsertUserHubInput = z.infer<typeof upsertUserHubSchema>;
export type UserHubSourceInput = z.infer<typeof userHubSourceSchema>;
export type SetUserHubOrderInput = z.infer<typeof setUserHubOrderSchema>;
