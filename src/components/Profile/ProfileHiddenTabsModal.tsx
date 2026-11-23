import { Button, Group, Modal, Paper, Stack, Switch, Text } from '@mantine/core';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import type {
  PrivacySettingsSchema,
  ProfileHideableTab,
} from '~/server/schema/user-profile.schema';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export type ProfileHiddenTabsModalProps = {
  userId: number;
  username: string;
  privacySettings: PrivacySettingsSchema | null | undefined;
  /** The hideable tabs this profile shows, in nav order. */
  tabs: { key: ProfileHideableTab; label: string }[];
};

export default function ProfileHiddenTabsModal({
  userId,
  username,
  privacySettings,
  tabs,
}: ProfileHiddenTabsModalProps) {
  const dialog = useDialogContext();
  const utils = trpc.useUtils();
  const storedHidden = privacySettings?.hiddenTabs ?? [];
  const [hidden, setHidden] = useState(() => new Set<ProfileHideableTab>(storedHidden));

  const mutation = trpc.userProfile.update.useMutation({
    onSuccess: async () => {
      await utils.userProfile.get.invalidate({ username });
      dialog.onClose();
    },
    onError: (error) =>
      showErrorNotification({
        title: 'Could not save your profile tabs',
        error: new Error(error.message),
      }),
  });

  const toggle = (key: ProfileHideableTab, visible: boolean) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (visible) next.delete(key);
      else next.add(key);
      return next;
    });

  const handleSave = () => {
    const listed = new Set(tabs.map((tab) => tab.key));
    // A tab missing from the list today (say, achievements while the count is 0) keeps its choice.
    const hiddenTabs = [
      ...storedHidden.filter((key) => !listed.has(key)),
      ...tabs.filter((tab) => hidden.has(tab.key)).map((tab) => tab.key),
    ];
    mutation.mutate({ userId, privacySettings: { ...privacySettings, hiddenTabs } });
  };

  return (
    <Modal {...dialog} title="Profile tabs">
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          Hidden tabs are taken out of your profile&apos;s navigation for visitors. They are not
          private: anyone with the link can still open them. Overview and Shop always show.
        </Text>
        <Stack gap="xs">
          {tabs.map((tab) => (
            <Paper key={tab.key} withBorder radius="md" p="sm">
              <Group justify="space-between" wrap="nowrap" gap="sm">
                <Text size="sm" fw={600} className="capitalize">
                  {tab.label}
                </Text>
                <Switch
                  checked={!hidden.has(tab.key)}
                  onChange={(e) => toggle(tab.key, e.currentTarget.checked)}
                  aria-label={`Show ${tab.label}`}
                />
              </Group>
            </Paper>
          ))}
        </Stack>
        <Group justify="flex-end">
          <Button variant="default" onClick={dialog.onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={mutation.isPending}>
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
