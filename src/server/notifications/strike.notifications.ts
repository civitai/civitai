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
          ? `You have received a strike: ${details.description}. View your account standing for details. This counts as ${details.points} strike points.`
          : `You have received a strike: ${details.description}. View your account standing for details.`,
      url: '/user/account#strikes',
    }),
  },
  'strike-voided': {
    displayName: 'Strike Removed',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: `A strike on your account has been removed: ${details.voidReason}`,
      url: '/user/account#strikes',
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
          : `Your account has been temporarily muted for ${details.muteDays} days due to accumulated strikes. Please review our Terms of Service.`,
      url: '/user/account#strikes',
    }),
  },
  'strike-expired': {
    displayName: 'Strike Expired',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: () => ({
      message: 'A strike on your account has expired. Your account standing has improved.',
      url: '/user/account#strikes',
    }),
  },
  'strike-de-escalation-unmuted': {
    displayName: 'Account Unmuted',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: () => ({
      message:
        'Your account mute has been lifted as your strike points have decreased. Please continue to follow our Terms of Service.',
      url: '/user/account#strikes',
    }),
  },
});
