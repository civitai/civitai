import type { SearchResponse } from 'meilisearch';
import type { SessionUser } from '~/types/session';

import { getEdgeUrl } from '~/client-utils/edge-url';
import { MODELS_SEARCH_INDEX } from '~/server/common/constants';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import {
  isTransientMeiliError,
  MeiliCallTimeoutError,
  searchClient,
  withMeili,
} from '~/server/meilisearch/client';
import type { GetAllModelsOutput } from '~/server/schema/model.schema';
import { getDownloadFilename } from '~/server/services/file.service';
import { getModelsWithVersions } from '~/server/services/model.service';
import { getPrimaryFile } from '~/server/utils/model-helpers';
import { ModelFileVisibility, ModelModifier, ModelType } from '~/shared/utils/prisma/enums';
import type { ModelHashType } from '~/shared/utils/prisma/enums';
import { Flags } from '~/shared/utils/flags';
import { safeDecodeURIComponent } from '~/utils/string-helpers';
import { isDefined } from '~/utils/type-guards';

/**
 * Shared model-search + response-shaping body extracted verbatim from
 * `/api/v1/models/index.ts` so the public endpoint AND the block-scoped
 * catalog endpoint (`/api/v1/blocks/models.ts`) build the SAME response from
 * the SAME query path. The ONLY behavioral lever is `browsingLevel` (and the
 * `nsfwImagePassthrough` flag that mirrors the public endpoint's pre-refactor
 * `parsedParams.data.nsfw` image-filter widening) — both supplied by the
 * caller. The public endpoint passes its existing values UNCHANGED; the block
 * endpoint passes a server-clamped `browsingLevel` and `nsfwImagePassthrough:
 * false` so a SFW-domain block can never widen the image filter.
 *
 * Maturity policy is NOT decided here — this helper is a pure executor. The
 * caller is the single place that derives the effective `browsingLevel`.
 */

type FileMetadata = Record<string, unknown>;

const hashesAsObject = (hashes: { type: ModelHashType; hash: string }[]) =>
  hashes.reduce((acc, { type, hash }) => ({ ...acc, [type]: hash }), {});

export type RunModelSearchInput = Partial<Omit<GetAllModelsOutput, 'browsingLevel'>> & {
  /** Per-page take (the validated `limit`). */
  limit: number;
  /** Offset-paging skip (public endpoint only; undefined for cursor/query). */
  skip?: number;
  /** Free-text query (routes through Meilisearch when present). */
  query?: string;
  /** Cursor — opaque numeric offset for text search, id-cursor otherwise.
   *  Wide type to match the public endpoint's parsed cursor union. */
  cursor?: GetAllModelsOutput['cursor'];
  /** Pre-resolved id list (favorites/explicit ids path), forwarded as-is. */
  queryIds?: number[];
  /** primaryFileOnly response trim. */
  primaryFileOnly?: boolean;
  /** Resolved favorites collection id (public endpoint only). */
  collectionId?: number;
  /** supportsGeneration filter (forwarded from `data.supportsGeneration`). */
  supportsGeneration?: boolean;
  /**
   * Keep Meilisearch's relevance order for a text search (default `true`).
   *
   * Pass `false` when the caller has an EXPLICIT, user-chosen `sort` that must
   * win over relevance — otherwise the restore below silently discards it. See
   * the comment at the `orderedItems` assignment.
   */
  preserveRelevanceOrder?: boolean;
};

export type RunModelSearchContext = {
  /**
   * The EFFECTIVE browsing-level flag. The caller is the single source of
   * truth: the public endpoint passes its region/nsfw-derived value; the block
   * endpoint passes a value already clamped to the token's domain ceiling.
   */
  browsingLevel: number;
  /**
   * Mirrors the public endpoint's pre-refactor `parsedParams.data.nsfw` image
   * filter widening: when true, EVERY image on a version is returned
   * regardless of its nsfwLevel (legacy public-API behavior). When false, the
   * per-image filter is driven SOLELY by `browsingLevel`. The block endpoint
   * MUST pass false — otherwise a `nsfw=true` query would widen the image
   * filter past the clamp.
   */
  nsfwImagePassthrough: boolean;
  /** The viewer (session user) — undefined for anon. */
  user?: SessionUser;
  /** Absolute origin used to build download URLs (from getNextPage's baseUrl). */
  baseUrlOrigin: string;
};

const modelTypeValues = new Set<string>(Object.values(ModelType));

export class ModelSearchMeiliTimeoutError extends Error {
  constructor() {
    super('Model search is temporarily overloaded — please retry.');
    this.name = 'ModelSearchMeiliTimeoutError';
  }
}

/**
 * Resolve the Meilisearch id list + next-cursor for a text query. Throws
 * `ModelSearchMeiliTimeoutError` on a backend brownout so the caller can map
 * it to a 503 with the right cache headers (it cannot be a TRPCError because
 * handleEndpointError JSON.parses TRPCError messages — see the original
 * endpoint comment).
 */
export async function resolveModelSearchIds(opts: {
  query: string;
  cursor?: GetAllModelsOutput['cursor'];
  limit: number;
  browsingLevel: number;
  /**
   * Type filter applied INSIDE the Meili query. Without it, a `query` +
   * `types` request intersects the top-N relevance hits (of ANY type) with
   * the type filter in the DB — for sparse types like Wildcards that's
   * usually an empty page even when strong matches exist. Values are
   * validated against ModelType here because the block endpoint's schema
   * accepts arbitrary strings (also keeps them out of the filter expression).
   */
  types?: string[];
}): Promise<{ searchIds: number[]; nextCursor?: string }> {
  const { query, cursor, limit, browsingLevel, types } = opts;
  const browsingLevelValues = Flags.instanceToArray(browsingLevel);
  const typeValues = types?.filter((t) => modelTypeValues.has(t));
  const queryOffset = cursor && Number.isFinite(Number(cursor)) ? Math.max(0, Number(cursor)) : 0;

  let meiliResult: SearchResponse<{ id: number }> | undefined;
  try {
    const client = searchClient;
    meiliResult = client
      ? await withMeili('search', () =>
          client.index(MODELS_SEARCH_INDEX).search<{ id: number }>(query, {
            offset: queryOffset || undefined,
            limit: limit ? limit + 1 : undefined,
            filter: [
              `nsfwLevel IN [${browsingLevelValues.join(',')}]`,
              ...(typeValues?.length ? [`type IN [${typeValues.join(',')}]`] : []),
            ],
            attributesToRetrieve: ['id'],
          })
        )
      : undefined;
  } catch (e) {
    // Widened from `instanceof MeiliCallTimeoutError` to also cover
    // isTransientMeiliError: the timeout-wrapper only catches civitai's own
    // MeiliCallTimeoutError, but a Meilisearch brownout ALSO throws the SDK's
    // OWN transient error types (MeiliSearchCommunicationError statusCode
    // 408/429/5xx, MeiliSearchApiError with a gateway 502/503/504, the wrapped
    // SERVICE_UNAVAILABLE, MeiliSearchTimeOutError, network ECONNRESET, …).
    // Those previously fell through `throw e` as raw Errors → the REST handler
    // (whose resolveModelSearchIds try/catch sits BEFORE the outer try) left
    // them UNHANDLED → a raw HTTP 500 (the top REST 500 source on the ?query=
    // path; the same query retried immediately returns 200 — a transient
    // backend flap). Converting them to ModelSearchMeiliTimeoutError here lets
    // the caller map a transient upstream to a retryable 503 (no-store +
    // Retry-After). A non-transient error (malformed filter / auth / real app
    // bug) is NOT matched and still surfaces as its real status.
    if (e instanceof MeiliCallTimeoutError || isTransientMeiliError(e))
      throw new ModelSearchMeiliTimeoutError();
    throw e;
  }

  const hits = meiliResult?.hits ?? [];
  const hasMore = limit ? hits.length > limit : false;
  const searchIds = (hasMore ? hits.slice(0, limit) : hits).map((hit) => hit.id);
  const nextCursor = hasMore ? String(queryOffset + limit) : undefined;
  return { searchIds, nextCursor };
}

/**
 * Run the model search and shape the response. Behavior-preserving extraction
 * of the body of `/api/v1/models/index.ts`. The caller owns: query parsing,
 * pagination math, the Meili pre-step (via `resolveModelSearchIds`), the
 * favorites-collection lookup, region restriction, and — critically — the
 * EFFECTIVE `browsingLevel`. This function decides no policy.
 */
export async function runModelSearch(
  input: RunModelSearchInput & { searchIds?: number[] },
  ctx: RunModelSearchContext
): Promise<{ items: unknown[]; nextCursor?: string | bigint | Date }> {
  const { browsingLevel, nsfwImagePassthrough, user, baseUrlOrigin } = ctx;
  const {
    limit,
    skip,
    query,
    cursor,
    queryIds,
    primaryFileOnly,
    collectionId,
    searchIds,
    // Destructured so it does NOT reach `...data` and get spread into the
    // catalog query as an unknown column filter.
    preserveRelevanceOrder,
    // Dropped, never forwarded: the ctx value is the only authority. The input
    // type excludes it, but callers spread parsed query data in through a cast,
    // and `browsingLevel` now decides the minor gate as well as the level filter.
    browsingLevel: _clientBrowsingLevel,
    ...data
  } = input as typeof input & { browsingLevel?: number };

  const { items, nextCursor } = await getModelsWithVersions({
    // Cast: callers supply a partial of GetAllModelsOutput (the public endpoint
    // a full parsed value; the block endpoint a selector subset). getModelsRaw
    // reads `sort`/`period` at runtime and tolerates the rest being absent —
    // the public endpoint always carried schema defaults, the block endpoint
    // sets the ones it relies on (sort/period) explicitly. The static type is
    // wider than the runtime contract, so cast at this single seam.
    input: {
      browsingLevel,
      ...data,
      take: limit,
      skip: !query ? skip : undefined,
      cursor: !query ? cursor : undefined,
      ids: query ? searchIds ?? [] : queryIds,
      collectionId,
      // No `disableMinor` here on purpose: getModelsRaw resolves it from the live
      // browsing-settings addons against `browsingLevel`, so it turns on for
      // ?nsfw=true and stays off for the default SFW request.
      disablePoi: true,
    } as Parameters<typeof getModelsWithVersions>[0]['input'],
    user,
  });

  // Meilisearch returns ids in relevance order, but getModelsWithVersions
  // re-sorts by lastVersionAt/modelId. For text search, restore relevance.
  //
  // 🔴 UNLESS THE CALLER EXPLICITLY ASKED FOR AN ORDER. This restore is
  // unconditional-on-`query` by default, which silently DISCARDS `sort`
  // whenever a text query is present: `getModelsRaw` builds its `orderBy`
  // purely from `sort` (`model.service`, the `ModelSort` ladder), the rows come
  // back correctly ordered, and this line then reimposes relevance over the top.
  // The caller cannot tell — nothing errors, and the result is a plausible list
  // in the wrong order. That is how "the most popular ANIME models" returns
  // relevance-ranked results while "the most popular models" ranks correctly.
  //
  // Opt-out rather than a behaviour change: `preserveRelevanceOrder` defaults to
  // the historical behaviour, so every existing caller — the public endpoint and
  // `blocks/models` included — is untouched. Only a caller that has a real
  // user-chosen sort AND wants it to win passes `false`.
  // 🔴 ZERO HITS MEANS ZERO RESULTS, AND IT MUST NOT DEPEND ON THE FLAG ABOVE.
  // `getModelsRaw` adds its id predicate under `if (!!ids?.length)`, so an EMPTY
  // `searchIds` adds NO filter at all and the query degrades to an unfiltered
  // catalog page. Until `preserveRelevanceOrder` existed, the relevance restore
  // hid that: mapping over an empty array returned `[]`, so the empty case was
  // guarded by ACCIDENT rather than on purpose. Opting out of the restore
  // removed the accident and let a no-match text search return the whole
  // catalog — measured `[]` vs `[1,2,3]` on identical inputs, i.e. a block
  // answering "the most downloaded zzzqqq models are…" with the site-wide top
  // 10. That is strictly worse than the wrong ORDER this flag exists to fix.
  //
  // So the empty case is now its own branch, ahead of the flag, and says what it
  // means. Also covers the SFW-clamped shape where Meili's own nsfwLevel filter
  // is what leaves the hit list empty.
  // `!searchIds?.length` rather than an Array.isArray + length check: it covers
  // `undefined` as well as `[]`. Both degrade identically at
  // `ids: query ? searchIds ?? [] : queryIds` — an absent id list is no id
  // predicate, which is the same fail-open. No caller passes `undefined` today
  // (all three declare `let searchIds: number[] = []`), so this closes a shape
  // that is currently unreachable rather than fixing a live bug — but the type
  // permits it, and the cost is one character.
  const noTextMatches = Boolean(query) && !searchIds?.length;
  const orderedItems = noTextMatches
    ? []
    : query && searchIds && preserveRelevanceOrder !== false
    ? searchIds.map((id) => items.find((m) => m.id === id)).filter(isDefined)
    : items;

  const preferredFormat = { metadata: user?.filePreferences };

  const shaped = orderedItems.map(({ modelVersions, tagsOnModels, user: modelUser, ...model }) => ({
    ...model,
    mode: model.mode == null ? undefined : model.mode,
    creator: modelUser
      ? {
          username: modelUser.username,
          image: modelUser.profilePicture
            ? getEdgeUrl(modelUser.profilePicture.url, {
                width: 96,
                name: modelUser.username,
                type: modelUser.profilePicture.type,
              })
            : modelUser.image
            ? getEdgeUrl(modelUser.image, { width: 96, name: modelUser.username })
            : null,
        }
      : undefined,
    tags: tagsOnModels.map(({ name }) => name),
    modelVersions: modelVersions
      .filter((x) => x.status === 'Published' && (!data.supportsGeneration || x.covered))
      .map(({ status, files, images, createdAt, covered, ...version }) => {
        let castedFiles =
          (files as Array<Omit<(typeof files)[number], 'metadata'> & { metadata: FileMetadata }>) ??
          [];
        const primaryFile = getPrimaryFile(castedFiles, preferredFormat);
        if (!primaryFile) return null;
        if (primaryFileOnly === true) castedFiles = [primaryFile];

        const includeDownloadUrl = model.mode !== ModelModifier.Archived;
        const includeImages = model.mode !== ModelModifier.TakenDown;

        return {
          ...version,
          supportsGeneration: covered,
          files: includeDownloadUrl
            ? castedFiles
                .filter((file) => file.visibility === ModelFileVisibility.Public)
                // `modelVersionId` is stripped, not used: getModelsWithVersions
                // now preserves it (a spliced VAE file belongs to the LINKED
                // version, not this one), and the `...file` spread would
                // otherwise put it on the public wire body. This endpoint does
                // not pin `fileId` at all, so it needs the value only to keep
                // it out of the response.
                .map(({ hashes, modelVersionId: _ownerVersionId, ...file }) => ({
                  ...file,
                  name: safeDecodeURIComponent(
                    getDownloadFilename({ model, modelVersion: version, file })
                  ),
                  hashes: hashesAsObject(hashes),
                  downloadUrl: `${baseUrlOrigin}${createModelFileDownloadUrl({
                    versionId: version.id,
                    type: file.type,
                    meta: file.metadata,
                    primary: primaryFile.id === file.id,
                  })}`,
                  primary: primaryFile.id === file.id ? true : undefined,
                  url: undefined,
                  visibility: undefined,
                }))
            : [],
          // Image filter: when nsfwImagePassthrough is true (public endpoint
          // with ?nsfw=true) every image passes — legacy behavior. Otherwise
          // the per-image nsfwLevel is checked against the EFFECTIVE
          // browsingLevel. The block endpoint passes false so the clamp can't
          // be widened by a client nsfw flag.
          images: includeImages
            ? images
                .filter((x) => nsfwImagePassthrough || Flags.intersects(x.nsfwLevel, browsingLevel))
                .map(({ url, id, ...image }) => ({
                  id,
                  url: getEdgeUrl(url, {
                    original: true,
                    name: id.toString(),
                    type: image.type,
                  }),
                  ...image,
                }))
            : [],
          downloadUrl: includeDownloadUrl
            ? `${baseUrlOrigin}${createModelFileDownloadUrl({
                versionId: version.id,
                primary: true,
              })}`
            : undefined,
        };
      })
      .filter((x) => x),
  }));

  return { items: shaped, nextCursor };
}
