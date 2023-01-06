import { Group, Menu, Text, createStyles, useMantineTheme } from '@mantine/core';
import { IconChevronDown } from '@tabler/icons';

type SelectMenu<T extends string | number> = {
  label: React.ReactNode;
  options: { label: React.ReactNode; value: T }[];
  onClick: (value?: T) => void;
  value?: T;
};

export function SelectMenu<T extends string | number>({
  label,
  options,
  onClick,
  value,
}: SelectMenu<T>) {
  const { classes } = useStyles();
  const theme = useMantineTheme();

  return (
    <Menu withArrow>
      <Menu.Target>
        <Group spacing={6} className={classes.target}>
          <Text weight={700} transform="uppercase">
            {label}
          </Text>
          <IconChevronDown size={16} stroke={3} />
        </Group>
      </Menu.Target>
      <Menu.Dropdown>
        {options.map((option) => (
          <Menu.Item key={option.value.toString()} onClick={() => onClick(option.value)}>
            <Text
              transform="uppercase"
              color={option.value === value ? theme.primaryColor : undefined}
              weight={option.value === value ? 700 : undefined}
            >
              {option.label}
            </Text>
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}

const useStyles = createStyles(() => ({
  target: {
    cursor: 'pointer',
  },
}));
