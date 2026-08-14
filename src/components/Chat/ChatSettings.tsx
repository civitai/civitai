import {
  Box,
  Divider,
  Group,
  Paper,
  Radio,
  ScrollArea,
  SegmentedControl,
  Stack,
  Switch,
  Text,
} from '@mantine/core';
import { IconArrowLeft, IconX } from '@tabler/icons-react';
import produce from 'immer';
import React from 'react';
import type { ChatSettingsScope } from '~/components/Chat/ChatProvider';
import { useChatStore } from '~/components/Chat/ChatProvider';
import { useContainerSmallerThan } from '~/components/ContainerProvider/useContainerSmallerThan';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useDomainColor } from '~/hooks/useDomainColor';
import type { ChatDmPolicy, UserSettingsChat } from '~/server/schema/chat.schema';
import { DEFAULT_CHAT_SETTINGS } from '~/server/schema/chat.schema';
import { ChatNotifyLevel } from '~/shared/utils/prisma/enums';
import { isApril1 } from '~/utils/date-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

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

const notifyLevelOptions: { value: ChatNotifyLevel; label: string; description: string }[] = [
  {
    value: ChatNotifyLevel.All,
    label: 'Everything',
    description: 'Notify me for every message in this conversation.',
  },
  {
    value: ChatNotifyLevel.Mentions,
    label: 'Only when mentioned',
    description: 'Made for groups — stay in the thread, hear about it only when named.',
  },
  {
    value: ChatNotifyLevel.None,
    label: 'Nothing',
    description: 'Silent. The conversation still appears in your inbox.',
  },
];

export function ChatSettings() {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();
  const isMobile = useContainerSmallerThan(700);
  const domainColor = useDomainColor();
  const existingChatId = useChatStore((state) => state.existingChatId);
  const settingsScope = useChatStore((state) => state.settingsScope);

  const { data } = trpc.chat.getUserSettings.useQuery(undefined, { enabled: !!currentUser });
  const settings = { ...DEFAULT_CHAT_SETTINGS, ...data };

  const { data: chats } = trpc.chat.getAllByUser.useQuery(undefined, { enabled: !!currentUser });
  const chat = chats?.find((c) => c.id === existingChatId);
  const myMember = chat?.chatMembers.find((cm) => cm.userId === currentUser?.id);
  const otherMembers = chat?.chatMembers.filter((cm) => cm.userId !== currentUser?.id) ?? [];
  const conversationName =
    otherMembers.length === 1
      ? otherMembers[0]?.user.username ?? 'This conversation'
      : 'This group';

  // The conversation scope has nothing to hang off once the chat closes.
  const scope = myMember ? settingsScope : 'global';

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

  const { mutate: modifyMembership } = trpc.chat.modifyUser.useMutation({
    onSuccess(result, req) {
      queryUtils.chat.getAllByUser.setData(
        undefined,
        produce((old) => {
          const tMember = old
            ?.find((c) => c.id === existingChatId)
            ?.chatMembers.find((cm) => cm.userId === result.userId);
          if (!tMember) return old;

          if (isDefined(req.notifyLevel)) tMember.notifyLevel = result.notifyLevel;
          if (isDefined(req.isPinned)) tMember.pinnedAt = result.pinnedAt;
        })
      );
    },
    onError(error) {
      showErrorNotification({
        title: 'Failed to update conversation settings.',
        error: new Error(error.message),
        autoClose: false,
      });
    },
  });

  const update = (input: UserSettingsChat) => mutate(input);
  const close = () => useChatStore.setState({ isSettingsOpen: false });
  const setScope = (next: ChatSettingsScope) => useChatStore.setState({ settingsScope: next });

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
          {!!myMember && (
            <SegmentedControl
              value={scope}
              onChange={(value) => setScope(value as ChatSettingsScope)}
              fullWidth
              data={[
                { value: 'global', label: 'Global' },
                { value: 'conversation', label: conversationName },
              ]}
            />
          )}

          {scope === 'conversation' && !!myMember ? (
            <>
              <SettingsGroup title={`Notifications from ${conversationName}`}>
                <Radio.Group
                  value={myMember.notifyLevel}
                  onChange={(value) =>
                    modifyMembership({
                      chatMemberId: myMember.id,
                      notifyLevel: value as ChatNotifyLevel,
                    })
                  }
                >
                  <Stack gap={4}>
                    {notifyLevelOptions.map((option) => (
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
                  This overrides your global notification settings for this conversation only.
                </Text>
              </SettingsGroup>

              <SettingsGroup title="This conversation">
                <SettingsSwitch
                  label="Pin to top"
                  description="Keeps this conversation above the others in your list."
                  checked={!!myMember.pinnedAt}
                  onChange={(checked) =>
                    modifyMembership({ chatMemberId: myMember.id, isPinned: checked })
                  }
                />
                <Text size="xs" c="dimmed">
                  Report, archive and delete live in the conversation&apos;s ⋯ menu.
                </Text>
              </SettingsGroup>
            </>
          ) : (
            <GlobalChatSettings
              settings={settings}
              update={update}
              showBadWords={domainColor !== 'green'}
            />
          )}
        </Stack>
      </ScrollArea>
    </Stack>
  );
}

function GlobalChatSettings({
  settings,
  update,
  showBadWords,
}: {
  settings: UserSettingsChat;
  update: (input: UserSettingsChat) => void;
  showBadWords: boolean;
}) {
  return (
    <>
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
        {showBadWords && (
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
    </>
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
