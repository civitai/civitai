import { CommentConnectorInput } from '~/server/schema/commentv2.schema';
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
  const queryUtils = trpc.useContext();
  const { data: thread } = trpc.commentv2.getThreadDetails.useQuery({
    entityId,
    entityType,
  });
  const { mutate, isLoading } = trpc.commentv2.toggleLockThread.useMutation({
    onSuccess: async () => {
      await queryUtils.commentv2.getThreadDetails.invalidate({ entityType, entityId });
      onSuccess?.();
    },
  });

  const handleClick = () => mutate({ entityId, entityType });

  if (!thread) return null;

  return children({ toggle: handleClick, isLoading, locked: thread.locked });
}
