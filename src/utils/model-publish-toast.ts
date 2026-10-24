import { ModelStatus } from '~/shared/utils/prisma/enums';
import { showSuccessNotification } from '~/utils/notifications';

// model.publish reports a hold through the returned status; version and private publishes through `held`.
export function notifyIfPublishHeld(
  result: { status?: ModelStatus; held?: boolean } | null | undefined
) {
  const held = result?.held === true || result?.status === ModelStatus.UnpublishedViolation;
  if (held) {
    showSuccessNotification({
      title: 'Submitted for review',
      message: 'A moderator will review it before it goes live.',
      autoClose: 6000,
    });
  }
  return held;
}
