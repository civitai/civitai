import { useModeratorModelToggle } from '~/components/Model/Actions/useModeratorModelToggle';
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
  const { mutate, isPending: isLoading } = trpc.model.setMinor.useMutation(
    useModeratorModelToggle<{ id: number; minor: boolean }>({
      modelId,
      getSuccessMessage: (request) => (request.minor ? 'Model set as minor' : 'Model unset as minor'),
      errorTitle: 'Failed to update model',
    })
  );
  const onClick = () => mutate({ id: modelId, minor: !minor });
  return children({ onClick, isLoading });
}
