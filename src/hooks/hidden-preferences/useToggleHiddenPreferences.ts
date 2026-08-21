import type { ToggleHiddenSchemaOutput } from '~/server/schema/user-preferences.schema';
import {
  applyOptimisticHiddenToggle,
  HIDDEN_KIND_TO_KEY,
  reconcileHiddenToggle,
} from '~/shared/hidden-preferences/compact';
import { trpc } from '~/utils/trpc';

// Legacy (object-wrapped) empty cache — used only when the query cache is empty
// during an optimistic write (rare; getHidden is prefetched). A real fetch
// overwrites this, and `expandHiddenPreferences` reads the legacy shape fine.
const emptyLegacy = {
  hiddenImages: [],
  hiddenModels: [],
  hiddenModel3Ds: [],
  hiddenUsers: [],
  hiddenTags: [],
  blockedUsers: [],
  blockedByUsers: [],
};

export const useToggleHiddenPreferences = () => {
  const queryUtils = trpc.useUtils();
  const updateHiddenPreferences = useUpdateHiddenPreferences();

  return trpc.hiddenPreferences.toggleHidden.useMutation({
    onMutate: async (args) => {
      await queryUtils.hiddenPreferences.getHidden.cancel();

      const previous = queryUtils.hiddenPreferences.getHidden.getData();

      updateHiddenPreferences(args);

      return { previous };
    },
    onSuccess: async (result, { kind, data }) => {
      queryUtils.hiddenPreferences.getHidden.setData(undefined, (old = emptyLegacy as any) =>
        reconcileHiddenToggle(old, kind, data, result)
      );

      // Invalidate user lists when user or blockedUser preferences change
      if (kind === 'user' || kind === 'blockedUser') {
        await queryUtils.user.getLists.invalidate();
        await queryUtils.user.getList.invalidate();
      }
    },
    onError: (_error, _variables, context) => {
      queryUtils.hiddenPreferences.getHidden.setData(undefined, context?.previous);
    },
  });
  // trpc.hiddenPreferences.getHidden.useQuery();
};

export const useUpdateHiddenPreferences = () => {
  const queryUtils = trpc.useUtils();
  const updateHiddenPreferences = ({ kind, data, hidden }: ToggleHiddenSchemaOutput) => {
    const key = HIDDEN_KIND_TO_KEY[kind];
    queryUtils.hiddenPreferences.getHidden.setData(undefined, (old = emptyLegacy as any) =>
      applyOptimisticHiddenToggle(old, key, data, hidden)
    );
  };

  return updateHiddenPreferences;
};
