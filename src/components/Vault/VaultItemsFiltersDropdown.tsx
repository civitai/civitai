import type { ButtonProps } from '@mantine/core';
import {
  Popover,
  Group,
  Indicator,
  Stack,
  Divider,
  Chip,
  Button,
  Drawer,
  Text,
  useMantineTheme,
} from '@mantine/core';
import { IconFilter } from '@tabler/icons-react';
import { getDisplayName } from '~/utils/string-helpers';
import { useCallback, useState } from 'react';
import { useIsMobile } from '~/hooks/useIsMobile';
import { TagSort } from '~/server/common/enums';
import type { GetPaginatedVaultItemsSchema } from '~/server/schema/vault.schema';
import { ModelType } from '~/shared/utils/prisma/enums';
import { DatePicker } from '@mantine/dates';
import { trpc } from '~/utils/trpc';
import { constants } from '~/server/common/constants';
import { FilterButton } from '~/components/Buttons/FilterButton';
import { FilterChip } from '~/components/Filters/FilterChip';

type Filters = Omit<GetPaginatedVaultItemsSchema, 'limit'>;

export function VaultItemsFiltersDropdown({ filters, setFilters, ...buttonProps }: Props) {
  const mobile = useIsMobile();
  const theme = useMantineTheme();
  const { data: { items: categories } = { items: [] } } = trpc.tag.getAll.useQuery({
    entityType: ['Model'],
    sort: TagSort.MostModels,
    unlisted: false,
    categories: true,
    limit: 100,
  });

  const [opened, setOpened] = useState(false);
  const filterLength =
    (filters.types?.length ?? 0) +
    (filters.categories?.length ?? 0) +
    (filters.baseModels?.length ?? 0) +
    (filters.dateCreatedFrom ? 1 : 0) +
    (filters.dateCreatedTo ? 1 : 0) +
    (filters.dateAddedFrom ? 1 : 0) +
    (filters.dateAddedTo ? 1 : 0);

  const clearFilters = useCallback(
    () =>
      setFilters({
        types: undefined,
        categories: undefined,
        dateCreatedFrom: undefined,
        dateCreatedTo: undefined,
        dateAddedFrom: undefined,
        dateAddedTo: undefined,
      }),
    [setFilters]
  );

  const target = (
    <Indicator
      offset={4}
      label={filterLength ? filterLength : undefined}
      size={16}
      zIndex={10}
      showZero={false}
      dot={false}
      inline
    >
      <FilterButton
        icon={IconFilter}
        size="md"
        variant="default"
        active={opened}
        onClick={() => setOpened((o) => !o)}
      >
        Filters
      </FilterButton>
    </Indicator>
  );

  const dropdown = (
    <Stack spacing="xs">
      <Stack spacing="xs">
        <Divider label="Type" labelProps={{ weight: 'bold', size: 'sm' }} />
        <Chip.Group
          spacing={8}
          value={filters.types ?? []}
          onChange={(types: ModelType[]) => {
            setFilters({
              types,
            });
          }}
          multiple
        >
          {Object.values(ModelType).map((type, index) => (
            <FilterChip key={index} value={type}>
              <span>{getDisplayName(type)}</span>
            </FilterChip>
          ))}
        </Chip.Group>
        <Divider label="Category" labelProps={{ weight: 'bold', size: 'sm' }} />
        <Chip.Group
          spacing={8}
          value={filters.categories ?? []}
          onChange={(categories: string[]) => {
            setFilters({
              categories,
            });
          }}
          multiple
        >
          {categories.map((category) => (
            <FilterChip key={category.id} value={category.name}>
              <Text component="span" transform="capitalize">
                {getDisplayName(category.name)}
              </Text>
            </FilterChip>
          ))}
        </Chip.Group>
        <Divider label="Base Model" labelProps={{ weight: 'bold', size: 'sm' }} />
        <Chip.Group
          spacing={8}
          value={filters.baseModels ?? []}
          onChange={(baseModels: string[]) => {
            setFilters({
              baseModels,
            });
          }}
          multiple
        >
          {constants.baseModels.map((baseModel) => (
            <FilterChip key={baseModel} value={baseModel}>
              <Text component="span" transform="capitalize">
                {baseModel}
              </Text>
            </FilterChip>
          ))}
        </Chip.Group>
        <Divider label="Created at" labelProps={{ weight: 'bold', size: 'sm' }} />
        <Group grow>
          <DatePicker
            label="From"
            placeholder="From"
            value={filters.dateCreatedFrom}
            onChange={(date) => {
              setFilters({ dateCreatedFrom: date ?? undefined });
            }}
            maxDate={filters.dateCreatedTo ?? undefined}
            clearButtonLabel="Clear"
            radius="xl"
          />
          <DatePicker
            label="To"
            placeholder="To"
            value={filters.dateCreatedTo}
            onChange={(date) => {
              setFilters({ dateCreatedTo: date ?? undefined });
            }}
            minDate={filters.dateCreatedFrom ?? undefined}
            clearButtonLabel="Clear"
            radius="xl"
          />
        </Group>
        <Divider label="Added at" labelProps={{ weight: 'bold', size: 'sm' }} />
        <Group grow>
          <DatePicker
            label="From"
            placeholder="From"
            value={filters.dateAddedFrom}
            onChange={(date) => {
              setFilters({ dateAddedFrom: date ?? undefined });
            }}
            maxDate={filters.dateAddedTo ?? undefined}
            clearButtonLabel="Clear"
            radius="xl"
          />
          <DatePicker
            label="To"
            placeholder="To"
            value={filters.dateAddedTo}
            onChange={(date) => {
              setFilters({ dateAddedTo: date ?? undefined });
            }}
            minDate={filters.dateAddedFrom ?? undefined}
            clearButtonLabel="Clear"
            radius="xl"
          />
        </Group>
      </Stack>
      {filterLength > 0 && (
        <Button
          color="gray"
          variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
          onClick={clearFilters}
          fullWidth
        >
          Clear all filters
        </Button>
      )}
    </Stack>
  );

  if (mobile)
    return (
      <>
        {target}
        <Drawer
          opened={opened}
          onClose={() => setOpened(false)}
          size="90%"
          position="bottom"
          styles={{
            drawer: {
              height: 'auto',
              maxHeight: 'calc(100dvh - var(--header-height))',
              overflowY: 'auto',
            },
            body: { padding: 16, paddingTop: 0, overflowY: 'auto' },
            header: { padding: '4px 8px' },
            closeButton: { height: 32, width: 32, '& > svg': { width: 24, height: 24 } },
          }}
        >
          {dropdown}
        </Drawer>
      </>
    );

  return (
    <Popover
      zIndex={200}
      position="bottom-end"
      shadow="md"
      radius={12}
      onClose={() => setOpened(false)}
      middlewares={{ flip: true, shift: true }}
    >
      <Popover.Target>{target}</Popover.Target>
      <Popover.Dropdown maw={700} p="md" w="100%">
        {dropdown}
      </Popover.Dropdown>
    </Popover>
  );
}

type Props = {
  setFilters: (filters: Partial<Filters>) => void;
  filters: Filters;
} & Omit<ButtonProps, 'onClick' | 'children' | 'rightIcon'>;

// const useStyles = createStyles((theme) => ({
//   label: {
//     fontSize: 12,
//     fontWeight: 600,

//     '&[data-checked]': {
//       '&, &:hover': {
//         color: theme.colorScheme === 'dark' ? theme.white : theme.black,
//         border: `1px solid ${theme.colors[theme.primaryColor][theme.fn.primaryShade()]}`,
//       },

//       '&[data-variant="filled"]': {
//         backgroundColor: 'transparent',
//       },
//     },
//   },
//   opened: {
//     transform: 'rotate(180deg)',
//     transition: 'transform 200ms ease',
//   },

//   actionButton: {
//     [containerQuery.smallerThan('sm')]: {
//       width: '100%',
//     },
//   },

//   indicatorRoot: { lineHeight: 1 },
//   indicatorIndicator: { lineHeight: 1.6 },
// }));
