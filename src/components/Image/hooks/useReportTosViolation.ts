import TosViolationDialog from '~/components/Dialog/Common/TosViolationDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { TOS_REASONS } from '~/server/common/tos-reasons';
import { trpc } from '~/utils/trpc';
import { imageStore } from '~/store/image.store';
import { showErrorNotification, showWarningNotification } from '~/utils/notifications';
import { formatDate } from '~/utils/date-helpers';

const reasonLabel = (value: string | null) =>
  TOS_REASONS.find((r) => r.value === value)?.label ?? value;

export function useReportTosViolation() {
  const utils = trpc.useUtils();
  const { mutateAsync } = trpc.image.setTosViolation.useMutation({
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Could not report review, please try again',
      });
    },
  });

  return async function ({ imageId }: { imageId: number }) {
    // Shown before the moderator acts: a removal for the reason that appeal overturned is held for a
    // second moderator rather than applied.
    const appeal = await utils.image.getApprovedAppeal.fetch({ id: imageId }).catch(() => null);
    const appealNote = appeal
      ? `This image's appeal was approved on ${formatDate(appeal.approvedAt)}${
          appeal.approvedByUsername ? ` by ${appeal.approvedByUsername}` : ''
        }${
          appeal.removalLabel
            ? `, overturning a removal for ${reasonLabel(appeal.removalLabel)}`
            : ''
        }. Removing it for the same reason needs a second moderator to confirm.`
      : null;

    dialogStore.trigger({
      component: TosViolationDialog,
      props: {
        title: 'Remove as TOS Violation',
        message: appealNote
          ? `${appealNote} Otherwise the uploader will be notified that their image was removed.`
          : 'The uploader will be notified that their image was removed.',
        onConfirm: async (violationType, violationDetails) => {
          const result = await mutateAsync({ id: imageId, violationType, violationDetails });
          if (result.held) {
            showWarningNotification({
              title: 'Not removed: sent for a second opinion',
              message: `This image's appeal was approved on ${formatDate(
                result.held.approvedAt
              )}, so a second moderator must confirm the removal. ${
                result.held.created ? 'It is now' : 'It was already'
              } waiting on Re-removals in the moderator app.`,
              autoClose: false,
            });
            return;
          }
          imageStore.setImage(imageId, { tosViolation: true });
        },
      },
    });
  };
}
