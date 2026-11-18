import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

/**
 * The applicant's side of the `/apps/build` "Request access" flow: what became of their request.
 *
 * IMPERATIVE types, emitted by `decideAppAccessRequest` after its UPDATE has committed (through
 * `notifyAppAccessDecision`), never scanned by a scheduled `prepareQuery` — so each carries only a
 * `prepareMessage`, like the sibling `app-collaborator` family.
 *
 * The `type` strings are free-form text in the notifications app (no DB enum), so adding them needs
 * no migration. Registered in `utils.notifications.ts`. Both are `defaultEmail`, in lockstep with
 * `emailNotificationTypes` in `@civitai/notifications`: an applicant who is not on the site would
 * otherwise never learn the answer.
 */

export type AppAccessRequestNotificationDetails = {
  /** The decided request's id — the idempotency key's subject. */
  requestId: number;
  /** True when the decline took away access the person already had (approved → declined). */
  revoked?: boolean;
};

/** Where an approved applicant goes first: the App Developer Terms live on the submit page. */
export const APP_ACCESS_APPROVED_URL = '/apps/submit';
/** Where a declined applicant can see the outcome and ask again. */
export const APP_ACCESS_DECLINED_URL = '/apps/build';

export const appAccessRequestNotifications = createNotificationProcessor({
  'app-access-request-approved': {
    displayName: 'App builder access approved',
    category: NotificationCategory.System,
    toggleable: false,
    defaultEmail: true,
    prepareMessage: () => ({
      message:
        'Your request to build apps was approved and author access is on. Accept the App Developer Terms, then open Build to start your first app.',
      url: APP_ACCESS_APPROVED_URL,
    }),
  },
  'app-access-request-declined': {
    displayName: 'App builder access declined',
    category: NotificationCategory.System,
    toggleable: false,
    defaultEmail: true,
    prepareMessage: (notification) => {
      const details = notification.details as AppAccessRequestNotificationDetails;
      return {
        message: details.revoked
          ? 'Your access to build apps has been turned off. You can send a new request from Build.'
          : 'Your request to build apps was not approved this time. You can send a new request from Build.',
        url: APP_ACCESS_DECLINED_URL,
      };
    },
  },
});
