import { Badge, Button, Group, Modal, Stack, Text, ThemeIcon } from '@mantine/core';
import {
  IconBellRinging,
  IconBolt,
  IconBriefcase,
  IconCalendarEvent,
  IconMessageCircle,
} from '@tabler/icons-react';
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { MobileMenuDrawer } from '~/components/Drawer/MobileMenuDrawer';
import type { PushPromptVariant } from '~/components/Notifications/pushPrompt';
import { usePushPromptActions } from '~/components/Notifications/pushPrompt';
import type { PushPromptRow } from '~/components/Notifications/pushPromptRows';
import { PUSH_PROMPT_ROWS, rowsForPushTypes } from '~/components/Notifications/pushPromptRows';
import { usePushSubscription } from '~/components/Notifications/usePushSubscription';
import { useIsMobile } from '~/hooks/useIsMobile';
import { trpc } from '~/utils/trpc';

const rowIcons: Record<PushPromptRow['key'], typeof IconBolt> = {
  replies: IconMessageCircle,
  tips: IconBolt,
  services: IconBriefcase,
  events: IconCalendarEvent,
};

/** The visit prompt itself; loaded only once PushOptInPrompt decides to show it. */
export default function PushOptInDialog({
  variant,
  onDone,
}: {
  variant: PushPromptVariant;
  onDone: () => void;
}) {
  const isMobile = useIsMobile({ type: 'media' });
  const platform = isMobile ? 'mobile' : 'desktop';
  const { busy } = usePushSubscription();
  const { track, notNow, enable } = usePushPromptActions('visit-prompt', variant, platform);
  const closed = useRef(false);
  const { data: pushTypes } = trpc.notification.getPushSettings.useQuery(undefined, {
    enabled: variant === 'another-device',
  });

  useEffect(() => {
    track('shown');
  }, [track]);

  // X, Escape and the overlay count as "Not now"; enable() spends the budget itself when it should.
  const close = ({ spend }: { spend: boolean }) => {
    // Turning on is in flight: closing now would spend a dismissal on a yes.
    if (closed.current || busy) return;
    closed.current = true;
    if (spend) notNow();
    onDone();
  };

  const turnOn = async () => {
    await enable();
    closed.current = true;
    onDone();
  };

  const device = isMobile ? 'phone' : 'browser';
  const rows =
    variant === 'another-device'
      ? pushTypes
        ? rowsForPushTypes(pushTypes)
        : []
      : PUSH_PROMPT_ROWS;

  const content = (
    <Stack gap="md">
      <ThemeIcon size={44} radius="xl" variant="light">
        <IconBellRinging size={24} />
      </ThemeIcon>
      <Stack gap={4}>
        <Text fw={700} size="lg">
          {variant === 'another-device'
            ? `Also get them on this ${device}?`
            : 'Get notified even when Civitai is closed'}
        </Text>
        <Text size="sm" c="dimmed">
          {variant === 'another-device'
            ? `You already get push notifications on another device.${
                rows.length ? " Here's what you get pushed:" : ''
              }`
            : `Turn on push notifications on this ${device}. Here's what we'd send you:`}
        </Text>
      </Stack>
      {rows.length > 0 && (
        <Stack gap="xs" component="ul" className="m-0 list-none p-0">
          {rows.map((row) => {
            const Icon = rowIcons[row.key];
            return (
              <Group
                key={row.key}
                component="li"
                gap="sm"
                wrap="nowrap"
                align="flex-start"
                className="rounded-md bg-gray-1 px-3 py-2 dark:bg-dark-5"
              >
                <Icon size={20} className="mt-0.5 shrink-0" />
                <div>
                  <Text size="sm" fw={600}>
                    {row.label}
                    {'isNew' in row && row.isNew && (
                      <Badge size="xs" color="yellow" variant="filled" ml={6}>
                        New
                      </Badge>
                    )}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {row.description}
                  </Text>
                </div>
              </Group>
            );
          })}
        </Stack>
      )}
      <Text size="xs" c="dimmed">
        You can switch any of these off, or add others, in{' '}
        <Text
          component={Link}
          href="/user/account#notification-settings"
          c="blue"
          inherit
          onClick={() => close({ spend: false })}
        >
          Notification settings
        </Text>
        . Never more than 20 a day.
      </Text>
      <Group
        justify="flex-end"
        gap="xs"
        className={isMobile ? 'flex-col-reverse items-stretch' : ''}
      >
        <Button
          variant="subtle"
          color="gray"
          onClick={() => close({ spend: true })}
          fullWidth={isMobile}
        >
          Not now
        </Button>
        <Button loading={busy} onClick={turnOn} fullWidth={isMobile}>
          {variant === 'finish' ? 'Finish turning on' : 'Turn on notifications'}
        </Button>
      </Group>
    </Stack>
  );

  if (isMobile)
    return (
      <MobileMenuDrawer
        opened
        onClose={() => close({ spend: true })}
        withCloseButton={false}
        closeOnClickOutside={!busy}
        closeOnEscape={!busy}
      >
        {content}
      </MobileMenuDrawer>
    );
  return (
    <Modal
      opened
      onClose={() => close({ spend: true })}
      size="sm"
      centered
      radius="md"
      closeOnClickOutside={!busy}
      closeOnEscape={!busy}
      withCloseButton={!busy}
    >
      {content}
    </Modal>
  );
}
