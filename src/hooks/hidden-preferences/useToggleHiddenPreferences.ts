import type { ToggleHiddenSchemaOutput } from '~/server/schema/user-preferences.schema';
import {
  applyOptimisticHiddenToggle,
  applyToggleSuccess,
  EMPTY_HIDDEN_CACHE,
  HIDDEN_KIND_TO_KEY,
  planToggleRollback,
} from '~/shared/hidden-preferences/compact';
import { trpc } from '~/utils/trpc';

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
    onSuccess: async (result, variables) => {
      queryUtils.hiddenPreferences.getHidden.setData(undefined, (old) =>
        applyToggleSuccess(old as any, variables, result)
      );

      // Invalidate user lists when user or blockedUser preferences change
      if (variables.kind === 'user' || variables.kind === 'blockedUser') {
        await queryUtils.user.getLists.invalidate();
        await queryUtils.user.getList.invalidate();
      }
    },
    onError: async (_error, _variables, context) => {
      const plan = planToggleRollback(context?.previous as any);
      if ('restore' in plan)
        queryUtils.hiddenPreferences.getHidden.setData(undefined, plan.restore as any);
      else await queryUtils.hiddenPreferences.getHidden.invalidate();
    },
  });
};

export const useUpdateHiddenPreferences = () => {
  const queryUtils = trpc.useUtils();
  const updateHiddenPreferences = ({ kind, data, hidden }: ToggleHiddenSchemaOutput) => {
    const key = HIDDEN_KIND_TO_KEY[kind];
    queryUtils.hiddenPreferences.getHidden.setData(undefined, (old = EMPTY_HIDDEN_CACHE as any) =>
      applyOptimisticHiddenToggle(old, key, data, hidden)
    );
  };

  return updateHiddenPreferences;
};
