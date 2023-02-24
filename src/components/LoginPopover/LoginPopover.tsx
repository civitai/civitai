import { Popover, Stack, Group, ThemeIcon, Button, Text } from '@mantine/core';
import { NextLink } from '@mantine/next';
import { IconLock } from '@tabler/icons';
import { useRouter } from 'next/router';
import { useState, cloneElement } from 'react';
import { create } from 'zustand';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { v4 as uuidv4 } from 'uuid';

type StoreProps = {
  keys: Record<string, boolean>;
  toggleKey: (key: string) => void;
};

const useStore = create<StoreProps>((set, get) => ({
  keys: {},
  toggleKey: (key) => {
    const current = get().keys[key];
    set(() => ({ keys: { [key]: !current } }));
  },
}));

// TODO.maintenance - determine if this would be better as a global modal

export function LoginPopover({
  children,
  message,
  dependency = true,
}: {
  children: React.ReactElement;
  message?: React.ReactNode;
  dependency?: boolean;
}) {
  const [uuid] = useState(uuidv4());
  const user = useCurrentUser();
  const isAuthenticated = !!user;
  const router = useRouter();

  const opened = useStore((state) => state.keys[uuid]);
  const toggleKey = useStore((state) => state.toggleKey);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    e.nativeEvent.stopImmediatePropagation();
    toggleKey(uuid);
  };

  if (!isAuthenticated && dependency)
    return (
      <Popover
        width={300}
        position="bottom"
        opened={opened}
        withArrow
        closeOnClickOutside
        withinPortal
      >
        <Popover.Target>{cloneElement(children, { onClick: handleClick })}</Popover.Target>
        <Popover.Dropdown>
          <Stack spacing="xs">
            <Group>
              <ThemeIcon color="red" size="xl" variant="outline">
                <IconLock />
              </ThemeIcon>
              {message ?? (
                <Text size="sm" weight={500} sx={{ flex: 1 }}>
                  You must be logged in to perform this action
                </Text>
              )}
            </Group>

            <Button size="xs" component={NextLink} href={`/login?returnUrl=${router.asPath}`}>
              Login
            </Button>
          </Stack>
        </Popover.Dropdown>
      </Popover>
    );

  return cloneElement(children, {
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      e.nativeEvent.stopImmediatePropagation();
      children.props.onClick?.();
    },
  });
}
