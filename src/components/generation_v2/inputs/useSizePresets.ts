import { useCurrentUser } from '~/hooks/useCurrentUser';
import { fitCustomDimensions, type CustomDimensionLimits } from '~/utils/aspect-ratio-helpers';
import { trpc } from '~/utils/trpc';
import { withSavedSize } from './size-presets.utils';

export type SizePreset = {
  id: number;
  width: number;
  height: number;
  /** The current model accepts this size unchanged. */
  fits: boolean;
};

/**
 * The user's saved custom sizes — one list, not one per model — marked by whether
 * the current model's limits accept each, and saving / removing them.
 *
 * Fetched once per session, and not until a model with custom sizes is picked;
 * saves and removes patch that cache in place. Signed out, or for a picker without
 * custom sizes, there are none and saving is off. The picker's More list and the
 * size modal both read it, so a save in the modal shows in the list at once.
 */
export function useSizePresets(limits?: CustomDimensionLimits) {
  const currentUser = useCurrentUser();
  const enabled = !!limits && !!currentUser;
  const utils = trpc.useUtils();

  const { data } = trpc.generationSizePreset.getAll.useQuery(undefined, { enabled });

  const add = trpc.generationSizePreset.add.useMutation({
    onSuccess: (saved) =>
      utils.generationSizePreset.getAll.setData(undefined, (all = []) => withSavedSize(all, saved)),
  });
  const remove = trpc.generationSizePreset.delete.useMutation({
    onSuccess: ({ id }) =>
      utils.generationSizePreset.getAll.setData(undefined, (all = []) =>
        all.filter((p) => p.id !== id)
      ),
  });

  const presets: SizePreset[] =
    enabled && data
      ? data.map((preset) => {
          const fit = fitCustomDimensions(preset, limits);
          return { ...preset, fits: fit?.width === preset.width && fit.height === preset.height };
        })
      : [];

  return {
    presets,
    canSave: enabled,
    saving: add.isPending,
    save: (size: { width: number; height: number }) => add.mutate(size),
    remove: (id: number) => remove.mutate({ id }),
  };
}
