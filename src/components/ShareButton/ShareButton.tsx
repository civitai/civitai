import { Group, Popover, Stack, Text, Button } from '@mantine/core';
import React from 'react';
import { QS } from '~/utils/qs';
import { SocialIconReddit } from '~/components/ShareButton/Icons/SocialIconReddit';
import { SocialIconTwitter } from '~/components/ShareButton/Icons/SocialIconTwitter';
import { SocialIconCopy } from '~/components/ShareButton/Icons/SocialIconCopy';
import { useClipboard } from '@mantine/hooks';
import { SocialIconOther } from '~/components/ShareButton/Icons/SocialIconOther';
import { SocialIconCollect } from '~/components/ShareButton/Icons/SocialIconCollect';
import { CollectItemInput } from '~/server/schema/collection.schema';
import { openContext } from '~/providers/CustomModalsProvider';
import { useLoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

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
  const { requireLogin } = useLoginRedirect({ reason: 'add-to-collection' });
  const features = useFeatureFlags();

  const url =
    typeof window === 'undefined'
      ? ''
      : !initialUrl
      ? location.href
      : `${location.protocol}//${location.host}${initialUrl}`;

  // https://web.dev/web-share/
  const shareLinks = [
    {
      type: clipboard.copied ? 'Copied' : 'Copy Url',
      onClick: () => clipboard.copy(url),
      render: <SocialIconCopy copied={clipboard.copied} />,
    },
    {
      type: 'Reddit',
      onClick: () => window.open(`https://www.reddit.com/submit?${QS.stringify({ url, title })}`),
      render: <SocialIconReddit />,
    },
    {
      type: 'Twitter',
      onClick: () =>
        window.open(
          `https://twitter.com/intent/tweet?${QS.stringify({
            url,
            text: title,
            via: 'HelloCivitai',
          })}`
        ),
      render: <SocialIconTwitter />,
    },
    {
      type: 'Other',
      onClick: () => navigator.share({ url, title }),
      render: <SocialIconOther />,
    },
  ];

  if (collect && features.collections) {
    shareLinks.unshift({
      type: 'Save',
      onClick: () => requireLogin(() => openContext('addToCollection', collect)),
      render: <SocialIconCollect />,
    });
  }

  return (
    <Popover withArrow shadow="md" position="top-end" width={360}>
      <Popover.Target>{children}</Popover.Target>
      <Popover.Dropdown>
        <Stack>
          <Text weight={500}>Share</Text>
          <Group spacing="xs">
            {shareLinks.map(({ type, onClick, render }) => (
              <Button
                key={type}
                variant="subtle"
                color="gray"
                sx={{ height: 'auto' }}
                p={0}
                onClick={onClick}
              >
                <Stack spacing={6} align="center" p={6}>
                  <div style={{ height: 60, width: 60 }}>{render}</div>
                  {type}
                </Stack>
              </Button>
            ))}
          </Group>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
