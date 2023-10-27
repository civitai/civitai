import { CommentConnectorInput } from '~/server/schema/commentv2.schema';
import produce from 'immer';
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
    onMutate: async () => {
      queryUtils.commentv2.getThreadDetails.setData(
        { entityId, entityType },
        produce((old) => {
          if (!old) return;
          old.locked = !old.locked;
        })
      );
    },
    onSuccess,
    onError: () => {
      queryUtils.commentv2.getThreadDetails.setData(
        { entityType, entityId },
        produce((old) => {
          if (!old) return;
          old.locked = !old.locked;
        })
      );
    },
  });

  const handleClick = () => mutate({ entityId, entityType });

  if (!thread) return null;

  return children({ toggle: handleClick, isLoading, locked: thread.locked });
}
