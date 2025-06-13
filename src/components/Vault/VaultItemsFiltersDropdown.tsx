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
  useComputedColorScheme,
} from '@mantine/core';
import { IconFilter } from '@tabler/icons-react';
import { getDisplayName } from '~/utils/string-helpers';
import { useCallback, useState } from 'react';
import { useIsMobile } from '~/hooks/useIsMobile';
import { TagSort } from '~/server/common/enums';
import type { GetPaginatedVaultItemsSchema } from '~/server/schema/vault.schema';
import { ModelType } from '~/shared/utils/prisma/enums';
import { DatePickerInput } from '@mantine/dates';
import { trpc } from '~/utils/trpc';
import { constants } from '~/server/common/constants';
import { FilterButton } from '~/components/Buttons/FilterButton';
import { FilterChip } from '~/components/Filters/FilterChip';
import styles from './VaultItemsFiltersDropdown.module.scss';

type Filters = Omit<GetPaginatedVaultItemsSchema, 'limit'>;

export function VaultItemsFiltersDropdown({ filters, setFilters, ...buttonProps }: Props) {
  const mobile = useIsMobile();
  const colorScheme = useComputedColorScheme('dark');
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
      disabled={!filterLength}
      inline
    >
      <FilterButton
        icon={IconFilter}
        size="md"
        variant="default"
        active={opened}
        onClick={() => setOpened((o) => !o)}
        {...buttonProps}
      >
        Filters
      </FilterButton>
    </Indicator>
  );

  const dropdown = (
    <Stack gap="xs">
      <Stack gap="xs">
        <Divider label="Type" classNames={{ label: 'font-bold text-sm' }} />
        <Chip.Group
          value={filters.types ?? []}
          onChange={(types) => {
            setFilters({ types: types as ModelType[] });
          }}
          multiple
        >
          <Group gap={8}>
            {Object.values(ModelType).map((type, index) => (
              <FilterChip key={index} value={type}>
                <span>{getDisplayName(type)}</span>
              </FilterChip>
            ))}
          </Group>
        </Chip.Group>
        <Divider label="Category" classNames={{ label: 'font-bold text-sm' }} />
        <Chip.Group
          value={filters.categories ?? []}
          onChange={(categories) => {
            setFilters({ categories });
          }}
          multiple
        >
          <Group gap={8}>
            {categories.map((category) => (
              <FilterChip key={category.id} value={category.name}>
                <Text tt="capitalize" span inherit>
                  {getDisplayName(category.name)}
                </Text>
              </FilterChip>
            ))}
          </Group>
        </Chip.Group>
        <Divider label="Base Model" classNames={{ label: 'font-bold text-sm' }} />
        <Chip.Group
          value={filters.baseModels ?? []}
          onChange={(baseModels) => {
            setFilters({ baseModels });
          }}
          multiple
        >
          <Group gap={8}>
            {constants.baseModels.map((baseModel) => (
              <FilterChip key={baseModel} value={baseModel}>
                <Text tt="capitalize" span inherit>
                  {baseModel}
                </Text>
              </FilterChip>
            ))}
          </Group>
        </Chip.Group>
        <Divider label="Created at" classNames={{ label: 'font-bold text-sm' }} />
        <Group grow>
          <DatePickerInput
            label="From"
            placeholder="From"
            value={filters.dateCreatedFrom}
            onChange={(date) => {
              setFilters({ dateCreatedFrom: date ?? undefined });
            }}
            maxDate={filters.dateCreatedTo ?? undefined}
            clearable
            radius="xl"
          />
          <DatePickerInput
            label="To"
            placeholder="To"
            value={filters.dateCreatedTo}
            onChange={(date) => {
              setFilters({ dateCreatedTo: date ?? undefined });
            }}
            minDate={filters.dateCreatedFrom ?? undefined}
            clearable
            radius="xl"
          />
        </Group>
        <Divider label="Added at" classNames={{ label: 'font-bold text-sm' }} />
        <Group grow>
          <DatePickerInput
            label="From"
            placeholder="From"
            value={filters.dateAddedFrom}
            onChange={(date) => {
              setFilters({ dateAddedFrom: date ?? undefined });
            }}
            maxDate={filters.dateAddedTo ?? undefined}
            clearable
            radius="xl"
          />
          <DatePickerInput
            label="To"
            placeholder="To"
            value={filters.dateAddedTo}
            onChange={(date) => {
              setFilters({ dateAddedTo: date ?? undefined });
            }}
            minDate={filters.dateAddedFrom ?? undefined}
            clearable
            radius="xl"
          />
        </Group>
      </Stack>
      {filterLength > 0 && (
        <Button
          color="gray"
          variant={colorScheme === 'dark' ? 'filled' : 'light'}
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
          classNames={{
            content: styles.content,
            body: styles.body,
            header: styles.header,
            close: styles.close,
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
} & Omit<ButtonProps, 'onClick' | 'children' | 'rightIcon' | 'style'>;
