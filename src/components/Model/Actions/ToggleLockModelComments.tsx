import { trpc } from '~/utils/trpc';

export function ToggleLockModelComments({
  modelId,
  locked = false,
  children,
}: {
  modelId: number;
  locked?: boolean;
  children: (args: { onClick: () => void; isLoading: boolean }) => React.ReactElement;
}) {
  const queryUtils = trpc.useUtils();
  const { mutate, isLoading } = trpc.model.toggleLockComments.useMutation({
    onSuccess: (response, request) => {
      queryUtils.model.getById.setData({ id: modelId }, (old) => {
        if (!old) return old;
        return { ...old, meta: { ...old.meta, commentsLocked: !old.meta?.commentsLocked } };
      });
    },
  });
  const onClick = () => mutate({ id: modelId, locked: !locked });
  return children({ onClick, isLoading });
}
