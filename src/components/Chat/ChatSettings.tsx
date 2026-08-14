import { Box, Divider, Group, Paper, Radio, ScrollArea, Stack, Switch, Text } from '@mantine/core';
import { IconArrowLeft, IconX } from '@tabler/icons-react';
import React from 'react';
import { useChatStore } from '~/components/Chat/ChatProvider';
import { useContainerSmallerThan } from '~/components/ContainerProvider/useContainerSmallerThan';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useDomainColor } from '~/hooks/useDomainColor';
import type { ChatDmPolicy, UserSettingsChat } from '~/server/schema/chat.schema';
import { DEFAULT_CHAT_SETTINGS } from '~/server/schema/chat.schema';
import { isApril1 } from '~/utils/date-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const dmPolicyOptions: { value: ChatDmPolicy; label: string; description: string }[] = [
  {
    value: 'everyone',
    label: 'Everyone',
    description: 'Anyone on Civitai can start a conversation with you.',
  },
  {
    value: 'following',
    label: 'People I follow',
    description: 'Everyone else is sent to Requests instead of your inbox.',
  },
  {
    value: 'mutuals',
    label: 'Mutuals only',
    description: 'People you and they follow each other. Everyone else goes to Requests.',
  },
  {
    value: 'nobody',
    label: 'No one',
    description: 'Nobody can start a new conversation with you.',
  },
];

const dmPolicyPreview: Record<ChatDmPolicy, string> = {
  everyone: 'Someone you have never met can message you and it lands in your inbox.',
  following: 'Only people you follow reach your inbox. Everyone else waits in Requests.',
  mutuals: 'Only people you follow who follow you back reach your inbox.',
  nobody: 'Nobody can open a new conversation with you.',
};

export function ChatSettings() {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();
  const isMobile = useContainerSmallerThan(700);
  const domainColor = useDomainColor();

  const { data } = trpc.chat.getUserSettings.useQuery(undefined, { enabled: !!currentUser });
  const settings = { ...DEFAULT_CHAT_SETTINGS, ...data };

  const { mutate } = trpc.chat.setUserSettings.useMutation({
    onMutate(input) {
      const previous = queryUtils.chat.getUserSettings.getData();
      queryUtils.chat.getUserSettings.setData(undefined, (old) =>
        old ? { ...old, ...input } : old
      );
      return { previous };
    },
    onSuccess(result) {
      queryUtils.chat.getUserSettings.setData(undefined, () => result);
    },
    onError(error, _input, context) {
      queryUtils.chat.getUserSettings.setData(undefined, () => context?.previous);
      showErrorNotification({
        title: 'Failed to update settings.',
        error: new Error(error.message),
        autoClose: false,
      });
    },
  });

  const update = (input: UserSettingsChat) => mutate(input);
  const close = () => useChatStore.setState({ isSettingsOpen: false });

  return (
    <Stack gap={0} h="100%">
      <Group p="sm" justify="space-between" align="center">
        <Group gap="xs">
          {isMobile && (
            <LegacyActionIcon onClick={close} aria-label="Back">
              <IconArrowLeft />
            </LegacyActionIcon>
          )}
          <Text>Chat settings</Text>
        </Group>
        {!isMobile && (
          <LegacyActionIcon onClick={close} aria-label="Close settings">
            <IconX />
          </LegacyActionIcon>
        )}
      </Group>
      <Divider />

      <ScrollArea h="100%">
        <Stack p="sm" gap="md">
          <SettingsGroup title="Who can message me">
            <Radio.Group
              value={settings.dmPolicy}
              onChange={(value) => update({ dmPolicy: value as ChatDmPolicy })}
            >
              <Stack gap={4}>
                {dmPolicyOptions.map((option) => (
                  <Radio
                    key={option.value}
                    value={option.value}
                    label={option.label}
                    description={option.description}
                    className="rounded p-2 hover:bg-gray-1 dark:hover:bg-dark-6"
                  />
                ))}
              </Stack>
            </Radio.Group>
            <Text size="xs" c="dimmed" mt="xs">
              {dmPolicyPreview[settings.dmPolicy ?? 'everyone']} Changing this does not move
              conversations you already have.
            </Text>
          </SettingsGroup>

          <SettingsGroup title="Filtering">
            <SettingsSwitch
              label="Hold messages from brand-new accounts"
              description="Accounts under 7 days old land in Requests, never your inbox."
              checked={settings.holdNewAccounts ?? true}
              onChange={(checked) => update({ holdNewAccounts: checked })}
            />
            {domainColor !== 'green' && (
              <SettingsSwitch
                label="Hide offensive words"
                description="Blurs flagged words in messages until you tap them."
                checked={settings.replaceBadWords ?? false}
                onChange={(checked) => update({ replaceBadWords: checked })}
              />
            )}
          </SettingsGroup>

          <SettingsGroup title="Notifications">
            <SettingsSwitch
              label="Message sounds"
              description={
                isApril1() && !settings.muteSounds
                  ? 'No muting for senpai! 🥰'
                  : 'Play a sound when a message arrives.'
              }
              checked={!settings.muteSounds}
              disabled={isApril1() && !settings.muteSounds}
              onChange={(checked) => update({ muteSounds: !checked })}
            />
          </SettingsGroup>
        </Stack>
      </ScrollArea>
    </Stack>
  );
}

function SettingsGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Paper withBorder radius="md" p="sm">
      <Text size="xs" tt="uppercase" fw={600} c="dimmed" mb="xs">
        {title}
      </Text>
      <Stack gap="xs">{children}</Stack>
    </Paper>
  );
}

function SettingsSwitch({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Group wrap="nowrap" align="flex-start" justify="space-between" gap="sm">
      <Box>
        <Text size="sm">{label}</Text>
        <Text size="xs" c="dimmed">
          {description}
        </Text>
      </Box>
      <Switch
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
        aria-label={label}
      />
    </Group>
  );
}
