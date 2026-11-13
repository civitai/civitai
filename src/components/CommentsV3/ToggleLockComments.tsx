import type { CommentSectionInput } from '~/server/schema/commentv3.schema';
import { trpc } from '~/utils/trpc';

type ToggleLockCommentsProps = CommentSectionInput & {
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

  const { data: lock } = trpc.commentv3.getSectionLock.useQuery({ entityId, entityType });

  const { mutate, isPending: isLoading } = trpc.commentv3.toggleSectionLock.useMutation({
    onMutate: async () => {
      queryUtils.commentv3.getSectionLock.setData({ entityId, entityType }, (old) => ({
        locked: !old?.locked,
      }));
    },
    onSuccess: () => {
      // The section read carries the lock too.
      void queryUtils.commentv3.invalidate();
      onSuccess?.();
    },
    onError: () => {
      void queryUtils.commentv3.getSectionLock.invalidate({ entityId, entityType });
    },
  });

  const handleClick = () => mutate({ entityId, entityType });
  const locked = lock?.locked ?? false;

  return children({ toggle: handleClick, isLoading, locked });
}
