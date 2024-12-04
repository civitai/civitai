import { Popover, Stack, Group, ThemeIcon, Button, Text, PopoverProps } from '@mantine/core';
import { IconLock } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useState, cloneElement } from 'react';
import { create } from 'zustand';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { v4 as uuidv4 } from 'uuid';
import { NextLink as Link } from '~/components/NextLink/NextLink';

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
  ...props
}: {
  children: React.ReactElement;
  message?: React.ReactNode;
  dependency?: boolean;
} & PopoverProps) {
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
        {...props}
      >
        <Popover.Target>{cloneElement(children, { onClick: handleClick })}</Popover.Target>
        <Popover.Dropdown>
          <Stack spacing="xs">
            <Group noWrap>
              <ThemeIcon color="red" size="xl" variant="outline">
                <IconLock />
              </ThemeIcon>
              {message ?? (
                <Text size="sm" weight={500} sx={{ flex: 1 }}>
                  You must be logged in to perform this action
                </Text>
              )}
            </Group>

            <Link href={`/login?returnUrl=${router.asPath}`}>
              <Button size="xs">Login</Button>
            </Link>
          </Stack>
        </Popover.Dropdown>
      </Popover>
    );

  return cloneElement(children, {
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      e.nativeEvent.stopImmediatePropagation();
      children.props.onClick?.(e);
    },
  });
}
