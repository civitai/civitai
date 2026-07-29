import type { ToggleHiddenSchemaOutput } from '~/server/schema/user-preferences.schema';
import {
  applyOptimisticHiddenToggle,
  applyServerHiddenToggle,
} from '~/shared/hidden-preferences/compact';
import { trpc } from '~/utils/trpc';

const kindMap = {
  image: 'hiddenImages',
  model: 'hiddenModels',
  model3d: 'hiddenModel3Ds',
  tag: 'hiddenTags',
  user: 'hiddenUsers',
  blockedUser: 'blockedUsers',
} as const;

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
    onSuccess: async ({ added, removed }, { kind }) => {
      const key = kindMap[kind];
      // Shape-aware: `applyServerHiddenToggle` writes bare ids for the compact
      // id-only sets and `{ id, hidden }` objects for the legacy / object sets.
      queryUtils.hiddenPreferences.getHidden.setData(undefined, (old = emptyLegacy as any) =>
        applyServerHiddenToggle(old, key, added, removed)
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
    const key = kindMap[kind];
    queryUtils.hiddenPreferences.getHidden.setData(undefined, (old = emptyLegacy as any) =>
      applyOptimisticHiddenToggle(old, key, data, hidden)
    );
  };

  return updateHiddenPreferences;
};
