import { trpc } from '~/utils/trpc';

/**
 * The image feed's query key carries `hubId`, not the source list, so it does not
 * refetch on its own when a hub's sources change.
 */
export function useInvalidateHub() {
  const utils = trpc.useUtils();

  return async (hubId: number) => {
    await Promise.all([
      utils.userHub.getAll.invalidate(),
      utils.userHub.getById.invalidate({ id: hubId }),
      utils.image.getInfinite.invalidate({ hubId }),
    ]);
  };
}
