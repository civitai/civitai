import { Button, Card, Stack, Text } from '@mantine/core';
import type { Icon } from '@tabler/icons-react';
import {
  IconBrandInstagram,
  IconBrandTwitch,
  IconBrandVimeo,
  IconBrandX,
  IconBrandYoutube,
  IconChartBar,
  IconShieldLock,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { useThirdPartyConsent } from './consent.context';

export type ConsentEmbedKind =
  | 'youtube'
  | 'instagram'
  | 'strawpoll'
  | 'twitter'
  | 'twitch'
  | 'vimeo'
  | 'generic';

const KIND_LABELS: Record<ConsentEmbedKind, string> = {
  youtube: 'YouTube',
  instagram: 'Instagram',
  strawpoll: 'StrawPoll',
  twitter: 'X (Twitter)',
  twitch: 'Twitch',
  vimeo: 'Vimeo',
  generic: 'third-party',
};

const KIND_ICONS: Record<ConsentEmbedKind, Icon> = {
  youtube: IconBrandYoutube,
  instagram: IconBrandInstagram,
  strawpoll: IconChartBar,
  twitter: IconBrandX,
  twitch: IconBrandTwitch,
  vimeo: IconBrandVimeo,
  generic: IconShieldLock,
};

type Props = {
  kind: ConsentEmbedKind;
  className?: string;
};

export function ConsentBlockedEmbed({ kind, className }: Props) {
  const { accept } = useThirdPartyConsent();
  const label = KIND_LABELS[kind];
  const Icon = KIND_ICONS[kind];

  return (
    <Card
      withBorder
      radius="md"
      p="md"
      className={clsx('flex h-full min-h-32 items-center justify-center', className)}
    >
      <Stack gap="xs" align="center" ta="center" maw={420}>
        <Icon size={32} />
        <Text fw={600} size="sm">
          {label} content blocked
        </Text>
        <Text size="xs" c="dimmed">
          This embed is blocked because {label} sets third-party cookies and trackers to load its
          content. We need your consent before loading it.
        </Text>
        <Button size="xs" onClick={accept} mt={4}>
          Accept third-party cookies and load
        </Button>
      </Stack>
    </Card>
  );
}
