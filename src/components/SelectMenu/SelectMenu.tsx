import {
  Group,
  Menu,
  Text,
  createStyles,
  useMantineTheme,
  MenuProps,
  Button,
  Drawer,
  Stack,
  UnstyledButton,
} from '@mantine/core';
import { IconCheck, IconChevronDown, IconFilter, IconSortDescending } from '@tabler/icons-react';
import { useState } from 'react';
import { useIsMobile } from '~/hooks/useIsMobile';

type SelectMenu<T extends string | number> = {
  label: React.ReactNode;
  options: { label: React.ReactNode; value: T }[];
  onClick: (value: T) => void;
  value?: T;
  disabled?: boolean;
  children?: React.ReactNode;
};

export function SelectMenu<T extends string | number>({
  label,
  options,
  onClick,
  value,
  disabled,
  children,
}: SelectMenu<T>) {
  const { classes } = useStyles();
  const theme = useMantineTheme();

  return (
    <Menu withArrow disabled={disabled}>
      <Menu.Target>
        <Group
          spacing={6}
          className={classes.target}
          style={disabled ? { opacity: 0.3, cursor: 'default', userSelect: 'none' } : {}}
        >
          <Text weight={700} transform="uppercase">
            {label}
          </Text>
          <IconChevronDown size={16} stroke={3} />
        </Group>
      </Menu.Target>
      <Menu.Dropdown>
        <>
          {options.map((option) => (
            <Menu.Item key={option.value.toString()} onClick={() => onClick(option.value)}>
              <Text
                transform="uppercase"
                ta="center"
                color={option.value === value ? theme.primaryColor : undefined}
                weight={option.value === value ? 700 : undefined}
              >
                {option.label}
              </Text>
            </Menu.Item>
          ))}
          {children}
        </>
      </Menu.Dropdown>
    </Menu>
  );
}

const useStyles = createStyles((theme) => ({
  target: {
    cursor: 'pointer',
  },
  item: {
    '&[data-hovered]': {
      borderRadius: theme.radius.md,
    },
  },
  opened: {
    transform: 'rotate(180deg)',
    transition: 'transform 200ms ease',
  },

  activeOption: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[0],
    borderRadius: theme.radius.md,
  },

  option: {
    padding: '10px 12px',
  },
}));

export function SelectMenuV2<T extends string | number>({
  label,
  options,
  onClick,
  value,
  disabled,
  children,
}: SelectMenu<T>) {
  const { classes, theme, cx } = useStyles();
  const [opened, setOpened] = useState(false);
  const mobile = useIsMobile();

  const target = (
    <Button
      color="gray"
      radius="xl"
      variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
      disabled={disabled}
      rightIcon={<IconChevronDown className={cx({ [classes.opened]: opened })} size={16} />}
      onClick={() => setOpened((o) => !o)}
    >
      <Group spacing={4} noWrap>
        <IconSortDescending size={16} />
        {label}
      </Group>
    </Button>
  );

  if (mobile)
    return (
      <>
        {target}
        <Drawer
          position="bottom"
          opened={opened}
          onClose={() => setOpened(false)}
          styles={{ body: { padding: 16 }, drawer: { height: 'auto' } }}
          withCloseButton={false}
        >
          <Stack spacing={8}>
            {options.map((option) => {
              const active = option.value === value;

              return (
                <UnstyledButton
                  key={option.value.toString()}
                  className={cx(classes.option, { [classes.activeOption]: active })}
                  onClick={() => {
                    onClick(option.value);
                    setOpened(false);
                  }}
                >
                  <Group position="apart">
                    <Text inline>{option.label}</Text>
                    {active && (
                      <Text color={theme.primaryColor} inline>
                        <IconCheck size={16} color="currentColor" />
                      </Text>
                    )}
                  </Group>
                </UnstyledButton>
              );
            })}
          </Stack>
        </Drawer>
      </>
    );

  return (
    <Menu
      classNames={classes}
      position="bottom-end"
      shadow="md"
      radius={12}
      width={256}
      onChange={setOpened}
      disabled={disabled}
    >
      <Menu.Target>{target}</Menu.Target>
      <Menu.Dropdown p={8}>
        <>
          {options.map((option) => {
            const active = option.value === value;

            return (
              <Menu.Item
                key={option.value.toString()}
                onClick={() => onClick(option.value)}
                data-hovered={`${active}`}
                rightSection={
                  active && (
                    <Text color={theme.primaryColor} inline>
                      <IconCheck size={16} color="currentColor" />
                    </Text>
                  )
                }
              >
                <Group position="apart" spacing={8}>
                  {option.label}
                </Group>
              </Menu.Item>
            );
          })}
          {children}
        </>
      </Menu.Dropdown>
    </Menu>
  );
}
