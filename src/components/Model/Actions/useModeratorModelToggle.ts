import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * `model.getById` is keyed on its full input (incl. `excludeTrainingData`), which the menus
 * calling this don't know; `.invalidate` matches by partial input so `{ id }` still hits it,
 * unlike `.setData`, which requires an exact key and is silently a no-op here. `getAll` covers
 * the card menus, which read the same flags off their own list query.
 */
export function useModeratorModelToggle<TRequest>({
  modelId,
  getSuccessMessage,
  errorTitle,
}: {
  modelId: number;
  getSuccessMessage: (request: TRequest) => string;
  errorTitle: string;
}) {
  const queryUtils = trpc.useUtils();

  return {
    onSuccess: async (_response: unknown, request: TRequest) => {
      await Promise.all([
        queryUtils.model.getById.invalidate({ id: modelId }),
        queryUtils.model.getAll.invalidate(),
      ]);
      showSuccessNotification({ message: getSuccessMessage(request) });
    },
    onError: (error: { message: string }) => {
      showErrorNotification({ error: new Error(error.message), title: errorTitle });
    },
  };
}
