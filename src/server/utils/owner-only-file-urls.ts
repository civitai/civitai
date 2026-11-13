import { middleware } from '~/server/trpc';
import { isRedCapableHost } from '~/server/utils/server-domain';

/**
 * A model file's `url` (its storage location) and its training epoch URLs are for the version's
 * owner (and moderators), for their own upload and training flows. Everyone else downloads through
 * `/api/download/models/{versionId}`, which applies the access rules.
 *
 * This runs after the resolver, on every request, so no shared cache upstream of it can hold an
 * owner's response for another viewer: only anonymous responses are edge-cached (`createContext`),
 * and those always come through here stripped. Keep it the LAST `.use()` before the resolver, so
 * the strip runs on whatever a response-caching middleware added later hands back.
 */
type OwnerOnlyFileUrlsConfig<TData, TInput> = {
  /** The owner of the version(s) in the response. `undefined` strips for everyone but moderators. */
  ownerId: (args: {
    data: TData;
    input: TInput;
  }) => number | undefined | Promise<number | undefined>;
  /** Everyone else's view. `redCapable` is `isRedCapableHost` of the request. */
  strip: (data: TData, viewer: { redCapable: boolean }) => TData | Promise<TData>;
  /** The owner's view, when it differs from the stored data. Moderators always get the data. */
  forOwner?: (data: TData) => TData | Promise<TData>;
};

/**
 * The decision, pulled out of the middleware so it is directly testable (tRPC's `middleware()`
 * returns a builder, not a callable). Returns `data` unchanged for the owner and moderators,
 * stripped for everyone else — including when the owner can't be resolved.
 */
export async function resolveOwnerOnlyFileUrls<TData, TInput>(
  config: OwnerOnlyFileUrlsConfig<TData, TInput>,
  {
    data,
    input,
    user,
    redCapable = false,
  }: {
    data: TData;
    input: TInput;
    user?: { id: number; isModerator?: boolean };
    redCapable?: boolean;
  }
): Promise<TData> {
  if (data == null) return data;
  if (user?.isModerator) return data;
  if (user && user.id === (await config.ownerId({ data, input })))
    return config.forOwner ? config.forOwner(data) : data;
  return config.strip(data, { redCapable });
}

export function ownerOnlyFileUrls<TData, TInput = unknown>(
  config: OwnerOnlyFileUrlsConfig<TData, TInput>
) {
  return middleware(async ({ ctx, input, next }) => {
    const result = await next();
    if (!result.ok || result.data == null) return result;
    const data = await resolveOwnerOnlyFileUrls(config, {
      data: result.data as TData,
      input: input as TInput,
      user: ctx.user,
      redCapable: isRedCapableHost(ctx.req?.headers?.host),
    });
    return data === result.data ? result : { ...result, data };
  });
}

/** Everyone else's view of a file: no storage `url`, and no training epoch URLs in its metadata. */
export function withoutFileUrls<T extends { url?: unknown; metadata?: unknown }>(
  files: T[] | null | undefined
) {
  return (
    files?.map((file) => ({
      ...file,
      url: undefined,
      ...('metadata' in file ? { metadata: withoutEpochFields(file.metadata) } : {}),
    })) ?? files
  );
}

const EPOCH_FIELDS = ['trainingResults', 'selectedEpochUrl'];

/** File metadata without the training epoch URLs, which are the owner's alone. */
export function withoutEpochFields<M>(metadata: M): M {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return metadata;
  const copy = { ...(metadata as Record<string, unknown>) };
  for (const key of EPOCH_FIELDS) delete copy[key];
  return copy as M;
}
