import { Button, Popover, SimpleGrid, Stack, Text, ThemeIcon } from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import { IconBrandX } from '@tabler/icons-react';
import React from 'react';
import dynamic from 'next/dynamic';
import { SocialIconChat } from '~/components/ShareButton/Icons/SocialIconChat';
import { SocialIconCollect } from '~/components/ShareButton/Icons/SocialIconCollect';
import { SocialIconCopy } from '~/components/ShareButton/Icons/SocialIconCopy';
import { SocialIconOther } from '~/components/ShareButton/Icons/SocialIconOther';
import { SocialIconReddit } from '~/components/ShareButton/Icons/SocialIconReddit';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { CollectItemInput } from '~/server/schema/collection.schema';
import { QS } from '~/utils/qs';
import { useTrackEvent } from '../TrackView/track.utils';
import { requireLogin } from '~/components/Login/requireLogin';
import { openAddToCollectionModal } from '~/components/Dialog/triggers/add-to-collection';
import { createDialogTrigger } from '~/components/Dialog/dialogStore';

const ChatShareModal = dynamic(() => import('~/components/Chat/ChatShareModal'), {
  ssr: false,
});
const openChatShareModal = createDialogTrigger(ChatShareModal);

export function ShareButton({
  children,
  url: initialUrl,
  title,
  collect,
}: {
  children: React.ReactElement;
  url?: string;
  title?: string;
  collect?: CollectItemInput;
}) {
  const clipboard = useClipboard({ timeout: undefined });
  // const { requireLogin } = useLoginRedirect({ reason: 'add-to-collection' });
  const features = useFeatureFlags();
  const { trackShare } = useTrackEvent();

  const url =
    typeof window === 'undefined'
      ? ''
      : !initialUrl
      ? location.href
      : `${location.protocol}//${location.host}${initialUrl}`;

  // https://web.dev/web-share/
  const shareLinks: {
    type: string;
    onClick: (e: React.MouseEvent) => void;
    render: React.ReactNode;
  }[] = [
    {
      type: clipboard.copied ? 'Copied' : 'Copy Url',
      onClick: () => {
        trackShare({ platform: 'clipboard', url });
        clipboard.copy(url);
      },
      render: <SocialIconCopy copied={clipboard.copied} />,
    },
    {
      type: 'Reddit',
      onClick: () => {
        trackShare({ platform: 'reddit', url });
        window.open(`https://www.reddit.com/submit?${QS.stringify({ url, title })}`);
      },
      render: <SocialIconReddit />,
    },
    {
      type: 'X',
      onClick: () => {
        trackShare({ platform: 'twitter', url });
        window.open(
          `https://twitter.com/intent/tweet?${QS.stringify({
            url,
            text: title,
            via: 'HelloCivitai',
          })}`
        );
      },
      render: (
        <ThemeIcon variant="filled" color="#000" size={60} radius="xl">
          <IconBrandX size={30} />
        </ThemeIcon>
      ),
    },
    {
      type: 'Other',
      onClick: () => navigator.share({ url, title }),
      render: <SocialIconOther />,
    },
  ];

  if (features.chat) {
    shareLinks.unshift({
      type: 'Send Chat',
      onClick: (e: React.MouseEvent) =>
        requireLogin({ uiEvent: e, cb: () => openChatShareModal({ props: { message: url } }) }),
      render: <SocialIconChat />,
    });
  }

  if (collect && features.collections) {
    shareLinks.unshift({
      type: 'Save',
      onClick: (e: React.MouseEvent) =>
        requireLogin({
          uiEvent: e,
          reason: 'add-to-collection',
          cb: () => openAddToCollectionModal({ props: collect }),
        }),
      render: <SocialIconCollect />,
    });
  }

  return (
    <Popover withArrow shadow="md" position="top-end" width={320}>
      <Popover.Target>{children}</Popover.Target>
      <Popover.Dropdown>
        <Stack>
          <Text fw={500}>Share</Text>
          <SimpleGrid cols={3}>
            {shareLinks.map(({ type, onClick, render }) => (
              <Button
                key={type}
                variant="subtle"
                color="gray"
                style={{ height: 'auto' }}
                p={0}
                onClick={onClick}
              >
                <Stack gap={6} align="center" p={6}>
                  <div style={{ height: 60, width: 60 }}>{render}</div>
                  {type}
                </Stack>
              </Button>
            ))}
          </SimpleGrid>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
