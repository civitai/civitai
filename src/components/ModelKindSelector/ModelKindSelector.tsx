import { createStyles, Group, Menu, Text, useMantineTheme } from '@mantine/core';
import { IconChevronDown } from '@tabler/icons';
import { ModelKind } from '~/server/common/enums';
import { useCookies } from '~/providers/CookiesProvider';
import { constants } from '~/server/common/constants';
import { useFilters } from '~/components/InfiniteModels/InfiniteModelsFilters';

type ModelKindSelector<T extends string | number> = {
  label: React.ReactNode;
  options: { label: React.ReactNode; value: T }[];
  onClick: (value: T) => void;
  value?: T;
};

const kindOptions = Object.values(ModelKind);
export function ModelKindSelector() {
  const cookies = useCookies().models;
  const setKind = useFilters((state) => state.setKind);
  const kind = useFilters(
    (state) => state.filters.kind ?? cookies.kind ?? constants.modelFilterDefaults.kind
  );

  return (
    <SelectMenu
      label={kind}
      options={kindOptions.map((x) => ({ label: x, value: x }))}
      onClick={(kind) => setKind(kind)}
      value={kind}
    />
  );
}

// Copied from the component SelectMenu to adjust the font size
function SelectMenu<T extends string | number>({
  label,
  options,
  onClick,
  value,
}: ModelKindSelector<T>) {
  const { classes } = useStyles();
  const theme = useMantineTheme();

  return (
    <Menu withArrow>
      <Menu.Target>
        <Group spacing={6} className={classes.target}>
          <Text size="sm" weight={700} transform="uppercase">
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
