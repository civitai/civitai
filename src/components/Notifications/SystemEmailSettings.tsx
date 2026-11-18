import { Stack } from '@mantine/core';
import { EmailToggle } from '~/components/Notifications/NotificationTypeControl';
import { systemEmailNotificationTypes } from '~/server/notifications/utils.notifications';

/**
 * Email-only checkboxes for the email types that have no on-site toggle (app review outcomes, app
 * builder access decisions). Their on-site notice is always sent; only the email can be turned
 * off, here or by the email's one-click unsubscribe, which writes the same opt-out row.
 */
export function SystemEmailSettings() {
  if (systemEmailNotificationTypes.length === 0) return null;

  return (
    <Stack gap="xs">
      {systemEmailNotificationTypes.map(({ type, displayName }) => (
        <EmailToggle key={type} type={type} label={displayName} size="sm" />
      ))}
    </Stack>
  );
}
