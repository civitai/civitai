import * as z from 'zod';
import { ImageSort } from '~/server/common/enums';
import { MediaType, MetricTimeframe, UserHubSourceType } from '~/shared/utils/prisma/enums';

export const hubLimits = {
  hubsPerUser: 20,
  sourcesPerHub: 50,
  nameLength: 60,
  aliasLength: 60,
  descriptionLength: 300,
  filterListLength: 20,
  // Caps the RESOLVED ids, which is a different quantity from the source count:
  // one Model source expands to every version of that model, and each version id
  // is then repeated across three filter arms.
  //
  // The cost is NOT linear per id — measured against the prod metrics index, a
  // full 5-iteration page carrying the cap's 2,250 filter ids costs ~180ms more
  // than a trivial filter, not the ~1.1s a linear model predicts. What justifies
  // the cap is the COLD tail: an uncapped 50-model hub (3,867 ids, 11,601 in the
  // filter, 53KB) measured 2.4s on a first-touch id set, and that is the shape
  // that produced a 502 against the 5s deadline.
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

const capList = <T>(value: T[]) => value.slice(0, hubLimits.filterListLength);

/**
 * The subset of the images-feed filter menu a hub remembers. Named key by key
 * rather than stored as a blob: `hubId` may only be combined with filters the
 * search index can serve (see `requiresImageDbPath`), and the feed input refuses
 * the rest. Anything not listed here is a session-only choice, not a hub setting.
 */

export const hubFeedFiltersSchema = z.object({
  // Truncated, not rejected, like `alias` and `description`: these are parsed in a
  // change handler, and a throw there loses the whole save with nothing shown.
  baseModels: z.array(z.string()).transform(capList).optional(),
  tools: z.array(z.number().int().positive()).transform(capList).optional(),
  techniques: z.array(z.number().int().positive()).transform(capList).optional(),
  withMeta: z.boolean().optional(),
  fromPlatform: z.boolean().optional(),
  remixesOnly: z.boolean().optional(),
  nonRemixesOnly: z.boolean().optional(),
  hideChallenges: z.boolean().optional(),
  // A green-domain content control, not a session state: a hub that cannot carry
  // it is hard-capped to public content with no control anywhere to lift the cap,
  // because the hub feed runs with the global filter store disabled.
  includePG13: z.boolean().optional(),
});

export type HubFeedFilters = z.infer<typeof hubFeedFiltersSchema>;

export const upsertUserHubSchema = z.object({
  id: z.number().optional(),
  // Optional for the same reason as `sources` below: a rename, a sort change and a
  // source toggle are three writers of one row, and any writer that resends its own
  // cached copy of a field it did not change can revert another's edit. Required on
  // CREATE, enforced in the service where the create branch is explicit.
  name: z.string().trim().min(1).max(hubLimits.nameLength).optional(),
  // Stored on `metadata.description`; named here rather than accepting a
  // `metadata` object so the client can never write the rest of it. Truncated,
  // not rejected, for the same reason as `alias`.
  description: z
    .string()
    .trim()
    .transform((value) => value.slice(0, hubLimits.descriptionLength))
    .nullish(),
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
  // Same "omitted means leave alone" rule as `sources`; stored on
  // `metadata.filters`, like `description`.
  filters: hubFeedFiltersSchema.optional(),
});

export const setUserHubOrderSchema = z.object({
  ids: z.array(z.number()).max(hubLimits.hubsPerUser),
});

export type UpsertUserHubInput = z.infer<typeof upsertUserHubSchema>;
export type UserHubSourceInput = z.infer<typeof userHubSourceSchema>;
export type SetUserHubOrderInput = z.infer<typeof setUserHubOrderSchema>;

export const resolveHubSourceSchema = z.object({
  url: z.string().trim().min(1).max(500),
});

export type ResolveHubSourceInput = z.infer<typeof resolveHubSourceSchema>;

// One type per request: each arm is a multi-query fan-out over sets that scale
// with how much the viewer follows, so searching all three per keystroke does not
// pay for itself.
export const hubSuggestionTypeSchema = z.enum([
  UserHubSourceType.User,
  UserHubSourceType.Model,
  UserHubSourceType.Collection,
]);

export const getHubSourceSuggestionsSchema = z.object({
  type: hubSuggestionTypeSchema.default(UserHubSourceType.User),
  query: z.string().trim().max(100).optional(),
});

export type HubSuggestionType = z.infer<typeof hubSuggestionTypeSchema>;

export type GetHubSourceSuggestionsInput = z.infer<typeof getHubSourceSuggestionsSchema>;
