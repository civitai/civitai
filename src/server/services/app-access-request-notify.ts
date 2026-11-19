import type { AppAccessRequestNotificationDetails } from '~/server/notifications/app-access-request.notifications';

/**
 * Tells the applicant what a moderator decided on their Apps access request.
 *
 * Same discipline as `blocks/app-collaborator-notify`: the only static import is a TYPE, and
 * `createNotification` + `NotificationCategory` are imported dynamically, so the access-request
 * service's tests never load the notifications client. A test asserting emission mocks THIS module.
 *
 * The caller runs it after the decision has committed and catches what it throws, so a failed
 * notification never fails or undoes a decision.
 */
export async function notifyAppAccessDecision(opts: {
  userId: number;
  requestId: number;
  decision: 'approved' | 'declined';
  revoked: boolean;
}): Promise<void> {
  const [{ createNotification }, { NotificationCategory }] = await Promise.all([
    import('~/server/services/notification.service'),
    import('~/server/common/enums'),
  ]);
  const details: AppAccessRequestNotificationDetails = {
    requestId: opts.requestId,
    ...(opts.revoked ? { revoked: true } : {}),
  };
  await createNotification({
    userId: opts.userId,
    category: NotificationCategory.System,
    type: `app-access-request-${opts.decision}`,
    // One per request per outcome: approve then revoke are two notifications, a retry is one.
    key: `app-access-request-${opts.decision}:${opts.requestId}`,
    details,
  });
}
