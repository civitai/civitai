import type { AppCollaboratorNotificationDetails } from '~/server/notifications/app-collaborator.notifications';

/**
 * App Listing COLLABORATORS — seat/transfer notification emit helper.
 *
 * Identical discipline to the sibling `app-block-notify` / `app-listing-notify`
 * helpers: the ONLY static import is a TYPE (erased at compile), and
 * `createNotification` + `NotificationCategory` are DYNAMICALLY imported inside the
 * async body — so importing this adds ZERO runtime graph to a caller, and the
 * collaborator service's unit tests never pull the notifications client. A test that
 * asserts emission mocks THIS module; a test that asserts the swallow mocks
 * `~/server/services/notification.service`.
 *
 * Every call site is POST-COMMIT and wrapped in the caller's own try/catch, so even a
 * defect that made this throw cannot fail or roll back a seat decision.
 */

export type AppCollaboratorNotificationType =
  | 'app-collaborator-invited'
  | 'app-collaborator-accepted'
  | 'app-collaborator-removed'
  | 'app-ownership-transfer-offered'
  | 'app-ownership-transfer-accepted';

export async function notifyAppCollaborator(opts: {
  type: AppCollaboratorNotificationType;
  userId: number;
  /** Idempotency key — dedups repeat emissions of the same event to the same user. */
  key: string;
  details: AppCollaboratorNotificationDetails;
}): Promise<void> {
  const [{ createNotification }, { NotificationCategory }] = await Promise.all([
    import('~/server/services/notification.service'),
    import('~/server/common/enums'),
  ]);
  await createNotification({
    userId: opts.userId,
    category: NotificationCategory.System,
    type: opts.type,
    key: opts.key,
    details: opts.details,
  });
}
