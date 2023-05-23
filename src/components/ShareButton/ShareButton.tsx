import {
  ActionIcon,
  Group,
  Popover,
  TextInput,
  CopyButton,
  Stack,
  Text,
  Button,
} from '@mantine/core';
import { useRouter } from 'next/router';
import { useIsMobile } from '~/hooks/useIsMobile';
import { IconClipboard, IconClipboardCheck } from '@tabler/icons';
import React from 'react';
import { QS } from '~/utils/qs';
import { SocialIconReddit } from '~/components/ShareButton/Icons/SocialIconReddit';
import { SocialIconTwitter } from '~/components/ShareButton/Icons/SocialIconTwitter';

export function ShareButton({
  children,
  url: initialUrl,
  title,
}: {
  children: React.ReactElement;
  url: string;
  title?: string;
}) {
  const router = useRouter();
  const isMobile = useIsMobile();
  const origin =
    typeof window !== 'undefined' && window.location.origin ? window.location.origin : '';
  const url = `${origin}${initialUrl ?? router.asPath}`;

  return isMobile ? (
    <MobileShare url={url} title={title}>
      {children}
    </MobileShare>
  ) : (
    <DesktopShare url={url} title={title}>
      {children}
    </DesktopShare>
  );
}

type ShareProps = {
  url: string;
  title?: string;
};

function DesktopShare({ children, url, title }: { children: React.ReactElement } & ShareProps) {
  return (
    <Popover position="bottom" withArrow width="100%" styles={{ dropdown: { maxWidth: 400 } }}>
      <Popover.Target>{children}</Popover.Target>
      <Popover.Dropdown>
        <Stack>
          <Text weight={500}>Share</Text>
          <Group spacing="xs">
            {getShareLinks({ url, title }).map(({ type, url, Icon }) => (
              <Button
                key={type}
                variant="subtle"
                color="gray"
                sx={{ height: 'auto' }}
                p={0}
                onClick={() => window.open(url)}
              >
                <Stack spacing={6} align="center" p={6}>
                  <div style={{ height: 60 }}>
                    <Icon />
                  </div>
                  {type}
                </Stack>
              </Button>
            ))}
          </Group>
          <Group spacing="xs" noWrap>
            <TextInput type="text" style={{ flex: 1 }} value={url} readOnly />
            <CopyButton value={url}>
              {(clipboard) =>
                !clipboard.copied ? (
                  <ActionIcon variant="default" size="lg" onClick={clipboard.copy}>
                    <IconClipboard size={20} />
                  </ActionIcon>
                ) : (
                  <ActionIcon variant="filled" color="green" size="lg">
                    <IconClipboardCheck size={20} />
                  </ActionIcon>
                )
              }
            </CopyButton>
          </Group>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

function MobileShare({ children, url, title }: { children: React.ReactElement } & ShareProps) {
  const handleClick = (e?: React.MouseEvent) => {
    e?.preventDefault();
    // https://web.dev/web-share/
    navigator.share({
      url,
      title,
    });
  };
  return React.cloneElement(children, { onClick: handleClick });
}

const getShareLinks = ({ url, title }: ShareProps) => [
  {
    type: 'Reddit',
    url: `https://www.reddit.com/submit?${QS.stringify({
      url,
      title,
    })}`,
    Icon: SocialIconReddit,
  },
  {
    type: 'Twitter',
    url: `https://twitter.com/intent/tweet?${QS.stringify({
      url,
      text: title,
      via: 'HelloCivitai',
    })}`,
    Icon: SocialIconTwitter,
  },
];
