import * as z from 'zod';
import { ImageSort } from '~/server/common/enums';
import { MediaType, MetricTimeframe, UserHubSourceType } from '~/shared/utils/prisma/enums';

export const hubLimits = {
  hubsPerUser: 20,
  sourcesPerHub: 50,
  nameLength: 60,
  aliasLength: 60,
} as const;

// `collectionIds` is declared on the metrics-images index but is NOT yet a live
// filterable attribute: onIndexSetup only runs inside the index RESET job
// (base.search-index.ts:358 — the call in the incremental path is commented out
// at :414), and that job is pinned to UNRUNNABLE_JOB_CRON. Until someone runs a
// reset, filtering on it makes Meilisearch reject the whole query, which surfaces
// as a 503 rather than a degraded feed.
//
// So collection sources stay dark until the index has actually been rebuilt.
// Flip this to true in the same change that confirms the attribute is live.
export const HUB_COLLECTION_SOURCES_ENABLED = false;

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
