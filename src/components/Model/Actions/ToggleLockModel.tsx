import { trpc } from '~/utils/trpc';

export function ToggleLockModel({
  modelId,
  locked = false,
  children,
}: {
  modelId: number;
  locked?: boolean;
  children: (args: { onClick: () => void; isLoading: boolean }) => React.ReactElement;
}) {
  const queryUtils = trpc.useContext();
  const { mutate, isLoading } = trpc.model.toggleLock.useMutation({
    onSuccess: (response, request) => {
      queryUtils.model.getById.setData({ id: modelId }, (old) => {
        if (!old) return old;
        return { ...old, locked: request.locked };
      });
    },
  });
  const onClick = () => mutate({ id: modelId, locked: !locked });
  return children({ onClick, isLoading });
}
