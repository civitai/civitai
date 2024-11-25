import { Popover, Stack, Group, ThemeIcon, Button, Text } from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { IconLock } from '@tabler/icons-react';
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

export function JoinPopover({
  children,
  message,
  dependency = true,
  trigger = 'onClick',
}: {
  children: React.ReactElement;
  message?: React.ReactNode;
  dependency?: boolean;
  trigger?: 'onClick' | 'onChange';
}) {
  const [uuid] = useState(uuidv4());
  const user = useCurrentUser();
  const isMember = user?.isMember;

  const opened = useStore((state) => state.keys[uuid]);
  const toggleKey = useStore((state) => state.toggleKey);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    e.nativeEvent.stopImmediatePropagation();
    toggleKey(uuid);
  };

  if (!isMember && dependency)
    return (
      <Popover
        width={300}
        position="bottom"
        opened={opened}
        withArrow
        closeOnClickOutside
        withinPortal
      >
        <Popover.Target>{cloneElement(children, { [trigger]: handleClick })}</Popover.Target>
        <Popover.Dropdown>
          <Stack spacing="xs">
            <Group>
              <ThemeIcon color="red" size="xl" variant="outline">
                <IconLock />
              </ThemeIcon>
              {typeof message != 'string' ? (
                message
              ) : (
                <Text size="sm" weight={500} sx={{ flex: 1 }}>
                  {message ?? 'You must be a Member to access this content.'}
                </Text>
              )}
            </Group>

            <Button size="xs" component={Link} href={`/pricing`}>
              Join Now
            </Button>
          </Stack>
        </Popover.Dropdown>
      </Popover>
    );

  return cloneElement(children, {
    [trigger]: (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      e.nativeEvent.stopImmediatePropagation();
      children.props[trigger]?.(e);
    },
  });
}
