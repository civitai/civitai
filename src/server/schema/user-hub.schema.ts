import * as z from 'zod';
import { ImageSort } from '~/server/common/enums';
import {
  Availability,
  MediaType,
  MetricTimeframe,
  TagType,
  UserHubSourceType,
} from '~/shared/utils/prisma/enums';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

export const hubLimits = {
  hubsPerUser: 20,
  // Bounds the followed-hubs read as well as the write: the sidebar renders the
  // whole list, and the follow button decides its own state from it.
  followedHubs: 50,
  sourcesPerHub: 50,
  // Counted separately from `sourcesPerHub`, not out of it: a hub that refuses 20
  // creators has not spent any of the budget it collects with, and sharing one cap
  // would let the exclusion list starve the thing the hub is for.
  //
  exclusionsPerHub: 20,
  // What the excluded Model sources of one hub may expand to, checked when a source
  // is ADDED rather than when the feed is read. The exclusion expansion deliberately
  // does not truncate — a trimmed exclusion serves back content the owner said to
  // keep out — so the bound has to sit somewhere a user can be told about it.
  //
  // 🔴 `exclusionsPerHub` alone does NOT bound it. It caps sources; the expansion
  // factor is whatever `ModelVersion` happens to hold, which drifts with the data and
  // reports nothing. Measured on the prod replica 2026-09-04: 942,348 models /
  // 1,219,642 versions, p99 of 5, max 180, and the 20 DISTINCT largest models sum to
  // 2,064 — which, across the three attribution arms the filter needs, is 6,192 ids
  // and ~45KB, against 2,250 / ~18KB on the positive side. That shape measured 5.7s
  // cold, past the 5s deadline. Matched to `resolvedVersionIds` so neither side can
  // put more into the filter than the other.
  excludedVersionIds: 750,
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

/**
 * The tag vocabulary a hub may be keyed on. One constant because the picker QUERIES
 * with it and the server ASSERTS with it, and a picker offering something the server
 * 404s is the shape this is here to stop.
 *
 * Moderation tags are IN, both directions — Justin's call, 2026-09-17, reversing his
 * 2026-09-04 call that kept them out.
 *
 * That call gave two reasons, and only the first is wrong. It said the browsing level
 * already enforces this: it does not, because the level is a coarse nsfwLevel bitmask
 * ANDed across the whole feed, so it cannot express "keep this band but drop images
 * tagged sexy" — a per-tag exclude, and the one thing a hub had no way to say.
 *
 * The second reason still stands and was overridden rather than refuted: a tag exclude
 * IS weaker than the browsing level. It filters on labels a scanner wrote, so an
 * untagged image of the same kind still arrives, where the level is an enforced cap.
 * The call is that a cap the user cannot aim is worse than a filter they can — not
 * that the filter is equivalent. Anyone arguing this back is arguing that trade, and
 * should say why it fell the other way, rather than re-deriving that the exclude is
 * best-effort. It is, and that was known.
 *
 * System stays out, and not as a judgement: both System image tags are `unlisted`, and
 * `getTags`/`hubTagWhere` drop unlisted rows separately, so listing the type would
 * offer 0 of 2 tags. Moderation is 51 of 53 by that same count — the two it leaves out
 * (`self injury`, `extremist`) are `unlisted` too, not a carve-out. Prod, 2026-09-17.
 *
 * The picker and the write path now read this through ONE `hubTagWhere`, so the
 * vocabulary cannot be offered and refused by two different rules. It used to be two:
 * the client picker called `getTags` while the server used a `where` fragment; keep it
 * one by not reintroducing a client-side copy.
 *
 * Eligibility follows ACTUAL image usage, not `Tag.target`. The image tagger applies
 * many tags whose `target` never gains Image (it keeps reading {Model,Post}), yet each
 * is carried by real images and returns real hub results — so gating on `target` hid
 * them. `hubTagWhere` reads AllTime `TagMetric.imageCount` instead — the same number the
 * picker ranks by, so a tag that would collect nothing is also the one left out. `types`
 * still bounds which kinds of tag qualify.
 *
 * The trade this makes explicit: `imageCount` is a periodically-recomputed aggregate,
 * not tag state, so a tag whose AllTime metric row has not caught up is refused until
 * the metric job runs — where `target` admitted a used tag the moment it was applied.
 * Accepted: a tag with no counted images returns an empty hub anyway.
 *
 * See `hub-moderation-tag-vocabulary.test.ts` before narrowing any of this.
 */
export const HUB_TAG_SOURCE_FILTER = {
  types: [TagType.UserGenerated, TagType.Label, TagType.Moderation],
} as const;

// The hub's public identifier, as it appears in the URL. A string, because the route
// carries the ENCODED id — an int here would be the pre-encoding format and would put
// enumeration straight back.
export const getUserHubByKeySchema = z.object({ key: z.string().trim().min(1).max(64) });
export type GetUserHubByKeyInput = z.infer<typeof getUserHubByKeySchema>;

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
  // A negative source. Defaulted rather than optional because this list REPLACES the
  // stored one: an undefined here would write `false` through Prisma's own default
  // anyway, and spelling it makes the round trip visible.
  exclude: z.boolean().default(false),
  index: z.number().int().min(0).default(0),
  // A tag AND-set. Tag sources of one hub sharing a key, on the same side of
  // `exclude`, must ALL match; null is a group of one. Assigned client-side by
  // position, like `index`, which is safe because a save REPLACES the hub's whole
  // source list — there is no stored key to collide with.
  //
  // Only Tag sources are grouped. It is nullable rather than validated per type
  // because the resolver groups within the tag rows alone, so a key on any other
  // type is inert rather than wrong.
  //
  // Bounded, not merely non-negative: the column is a Postgres `INTEGER`, and an
  // unbounded value passes zod and then fails inside the replace transaction as a
  // raw DB error rather than a validation message. The ceiling is the most rows a
  // hub can hold, which is the most distinct keys it can ever need —
  // `nextHubGroupKey` hands out the lowest free one for that reason.
  groupKey: z
    .number()
    .int()
    .min(0)
    .max(hubLimits.sourcesPerHub + hubLimits.exclusionsPerHub)
    .nullish(),
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
  // The two kinds share one array and are capped SEPARATELY in the service — this
  // bound is only the outer one, so a list of 50 sources plus 20 exclusions is not
  // rejected before the service can tell the caller which half it overran.
  sources: z
    .array(userHubSourceSchema)
    .max(hubLimits.sourcesPerHub + hubLimits.exclusionsPerHub)
    .optional(),
  // Same "omitted means leave alone" rule as `sources`; stored on
  // `metadata.filters`, like `description`.
  filters: hubFeedFiltersSchema.optional(),
  // Private or Public, and nothing else. `Unsearchable` is the member that literally
  // means "public but not listed", which is what a hub is — it is not used because
  // hubs have no index and no listing to be absent from, so the distinction would
  // encode nothing. The cost is that a future sweep over `Availability.Public`
  // content picks hubs up as listed; change this the day hubs gain a directory.
  availability: z.enum([Availability.Private, Availability.Public]).optional(),
  // A browsing-level bitmask, 0 for "no cap". Masked rather than rejected on the
  // way in: an unknown bit is a level this deployment does not have, and storing it
  // would let a later release widen an existing hub by adding one.
  forcedBrowsingLevel: z
    .number()
    .int()
    .min(0)
    .transform((value) => value & allBrowsingLevelsFlag)
    .optional(),
});

// What a viewer switched off for their own session. Sent with the feed query rather
// than written anywhere: on a hub you do not own, a toggle is a view, not an edit.
export const hubSourceExclusionSchema = z.object({
  type: z.enum(UserHubSourceType),
  targetId: z.number().int().positive(),
});

export type HubSourceExclusionInput = z.infer<typeof hubSourceExclusionSchema>;

// The client builds its exclusion set with this and the service subtracts with it.
// One spelling, in the module both sides already import from.
export const hubSourceKey = (source: HubSourceExclusionInput) =>
  `${source.type}:${source.targetId}`;

/**
 * The equivalence key for a tag AND-group: rows sharing it, within one hub, are ANDed.
 *
 * 🔴 `exclude` is part of the key, not merely a property of the list it is computed
 * over. An include group 3 and an exclude group 3 are different groups, and a caller
 * that keys on the bare `groupKey` is correct only for as long as it happens to be
 * handed a polarity-uniform list — which is a fact about its caller, not about it.
 * That exact divergence has already happened once here: the client carried the
 * polarity and the server did not, and the two were fixed a round apart.
 */
export const hubTagGroupKey = (source: { exclude?: boolean | null; groupKey: number }) =>
  `${source.exclude ? 'x' : 'i'}-${source.groupKey}`;

// 🔴 Keyed, not int. `getFollowed` returns each hub's `key`, so an int-addressed
// follow of a public hub handed that key to any signed-in caller for the price of
// counting — defeating the URL encoding without touching the salt.
export const userHubFollowSchema = z.object({
  key: z.string().trim().min(1).max(64),
});

export type UserHubFollowInput = z.infer<typeof userHubFollowSchema>;

export const setUserHubOrderSchema = z.object({
  ids: z.array(z.number()).max(hubLimits.hubsPerUser),
});

export type UpsertUserHubInput = z.infer<typeof upsertUserHubSchema>;
export type UserHubSourceInput = z.infer<typeof userHubSourceSchema>;
export type SetUserHubOrderInput = z.infer<typeof setUserHubOrderSchema>;

// A hub built from something the user already has, rather than from an empty one they
// then have to fill. The template names WHAT to gather; the sources it resolves to are
// a point-in-time copy, so a model published afterwards is not in the hub.
export const hubTemplateSchema = z.enum(['my-models', 'following', 'bookmarks']);

export type HubTemplate = z.infer<typeof hubTemplateSchema>;

export const getHubSourceCandidatesSchema = z.object({ template: hubTemplateSchema });

export type GetHubSourceCandidatesInput = z.infer<typeof getHubSourceCandidatesSchema>;

export const resolveHubSourceSchema = z.object({
  url: z.string().trim().min(1).max(500),
});

export type ResolveHubSourceInput = z.infer<typeof resolveHubSourceSchema>;

/**
 * What the picker is looking through. A tab, not a filter: the search box under it
 * searches WITHIN the chosen scope, so "no results" means no results of that kind —
 * which is why the server also reports where the matches actually were.
 *
 * `tags` is the odd one: nothing of yours to browse, so it holds nothing until typed.
 */
export const hubSourceScopeSchema = z.enum(['all', 'following', 'my-models', 'bookmarks', 'tags']);

export type HubSourceScope = z.infer<typeof hubSourceScopeSchema>;

export const getHubSourceScopeSchema = z.object({
  scope: hubSourceScopeSchema,
  query: z.string().trim().max(100).optional(),
});

export type GetHubSourceScopeInput = z.infer<typeof getHubSourceScopeSchema>;

// One source at a time, addressed by what it points at rather than by row id: the
// caller is a model or creator page that knows the target and nothing about the
// hub's rows. Distinct from `upsertUserHubSchema.sources`, which REPLACES the list
// and so cannot be used by a caller that has not loaded it.
export const userHubSourceRefSchema = z.object({
  hubId: z.number().int().positive(),
  type: z.enum(UserHubSourceType),
  targetId: z.number().int().positive(),
});

// One target, no hub: "where does this already sit across my hubs".
export const hubSourceTargetSchema = userHubSourceRefSchema.omit({ hubId: true });

export type HubSourceTargetInput = z.infer<typeof hubSourceTargetSchema>;

export const addUserHubSourceSchema = userHubSourceRefSchema.extend({
  alias: userHubSourceSchema.shape.alias,
  exclude: z.boolean().default(false),
});

export type UserHubSourceRefInput = z.infer<typeof userHubSourceRefSchema>;

export type AddUserHubSourceInput = z.infer<typeof addUserHubSourceSchema>;
