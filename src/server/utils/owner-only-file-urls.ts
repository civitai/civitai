import { middleware } from '~/server/trpc';

/**
 * A model file's `url` is its storage location: only the version's owner (and moderators) need it,
 * for their own upload and training flows. Everyone else downloads through
 * `/api/download/models/{versionId}`, which applies the access rules.
 *
 * This runs after the resolver, on every request, so no shared cache upstream of it can hold an
 * owner's response for another viewer: only anonymous responses are edge-cached (`createContext`),
 * and those always come through here stripped. Keep it the LAST `.use()` before the resolver, so a
 * response-caching middleware added later stores the stripped result rather than the owner's.
 */
type OwnerOnlyFileUrlsConfig<TData, TInput> = {
  /** The owner of the version(s) in the response. `undefined` strips for everyone but moderators. */
  ownerId: (args: {
    data: TData;
    input: TInput;
  }) => number | undefined | Promise<number | undefined>;
  strip: (data: TData) => TData;
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
  }: { data: TData; input: TInput; user?: { id: number; isModerator?: boolean } }
): Promise<TData> {
  if (data == null) return data;
  if (user?.isModerator) return data;
  if (user && user.id === (await config.ownerId({ data, input }))) return data;
  return config.strip(data);
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
    });
    return data === result.data ? result : { ...result, data };
  });
}

export function withoutFileUrls<T extends { url?: unknown }>(files: T[] | null | undefined) {
  return files?.map((file) => ({ ...file, url: undefined })) ?? files;
}
