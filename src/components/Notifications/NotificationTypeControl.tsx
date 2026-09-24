import { Checkbox, Group, SegmentedControl, Text } from '@mantine/core';
import {
  useToggleNotificationSetting,
  useTogglePushSetting,
} from '~/components/Notifications/useNotificationSettings';

type ControlValue = 'off' | 'on' | 'push';

/**
 * The per-type control both settings surfaces render. Until push permission exists in this browser
 * (`pushAvailable`), it stays the familiar two-way checkbox; after that it becomes Off / On / Push.
 * Kept in one component so the two surfaces can't drift on the three-state transition logic.
 */
export function NotificationTypeControl({
  type,
  displayName,
  checked,
  pushOn,
  pushAvailable,
  disabled,
}: {
  type: string;
  displayName: string;
  /** In-app notifications enabled for this type. */
  checked: boolean;
  /** A UserPushSetting row exists for this type. */
  pushOn: boolean;
  /** Push permission granted + subscription live in this browser. */
  pushAvailable: boolean;
  disabled?: boolean;
}) {
  const toggleMutation = useToggleNotificationSetting();
  const pushMutation = useTogglePushSetting();

  if (!pushAvailable) {
    return (
      <Checkbox
        label={displayName}
        checked={checked}
        disabled={disabled}
        onChange={(e) => toggleMutation.mutate({ toggle: e.target.checked, type: [type] })}
      />
    );
  }

  const value: ControlValue = !checked ? 'off' : pushOn ? 'push' : 'on';
  const setValue = (next: string) => {
    if (next === value) return;
    if (next === 'off') {
      toggleMutation.mutate({ toggle: false, type: [type] });
      if (pushOn) pushMutation.mutate({ type: [type], enabled: false });
    } else if (next === 'on') {
      if (!checked) toggleMutation.mutate({ toggle: true, type: [type] });
      if (pushOn) pushMutation.mutate({ type: [type], enabled: false });
    } else {
      if (!checked) toggleMutation.mutate({ toggle: true, type: [type] });
      if (!pushOn) pushMutation.mutate({ type: [type], enabled: true });
    }
  };

  return (
    <Group justify="space-between" wrap="nowrap" gap="xs">
      <Text size="sm">{displayName}</Text>
      <SegmentedControl
        size="xs"
        value={value}
        onChange={setValue}
        disabled={disabled}
        data={[
          { label: 'Off', value: 'off' },
          { label: 'On', value: 'on' },
          { label: 'Push', value: 'push' },
        ]}
      />
    </Group>
  );
}
