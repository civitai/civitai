import { Popover, Stack, Group, ThemeIcon, Button, Text } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { NextLink } from '@mantine/next';
import { IconLock } from '@tabler/icons';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/router';
import React from 'react';
import { useSfwContext } from './sfwContext';
import { useSfwStore } from './sfwStore';

export function SfwToggle({ children }: { children: React.ReactElement }) {
  const { nsfw, type, id } = useSfwContext();
  const { data: session } = useSession();
  const [opened, { close, open }] = useDisclosure(false);
  const isAuthenticated = !!session?.user;
  const router = useRouter();

  const toggleShow = useSfwStore(
    (state) => state[type === 'model' ? 'toggleModel' : 'toggleReview']
  );

  const child = nsfw
    ? React.cloneElement(children, {
        onClick: (e: React.MouseEvent<HTMLElement, MouseEvent>) => {
          e.stopPropagation();
          e.preventDefault();
          e.nativeEvent.stopImmediatePropagation();
          if (isAuthenticated) toggleShow(id);
          else opened ? close() : open();
        },
      })
    : children;

  const popover = (
    <Popover
      width={300}
      position="bottom"
      opened={opened}
      withArrow
      closeOnClickOutside
      withinPortal
    >
      <Popover.Target>{child}</Popover.Target>
      <Popover.Dropdown>
        <Stack spacing="xs">
          <Group>
            <ThemeIcon color="red" size="xl" variant="outline">
              <IconLock />
            </ThemeIcon>
            <Text size="sm" weight={500} sx={{ flex: 1 }}>
              You must be logged in to view NSFW content
            </Text>
          </Group>

          <Button size="xs" component={NextLink} href={`/login?returnUrl=${router.asPath}`}>
            Login
          </Button>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );

  return !isAuthenticated && nsfw ? popover : child;
}
