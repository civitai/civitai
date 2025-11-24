import { Card, Text, Button, Group, ActionIcon, Stack } from '@mantine/core';
import { IconGift, IconX } from '@tabler/icons-react';
import { NextLink } from '~/components/NextLink/NextLink';
import classes from './GiftNoticeAlert.module.scss';

interface GiftNoticeAlertProps {
  title: string;
  message: string;
  linkUrl: string;
  linkText: string;
  onClose?: () => void;
}

export function GiftNoticeAlert({
  title,
  message,
  linkUrl,
  linkText,
  onClose,
}: GiftNoticeAlertProps) {
  return (
    <Card className={classes.giftNotice} padding="md" radius="md" withBorder>
      <Stack gap="sm">
        <Group justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <IconGift size={24} className={classes.giftIcon} />
            <Text size="md" fw={600}>
              {title}
            </Text>
          </Group>
          {onClose && (
            <ActionIcon variant="subtle" color="gray" onClick={onClose} size="sm">
              <IconX size={16} />
            </ActionIcon>
          )}
        </Group>

        <Text size="sm" c="dimmed">
          {message}
        </Text>

        <Button
          component={NextLink}
          href={linkUrl}
          variant="light"
          size="sm"
          fullWidth
          target="_blank"
          rel="noopener noreferrer"
        >
          {linkText}
        </Button>
      </Stack>
    </Card>
  );
}
