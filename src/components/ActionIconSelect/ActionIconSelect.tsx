import {
  ActionIcon,
  ActionIconProps,
  Input,
  Popover,
  createStyles,
  MantineSize,
  Box,
  Stack,
  Group,
  Text,
  TextInput,
  PopoverProps,
  Divider,
} from '@mantine/core';
import { getHotkeyHandler, useClickOutside } from '@mantine/hooks';
import { useEffect, useMemo, useState } from 'react';

export function ActionIconSelect<T>({
  items,
  onSelect,
  children,
  actionIconProps,
  ...popoverProps
}: {
  items: { label: string; value: T }[];
  onSelect: (item: T) => void;
  children: React.ReactNode;
  actionIconProps?: ActionIconProps;
} & Omit<PopoverProps, 'children'>) {
  const { classes, cx } = useDropdownContentStyles();
  const [active, setActive] = useState<number>();
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState<string>('');

  const [dropdown, setDropdown] = useState<HTMLDivElement | null>(null);
  const [control, setControl] = useState<HTMLDivElement | null>(null);
  const [toggle, setToggle] = useState<HTMLButtonElement | null>(null);

  useClickOutside(
    () => {
      setQuery('');
      setEditing(false);
    },
    null,
    [control, dropdown, toggle]
  );

  useEffect(() => {
    setActive(undefined);
  }, [items, editing]);

  const filteredData = useMemo(
    () => items.filter((x) => x.label.startsWith(query)),
    [items, query]
  );

  const handleUp = () => {
    if (!filteredData?.length) return;
    setActive((active) => {
      if (active === undefined) return 0;
      if (active > 0) return active - 1;
      return active;
    });
  };

  const handleDown = () => {
    if (!filteredData?.length) return;
    setActive((active) => {
      if (active === undefined) return 0;
      const lastIndex = filteredData.length - 1;
      if (active < lastIndex) return active + 1;
      return active;
    });
  };

  const handleEnter = () => {
    if (active) {
      const selected = filteredData[active];
      onSelect(selected.value);
    } else if (filteredData?.length === 1) {
      onSelect(filteredData[0].value);
    } else if (filteredData?.length && active === undefined) {
      const match = items?.find((x) => x.label === query);
      if (match) onSelect(match.value);
    }
    setEditing(false);
    setQuery('');
  };

  const handleClick = (index: number) => {
    if (!filteredData?.length) return;
    const selected = filteredData[index];
    onSelect(selected.value);
    setEditing(false);
    setQuery('');
  };

  return (
    <Popover opened={editing} position="bottom-start" shadow="lg" {...popoverProps}>
      <Popover.Target>
        <ActionIcon
          variant="outline"
          {...actionIconProps}
          ref={setToggle}
          onClick={() => setEditing((x) => !x)}
        >
          {children}
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown p={0}>
        <TextInput
          ref={setControl}
          variant="unstyled"
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
          styles={(theme) => ({
            input: {
              fontSize: 16,
              lineHeight: 1,
              padding: `${theme.spacing.xs}px ${theme.spacing.sm}px`,
              height: 'auto',
            },
          })}
          onKeyDown={getHotkeyHandler([
            ['Enter', handleEnter],
            ['ArrowUp', handleUp],
            ['ArrowDown', handleDown],
          ])}
        />
        <Divider />
        <Box style={{ width: 300, maxHeight: 400, overflowY: 'auto' }} ref={setDropdown}>
          {!!filteredData?.length && (
            <Stack spacing={0}>
              {filteredData.map((item, index) => (
                <Group
                  key={item.label}
                  className={cx({ [classes.active]: index === active })}
                  onMouseOver={() => setActive(index)}
                  onMouseLeave={() => setActive(undefined)}
                  onClick={() => handleClick(index)}
                  p="sm"
                >
                  <Text size="sm">{item.label}</Text>
                </Group>
              ))}
            </Stack>
          )}
        </Box>
      </Popover.Dropdown>
    </Popover>
  );
}

const useDropdownContentStyles = createStyles((theme) => ({
  active: {
    background: theme.colorScheme === 'dark' ? theme.colors.dark[7] : theme.colors.gray[0],
    cursor: 'pointer',
  },
}));
