import { requestableLocks, type LockReviewModelFlags } from '@civitai/shared/lock-review';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { LockReviewDialog } from '~/components/Model/LockReview/LockReviewDialog';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { formatDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';

type LockReviewModel = LockReviewModelFlags & {
  id: number;
  user?: { id: number } | null;
  userId?: number;
};

/** Whether, and how, the owner of `model` is offered "Request moderator review". */
export function useLockReviewAction(model: LockReviewModel | undefined) {
  const currentUser = useCurrentUser();
  const ownerId = model?.user?.id ?? model?.userId;
  const show =
    !!model &&
    !!currentUser &&
    !currentUser.isModerator &&
    currentUser.id === ownerId &&
    requestableLocks(model).length > 0;

  const { data } = trpc.report.getLockReviewState.useQuery(
    { id: model?.id ?? 0 },
    { enabled: show }
  );
  const offered = show && !!data?.requestable.length;

  const reopensAt = data?.pending ? null : data?.reopensAt ?? null;
  const label = data?.pending
    ? 'Review requested'
    : reopensAt
    ? 'Review requested recently'
    : 'Request moderator review';
  const tooltip = data?.pending
    ? "A moderator hasn't reviewed your last request yet."
    : reopensAt
    ? `You can ask again on ${formatDate(reopensAt)}.`
    : undefined;

  return {
    show: offered,
    disabled: !!data?.pending || !!reopensAt,
    label,
    tooltip,
    open: () =>
      model && dialogStore.trigger({ component: LockReviewDialog, props: { modelId: model.id } }),
  };
}
