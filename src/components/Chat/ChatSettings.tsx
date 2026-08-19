import {
  Anchor,
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
  UnstyledButton,
} from '@mantine/core';
import { IconArrowLeft, IconLock, IconX } from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import produce from 'immer';
import React from 'react';
import type { ChatSettingsScope } from '~/components/Chat/ChatProvider';
import { useChatStore } from '~/components/Chat/ChatProvider';
import { useChatTheme } from '~/components/Chat/useChatTheme';
import { useContainerSmallerThan } from '~/components/ContainerProvider/useContainerSmallerThan';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useDomainColor } from '~/hooks/useDomainColor';
import type { ChatDmPolicy, UserSettingsChat } from '~/server/schema/chat.schema';
import { DEFAULT_CHAT_SETTINGS } from '~/server/schema/chat.schema';
import type { ChatThemeSlug } from '~/shared/constants/chat-theme';
import { chatThemes } from '~/shared/constants/chat-theme';
import { ChatNotifyLevel } from '~/shared/utils/prisma/enums';
import { isApril1 } from '~/utils/date-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import classes from './Chat.module.scss';
import clsx from 'clsx';
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
                {
                  value: 'conversation',
                  label: (
                    <Group gap={6} wrap="nowrap" justify="center">
                      {otherMembers.length === 1 && (
                        <UserAvatar user={otherMembers[0].user} size="xs" />
                      )}
                      <span>{conversationName}</span>
                    </Group>
                  ),
                },
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
                        className={clsx(classes.option, {
                          [classes.selected]: option.value === myMember.notifyLevel,
                        })}
                      />
                    ))}
                  </Stack>
                </Radio.Group>
                <Text component="div" className={classes.previewStrip}>
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
                <Text component="div" className={classes.previewStrip}>
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
                className={clsx(classes.option, {
                  [classes.selected]: option.value === settings.dmPolicy,
                })}
              />
            ))}
          </Stack>
        </Radio.Group>
        <Text component="div" className={classes.previewStrip}>
          {dmPolicyPreview[settings.dmPolicy ?? 'everyone']} Changing this does not move
          conversations you already have.
        </Text>
      </SettingsGroup>

      <SettingsGroup title="Filtering">
        <SettingsSwitch
          label="Hold messages from brand-new accounts"
          description="Accounts under 7 days old land in Requests, never your inbox."
          checked={settings.holdNewAccounts ?? false}
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

      <SettingsGroup title="Appearance">
        <ChatThemePicker onChange={(theme) => update({ theme })} />
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

function ChatThemePicker({ onChange }: { onChange: (slug: ChatThemeSlug) => void }) {
  const { isMember, theme: rendered } = useChatTheme();
  const router = useRouter();
  // What the window is actually painted with, not what is stored: a lapsed
  // membership leaves the stored choice in place, and marking it selected would
  // claim a theme the reader is not looking at.
  const selected = rendered.slug;

  return (
    <>
      <Group gap={7} wrap="wrap" role="group" aria-label="Chat theme">
        {chatThemes.map((theme) => {
          const locked = !theme.free && !isMember;
          return (
            <UnstyledButton
              key={theme.slug}
              component={locked ? Link : undefined}
              href={locked ? `/pricing?returnUrl=${encodeURIComponent(router.asPath)}` : undefined}
              className={clsx(classes.themeOption, { [classes.themeLocked]: locked })}
              aria-pressed={selected === theme.slug}
              // Locked stays clickable on purpose: a disabled swatch is a dead
              // end, and the thing a non-member wants from it is the offer.
              title={locked ? `${theme.name} comes with a membership` : undefined}
              onClick={locked ? undefined : () => onChange(theme.slug)}
            >
              <span
                className={classes.themeSwatch}
                style={{
                  background: `linear-gradient(135deg, ${theme.swatch[0]} 62%, ${theme.swatch[1]} 62%)`,
                }}
              />
              {theme.name}
              {locked && <IconLock size={11} className={classes.themeLock} />}
            </UnstyledButton>
          );
        })}
      </Group>
      <Text component="div" className={classes.previewStrip}>
        Themes reskin <b>your</b> chat window only — the other side sees their own.{' '}
        {isMember ? (
          <>
            Everything past Civitai came with your membership, and reverts to Civitai if it lapses.
          </>
        ) : (
          <>
            Citron, Bubblegum and Terminal come with any{' '}
            <Anchor
              component={Link}
              href={`/pricing?returnUrl=${encodeURIComponent(router.asPath)}`}
            >
              membership
            </Anchor>
            .
          </>
        )}
      </Text>
    </>
  );
}

function SettingsGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Paper withBorder radius="md" p={0}>
      <Text component="div" className={classes.groupHead}>
        {title}
      </Text>
      <Stack gap="xs" px={13} py={11}>
        {children}
      </Stack>
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
