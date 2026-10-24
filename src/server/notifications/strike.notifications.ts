import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const strikeNotifications = createNotificationProcessor({
  'strike-issued': {
    displayName: 'Strike Issued',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message:
        details.points > 1
          ? `You have received a strike: ${details.description}. This counts as ${details.points} strike points.`
          : `You have received a strike: ${details.description}.`,
      // TODO: add url once /user/account#strikes UI exists
    }),
  },
  'strike-voided': {
    displayName: 'Strike Removed',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: `A strike on your account has been removed: ${details.voidReason}`,
      // TODO: add url once /user/account#strikes UI exists
    }),
  },
  'strike-escalation-muted': {
    displayName: 'Account Muted',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message:
        details.muteDays === 'indefinite'
          ? 'Your account has been muted due to accumulated strikes and is pending review. Please review our Terms of Service.'
          : // No duration: this tier ends on re-acceptance, not on a timer.
            'Your account has been muted due to accumulated strikes. Review and accept our Terms of Service to lift it — you will be asked the next time you try to post or comment.',
      // TODO: add url once /user/account#strikes UI exists
    }),
  },
  'strike-expired': {
    displayName: 'Strike Expired',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: () => ({
      message: 'A strike on your account has expired. Your account standing has improved.',
      // TODO: add url once /user/account#strikes UI exists
    }),
  },
  'strike-de-escalation-unmuted': {
    displayName: 'Account Unmuted',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: () => ({
      message:
        'Your account mute has been lifted as your strike points have decreased. Please continue to follow our Terms of Service.',
      // TODO: add url once /user/account#strikes UI exists
    }),
  },
});
