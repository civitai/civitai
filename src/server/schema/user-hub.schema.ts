import * as z from 'zod';
import { ImageSort } from '~/server/common/enums';
import { MediaType, MetricTimeframe, UserHubSourceType } from '~/shared/utils/prisma/enums';

export const hubLimits = {
  hubsPerUser: 20,
  sourcesPerHub: 50,
  nameLength: 60,
  aliasLength: 60,
  // Caps the RESOLVED ids, which is a different quantity from the source count:
  // one Model source expands to every version of that model, and each version id
  // is then repeated across three filter arms. Measured on prod, the feed's
  // filter cost is linear at ~0.5ms per id — 3,867 ids (reachable by adding 50
  // high-version models from the UI) took 2.9-5.6s and produced a 502 against the
  // 5s deadline. 800 ids, the realistic "models I actually use" case, is ~830ms.
  resolvedVersionIds: 750,
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
  // A display label, not identity. Model names routinely run past 60 characters,
  // and rejecting the mutation loses the whole source list rather than the tail of
  // one label.
  alias: z
    .string()
    .trim()
    .transform((value) => value.slice(0, hubLimits.aliasLength))
    .nullish(),
  enabled: z.boolean().default(true),
  index: z.number().int().min(0).default(0),
});

export const upsertUserHubSchema = z.object({
  id: z.number().optional(),
  name: z.string().trim().min(1).max(hubLimits.nameLength),
  // Deliberately NOT `.default()`. These are applied to an UPDATE, so a default
  // means "an omitted field is silently overwritten" rather than "left alone" —
  // which reset a user's sort and period every time they toggled a source off.
  // Creation defaults live in the service, where the create branch can be explicit.
  sort: hubSortSchema.optional(),
  period: z.enum(MetricTimeframe).optional(),
  mediaTypes: z.array(z.enum(MediaType)).optional(),
  // Optional, and NOT defaulted: an omitted list means "leave the sources alone".
  // Every caller sending its own cached copy of the full list turned a sort change
  // into a full replacement, so a save issued before another one's invalidate
  // settled reverted it.
  sources: z.array(userHubSourceSchema).max(hubLimits.sourcesPerHub).optional(),
});

export const setUserHubOrderSchema = z.object({
  ids: z.array(z.number()).max(hubLimits.hubsPerUser),
});

export type UpsertUserHubInput = z.infer<typeof upsertUserHubSchema>;
export type UserHubSourceInput = z.infer<typeof userHubSourceSchema>;
export type SetUserHubOrderInput = z.infer<typeof setUserHubOrderSchema>;
