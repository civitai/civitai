import produce from 'immer';
import { ToggleHiddenSchemaOutput } from '~/server/schema/user-preferences.schema';
import { invalidateModeratedContentDebounced } from '~/utils/query-invalidation-utils';
import { trpc } from '~/utils/trpc';

export const useToggleHiddenPreferences = () => {
  const queryUtils = trpc.useContext();
  const updateHiddenPreferences = useUpdateHiddenPreferences();

  return trpc.hiddenPreferences.toggleHidden.useMutation({
    onMutate: async (args) => {
      await queryUtils.hiddenPreferences.getHidden.cancel();

      const previous = queryUtils.hiddenPreferences.getHidden.getData();

      updateHiddenPreferences(args);

      return { previous };
    },
    onSuccess: ({ added, removed }, { kind }) => {
      queryUtils.hiddenPreferences.getHidden.setData(
        undefined,
        (old = { image: [], model: [], user: [], tag: [] }) =>
          produce(old, (draft) => {
            for (const { kind, id, ...props } of added) {
              const index = draft[kind].findIndex((x) => x.id === id && x.type === props.type);
              if (index === -1) draft[kind].push({ id, ...props } as any);
              else draft[kind][index] = { id, ...props };
            }
            for (const { kind, id, ...props } of removed) {
              const index = draft[kind].findIndex((x) => x.id === id && x.type === props.type);
              if (index > -1) draft[kind].splice(index, 1);
            }
          })
      );
      invalidateModeratedContentDebounced(queryUtils, kind === 'tag' ? ['tag'] : undefined); // TODO - remove this once frontend filtering is finished
    },
    onError: (_error, _variables, context) => {
      queryUtils.hiddenPreferences.getHidden.setData(undefined, context?.previous);
    },
  });
  // trpc.hiddenPreferences.getHidden.useQuery();
};

export const useUpdateHiddenPreferences = () => {
  const queryUtils = trpc.useContext();
  const updateHiddenPreferences = ({ kind, data, hidden }: ToggleHiddenSchemaOutput) => {
    const type = kind === 'tag' ? 'hidden' : 'always';
    queryUtils.hiddenPreferences.getHidden.setData(
      undefined,
      (old = { image: [], model: [], user: [], tag: [] }) =>
        produce(old, (draft) => {
          for (const item of data) {
            const index = draft[kind].findIndex((x) => x.id === item.id && x.type === type);
            if (hidden === true && index === -1) draft[kind].push({ ...item, type } as any);
            else if (hidden === false && index > -1) draft[kind].splice(index, 1);
            else if (hidden === undefined) {
              if (index > -1) draft[kind].splice(index, 1);
              else draft[kind].push({ ...item, type } as any);
            }
          }
        })
    );
  };

  return updateHiddenPreferences;
};
