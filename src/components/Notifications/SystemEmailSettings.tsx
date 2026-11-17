import { Checkbox, Stack } from '@mantine/core';
import {
  useEmailNotificationSettings,
  useToggleEmailSetting,
} from '~/components/Notifications/useNotificationSettings';
import { systemEmailNotificationTypes } from '~/server/notifications/utils.notifications';

/**
 * Email-only checkboxes for the email types that have no on-site toggle (app review outcomes, app
 * builder access decisions). Their on-site notice is always sent; only the email can be turned
 * off, here or by the email's one-click unsubscribe, which writes the same opt-out row.
 */
export function SystemEmailSettings() {
  const { emailTypes, isLoading } = useEmailNotificationSettings();
  const emailMutation = useToggleEmailSetting();
  if (systemEmailNotificationTypes.length === 0) return null;

  return (
    <Stack gap="xs">
      {systemEmailNotificationTypes.map(({ type, displayName }) => (
        <Checkbox
          key={type}
          size="sm"
          label={displayName}
          checked={emailTypes.includes(type)}
          disabled={isLoading}
          onChange={(e) => emailMutation.mutate({ type: [type], enabled: e.target.checked })}
        />
      ))}
    </Stack>
  );
}
