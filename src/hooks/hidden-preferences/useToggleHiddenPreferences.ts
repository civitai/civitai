import produce from 'immer';
import type { ToggleHiddenSchemaOutput } from '~/server/schema/user-preferences.schema';
import { trpc } from '~/utils/trpc';

const kindMap = {
  image: 'hiddenImages',
  model: 'hiddenModels',
  tag: 'hiddenTags',
  user: 'hiddenUsers',
  blockedUser: 'blockedUsers',
} as const;

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
      queryUtils.hiddenPreferences.getHidden.setData(
        undefined,
        (
          old = {
            hiddenImages: [],
            hiddenModels: [],
            hiddenUsers: [],
            hiddenTags: [],
            blockedUsers: [],
            blockedByUsers: [],
          }
        ) =>
          produce(old, (draft) => {
            for (const { kind, id, ...props } of added) {
              const index = draft[key].findIndex((x) => x.id === id && x.hidden);
              if (index === -1) draft[key].push({ id, ...props } as any);
              else draft[key][index] = { id, ...props };
            }
            for (const { kind, id, ...props } of removed) {
              const index = draft[key].findIndex((x) => x.id === id && x.hidden);
              if (index > -1) draft[key].splice(index, 1);
            }
          })
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
    queryUtils.hiddenPreferences.getHidden.setData(
      undefined,
      (
        old = {
          hiddenImages: [],
          hiddenModels: [],
          hiddenUsers: [],
          hiddenTags: [],
          blockedUsers: [],
          blockedByUsers: [],
        }
      ) =>
        produce(old, (draft) => {
          for (const item of data) {
            const index = draft[key].findIndex((x) => x.id === item.id && x.hidden);
            if (hidden === true && index === -1) draft[key].push({ ...item, hidden: true } as any);
            else if (hidden === false && index > -1) draft[key].splice(index, 1);
            else if (hidden === undefined) {
              if (index > -1) draft[key].splice(index, 1);
              else draft[key].push({ ...item, hidden: true } as any);
            }
          }
        })
    );
  };

  return updateHiddenPreferences;
};
