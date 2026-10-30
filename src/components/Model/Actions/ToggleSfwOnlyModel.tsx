import { useModeratorModelToggle } from '~/components/Model/Actions/useModeratorModelToggle';
import { trpc } from '~/utils/trpc';

export function ToggleSfwOnlyModel({
  modelId,
  sfwOnly = false,
  children,
}: {
  modelId: number;
  sfwOnly?: boolean;
  children: (args: { onClick: () => void; isLoading: boolean }) => React.ReactElement;
}) {
  const { mutate, isPending: isLoading } = trpc.model.setSfwOnly.useMutation(
    useModeratorModelToggle<{ id: number; sfwOnly: boolean }>({
      modelId,
      getSuccessMessage: (request) => {
        return request.sfwOnly ? 'Model set as SFW' : 'Model unset as SFW';
      },
      errorTitle: 'Failed to update model',
    })
  );
  const onClick = () => mutate({ id: modelId, sfwOnly: !sfwOnly });
  return children({ onClick, isLoading });
}
