import type { CommentConnectorInput } from '~/server/schema/commentv2.schema';
import { trpc } from '~/utils/trpc';

type ToggleLockCommentsProps = CommentConnectorInput & {
  children: ({
    isLoading,
    locked,
    toggle,
  }: {
    isLoading: boolean;
    locked?: boolean;
    toggle: () => void;
  }) => React.ReactElement;
  onSuccess?: () => void;
};

export function ToggleLockComments({
  children,
  entityId,
  entityType,
  onSuccess,
}: ToggleLockCommentsProps) {
  const queryUtils = trpc.useUtils();

  // Use dedicated getThreadDetails for thread metadata
  const { data: threadMeta } = trpc.commentv2.getThreadDetails.useQuery({
    entityId,
    entityType,
  });

  const { mutate, isLoading } = trpc.commentv2.toggleLockThread.useMutation({
    onMutate: async () => {
      queryUtils.commentv2.getThreadDetails.setData({ entityId, entityType }, (old) => {
        if (!old) return { id: -1, locked: true, hiddenCount: 0 };
        return { ...old, locked: !old.locked };
      });
    },
    onSuccess: () => {
      queryUtils.commentv2.getThreadDetails.invalidate({ entityId, entityType });
      onSuccess?.();
    },
    onError: () => {
      queryUtils.commentv2.getThreadDetails.setData({ entityType, entityId }, (old) => {
        if (!old || old.id === -1) return null;
        return { ...old, locked: !old.locked };
      });
    },
  });

  const handleClick = () => mutate({ entityId, entityType });
  const locked = threadMeta?.locked ?? false;

  return children({ toggle: handleClick, isLoading, locked });
}
