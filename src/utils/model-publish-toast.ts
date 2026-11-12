import { ModelStatus } from '~/shared/utils/prisma/enums';
import { showSuccessNotification } from '~/utils/notifications';

// model.publish reports a hold through the returned status; version and private publishes through `held`.
// A publish the pre-publish gate is still checking reports `prePublishGate: 'pending'`.
export function notifyIfPublishHeld(
  result:
    | { status?: ModelStatus; held?: boolean; prePublishGate?: 'pending' | 'held' }
    | null
    | undefined
) {
  if (result?.prePublishGate === 'pending') {
    showSuccessNotification({
      title: 'Checking your model',
      message:
        'It will publish automatically once the checks pass, at the time you picked if you scheduled it.',
      autoClose: 8000,
    });
    return true;
  }
  const held =
    result?.held === true ||
    result?.prePublishGate === 'held' ||
    result?.status === ModelStatus.UnpublishedViolation;
  if (held) {
    showSuccessNotification({
      title: 'Submitted for review',
      message: 'A moderator will review it before it goes live.',
      autoClose: 6000,
    });
  }
  return held;
}
