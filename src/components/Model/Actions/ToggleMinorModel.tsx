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
    onSuccess: (response, request) => {
      queryUtils.model.getById.setData({ id: modelId }, (old) => {
        if (!old) return old;
        return { ...old, minor: request.minor };
      });
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
