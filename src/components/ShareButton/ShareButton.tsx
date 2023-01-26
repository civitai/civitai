import { ActionIcon, Group, Popover, TextInput, CopyButton } from '@mantine/core';
import { useRouter } from 'next/router';
import { useIsMobile } from '~/hooks/useIsMobile';
import { IconClipboard, IconClipboardCheck } from '@tabler/icons';
import React from 'react';

export function ShareButton({
  children,
  url: initialUrl,
  title,
}: {
  children: React.ReactElement;
  url?: string;
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
    <DesktopShare url={url}>{children}</DesktopShare>
  );
}

function DesktopShare({ children, url }: { children: React.ReactElement; url: string }) {
  return (
    <Popover position="bottom" withArrow width="100%">
      <Popover.Target>{children}</Popover.Target>
      <Popover.Dropdown>
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
      </Popover.Dropdown>
    </Popover>
  );
}

function MobileShare({
  children,
  url,
  title,
}: {
  children: React.ReactElement;
  url: string;
  title?: string;
}) {
  const handleClick = (e?: React.MouseEvent) => {
    e?.preventDefault();
    // https://web.dev/web-share/
    navigator.share({
      title,
      url,
    });
  };
  return React.cloneElement(children, { onClick: handleClick });
}
