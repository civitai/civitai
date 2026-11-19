import {
  useEmailNotificationSettings,
  useToggleEmailSetting,
} from '~/components/Notifications/useNotificationSettings';
import { MISSED_DIGEST_EMAIL_TYPE } from '~/server/notifications/missed-digest.constants';

/**
 * State and setter for the weekly missed-notification digest email. On unless the user opted out;
 * the switch and the email's one-click unsubscribe write the same opt-out row.
 */
export function useDigestEmailSetting() {
  const { emailTypes, isLoading } = useEmailNotificationSettings();
  const emailMutation = useToggleEmailSetting();
  return {
    enabled: emailTypes.includes(MISSED_DIGEST_EMAIL_TYPE),
    isLoading,
    setEnabled: (enabled: boolean) =>
      emailMutation.mutate({ type: [MISSED_DIGEST_EMAIL_TYPE], enabled }),
  };
}
