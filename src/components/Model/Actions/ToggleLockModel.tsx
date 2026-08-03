import { useModeratorModelToggle } from '~/components/Model/Actions/useModeratorModelToggle';
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
  const { mutate, isPending: isLoading } = trpc.model.toggleLock.useMutation(
    useModeratorModelToggle<{ id: number; locked: boolean }>({
      modelId,
      getSuccessMessage: (request) =>
        request.locked ? 'Model discussion locked' : 'Model discussion unlocked',
      errorTitle: 'Failed to update model',
    })
  );
  const onClick = () => mutate({ id: modelId, locked: !locked });
  return children({ onClick, isLoading });
}
