import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function ToggleMinorModel({
  modelId,
  minor = false,
  children,
}: {
  modelId: number;
  minor?: boolean;
  children: (args: { onClick: () => void; isLoading: boolean }) => React.ReactElement;
}) {
  const queryUtils = trpc.useUtils();
  const { mutate, isPending: isLoading } = trpc.model.setMinor.useMutation({
    onSuccess: async (response, request) => {
      // `getById` is keyed on its full input (incl. `excludeTrainingData`), which this
      // component doesn't know; `.invalidate` matches by partial input so `{ id }` still hits
      // it, unlike `.setData`, which requires an exact key and was silently a no-op here.
      await Promise.all([
        queryUtils.model.getById.invalidate({ id: modelId }),
        queryUtils.model.getAll.invalidate(),
      ]);
      showSuccessNotification({
        message: request.minor ? 'Model set as minor' : 'Model unset as minor',
      });
    },
    onError: (error) => {
      showErrorNotification({ error: new Error(error.message), title: 'Failed to update model' });
    },
  });
  const onClick = () => mutate({ id: modelId, minor: !minor });
  return children({ onClick, isLoading });
}
