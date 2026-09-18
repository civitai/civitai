import { Availability } from '~/shared/utils/prisma/enums';
import * as z from 'zod';
import dayjs from '~/shared/utils/dayjs';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

export const getByIdSchema = z.object({ id: z.number() });
export type GetByIdInput = z.infer<typeof getByIdSchema>;

export const getByIdsSchema = z.object({ ids: z.number().array() });
export type GetByIdsInput = z.infer<typeof getByIdsSchema>;

export const getByIdStringSchema = z.object({ id: z.string() });
export type GetByIdStringInput = z.infer<typeof getByIdStringSchema>;

const limit = z.coerce.number().min(1).max(200).default(20);
const page = z.coerce.number().min(0).default(1);

export type PaginationInput = z.infer<typeof paginationSchema>;
export const paginationSchema = z.object({
  limit,
  page,
});

export const getAllQuerySchema = paginationSchema.extend({
  query: z.string().optional(),
});
export type GetAllSchema = z.infer<typeof getAllQuerySchema>;

export const periodModeSchema = z.enum(['stats', 'published']).default('published');
export type PeriodMode = z.infer<typeof periodModeSchema>;

export const baseQuerySchema = z.object({
  browsingLevel: z.number().min(0).default(allBrowsingLevelsFlag),
});

export type InfiniteQueryInput = z.infer<typeof infiniteQuerySchema>;
export const infiniteQuerySchema = z.object({
  limit,
  cursor: z.number().optional(),
});

/** Postgres `int4` upper bound. */
export const INT4_MAX = 2147483647;

/**
 * Keyset-pagination cursor, as issued by a previous page's `nextCursor` (the
 * row's `cursorId`): either a single column value, for a single-field sort, or a
 * `CONCAT(col, '|', …)` string, for a multi-field sort.
 *
 * The numeric members are bounded to Postgres `int4` because the single-field
 * keyset sorts here order by `int` columns — mostly ids (`i."id"`, `ci."id"`,
 * `ct."collectionItemId"`, …), but NOT only ids: see the lower-bound note below
 * for `i."index"`, an `int` column that is neither an id nor 1-based. The set was
 * not exhaustively enumerated, so read this as the reason for the UPPER bound and
 * not as a closed inventory. A bare `z.number()` accepts arbitrarily large
 * client input, which then binds straight into the SQL comparison and makes
 * Postgres throw `value out of range for type integer` — surfacing as a raw 500
 * for what is a client fault. Bounding here fails the input parse instead, so
 * the caller gets a 400. Same class, and the same bound, as the
 * `/api/v1/models/[id]` id schema.
 *
 * `.int().gte(0)` is part of that bound and is tighter than "fits in int4":
 * negatives and non-integers are rejected too. `0` is NOT rejected — see below.
 *
 * 🔴 THE LOWER BOUND HAS NO ESTABLISHED JUSTIFICATION, and two attempts to give
 * it one have now been falsified. Do not compose a third; if you cannot
 * establish it, write that it is not established.
 *
 * The first attempt was "every one of those columns is an autoincrement `Int`
 * starting at 1, so no cursor this server issues can be any of them". FALSE:
 * `Image.index` (`packages/civitai-db-schema/prisma/schema.full.prisma:1866`) is
 * `Int?` — nullable, NOT autoincrement, and not 1-based. It is a single-field
 * keyset sort column on the postId path (`src/server/services/image.service.ts`,
 * `orderBy = i."index"`) inside `getAllImagesUncaptured`, which
 * `image.getInfinite` reaches through its DB branch — one of the four call sites
 * this schema bounds. `reorderPostImages` (`src/server/services/post.service.ts`)
 * writes `imageIds.map((id, index) => … data: { index })`, so on a reordered post
 * the smallest index is `0`. (Other writers number differently, e.g.
 * `src/components/Post/EditV2/PostReorderImages.tsx` uses `index + 1`; the point
 * that survives either convention is that `0` is reachable, not that every post
 * is 0-based.)
 *
 * The second attempt was "no ISSUABLE `0` exists: a `nextCursor` is the row at
 * 0-based offset `limit` under that ASC sort, so its `index` is >= `limit`".
 * FALSE at `limit = 0`, which needs no malformed input: `getInfiniteImagesSchema`
 * declares `limit: z.number().min(0).max(200)`, so `image.getInfinite({ postId,
 * limit: 0 })` parses. `postId` makes `requiresImageDbPath` true, the sort is
 * `i."index"` ASC, the query runs `LIMIT limit + 1` = 1, and
 * `rawImages.length (1) > limit (0)` promotes that first row to `nextCursor`
 * with `cursorId` = `i."index"`. On a reordered post that value is `0`. Under
 * the previous `.gt(0)` the client's own follow-up cursor came back 400.
 *
 * So the floor is `.gte(0)`. That is the change, not a justification: rejecting
 * `0` was falsifiable and was falsified, and a bound whose only argument has
 * been withdrawn twice should not be the tighter one.
 *
 * WHAT IS STILL NOT ESTABLISHED, stated so the next reader need not rediscover
 * it: that `0` is the correct FLOOR. Nothing shown here rules out a negative
 * cursor — `addPostImageSchema.index` (`src/server/schema/post.schema.ts`) is a
 * bare `z.number()`, so negative and non-integer indices are permitted into
 * `createImage` unfiltered, and a negative `i."index"` would be issuable as a
 * `nextCursor` the same way `0` is. No such row was looked for, in the database
 * or anywhere else. If a rejected negative cursor is ever observed, the floor
 * belongs at the int4 minimum, not at `0`. Do not tighten anything else on the
 * strength of this floor.
 *
 * The int4 UPPER bound is the half this schema is actually for. The lower bound
 * is NOT inherited: at the merge base all four call sites declared a bare
 * `z.union([z.bigint(), z.number(), z.string(), z.date()])` with no bounds at
 * all, so every part of this bound is introduced here.
 *
 * NOTE: this bound covers the MAGNITUDE half of the class only, and read the
 * next paragraph before treating the other half as closed. An *in-range* number
 * bound to a `timestamp` sort column (e.g. `mm."lastVersionAt"` on model
 * Newest/Oldest) makes Postgres throw `date/time field value out of range`.
 * That is an arity/shape problem, not a magnitude one, so no bound here can
 * catch it.
 *
 * `parseCursor` (`src/server/utils/pagination-helpers.ts`) rejects the BARE
 * SCALAR shape of that — a number/bigint/Date where the sort needs N values.
 * 🔴 It does NOT reject the COMPOSITE-STRING shape: a hand-built `"165997|123"`
 * on a date-headed sort has the right token COUNT, and `parseCursor` decides
 * date-vs-numeric per token by whether the token contains `-`, so the numeric
 * head token is bound to the timestamp column and Postgres throws exactly as
 * before. That is a KNOWN, open residual — closing it needs per-field type
 * information the sort string does not carry. It is pinned as a documented gap
 * in `src/server/utils/pagination-helpers.test.ts`; do not read this schema, or
 * `parseCursor`'s guards, as covering it.
 *
 * A string cursor is therefore left unbounded on purpose: the composite form
 * carries timestamps and `|` separators. `parseCursor` validates a string
 * cursor's token COUNT and each token's PARSEABILITY — never that a token's
 * type is coherent with the column it will be compared against.
 */
export const keysetCursorSchema = z
  .union([
    z.bigint().gt(BigInt(0)).lte(BigInt(INT4_MAX)),
    z.number().int().gte(0).lte(INT4_MAX),
    z.string(),
    z.date(),
  ])
  .transform((val) =>
    typeof val === 'string' && dayjs(val, 'YYYY-MM-DDTHH:mm:ss.SSS[Z]', true).isValid()
      ? new Date(val)
      : val
  );

export type UserPreferencesInput = z.infer<typeof userPreferencesSchema>;
export const userPreferencesSchema = z.object({
  browsingLevel: z.number().optional(),
  excludedModelIds: z.array(z.number()).optional(),
  excludedUserIds: z.array(z.number()).optional(),
  excludedTagIds: z.array(z.number()).optional(),
  excludedImageIds: z.array(z.number()).optional(),
});

export const getByEntitySchema = z.object({
  entityType: z.string(),
  entityId: z.preprocess((val) => (Array.isArray(val) ? val : [val]), z.array(z.number())),
});
export type GetByEntityInput = z.infer<typeof getByEntitySchema>;

export const resourceInput = z.object({
  entityType: z.string(),
  entityId: z.number(),
});

export type ResourceInput = z.infer<typeof resourceInput>;

export const supportedAvailabilityResources = [
  'ModelVersion',
  'Article',
  'Post',
  'Model',
  'Collection',
  'Bounty',
  'ComicChapter',
] as const;

export type SupportedAvailabilityResources = (typeof supportedAvailabilityResources)[number];

export const availabilitySchema = z.object({
  entityType: z.enum(supportedAvailabilityResources),
  entityId: z.number(),
  availability: z.enum(Availability),
});

export type AvailabilityInput = z.infer<typeof availabilitySchema>;
