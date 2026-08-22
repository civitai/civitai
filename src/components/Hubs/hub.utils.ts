import { trpc } from '~/utils/trpc';

/**
 * The caches every hub write moves. The feed is keyed on hubId, not on the source
 * list, so it will not refetch on its own when the sources behind it change — which
 * is the key each call site had been forgetting one at a time.
 *
 * `hubId` is omitted only when the write's target is unknown (a failed create).
 */
export function useInvalidateHub() {
  const utils = trpc.useUtils();

  return async (hubId?: number) => {
    await Promise.all([
      utils.userHub.getAll.invalidate(),
      ...(hubId != null
        ? [
            utils.userHub.getById.invalidate({ id: hubId }),
            utils.image.getInfinite.invalidate({ hubId }),
          ]
        : []),
    ]);
  };
}
