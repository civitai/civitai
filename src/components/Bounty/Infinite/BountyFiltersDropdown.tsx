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
  useComputedColorScheme,
} from '@mantine/core';
import { IconFilter } from '@tabler/icons-react';
import { BountyType, MetricTimeframe } from '~/shared/utils/prisma/enums';
import { getDisplayName } from '~/utils/string-helpers';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { useCallback, useState } from 'react';
import { BountyStatus } from '~/server/common/enums';
import type { BaseModel } from '~/shared/constants/base-model.constants';
import { activeBaseModels } from '~/shared/constants/base-model.constants';
import { useIsMobile } from '~/hooks/useIsMobile';
import { PeriodFilter } from '~/components/Filters';
import { FilterButton } from '~/components/Buttons/FilterButton';
import { FilterChip } from '~/components/Filters/FilterChip';

const supportsBaseModel = [
  BountyType.ModelCreation,
  BountyType.LoraCreation,
  BountyType.EmbedCreation,
] as const;

const checkSupportsBaseModel = (types: BountyType[]) => {
  return types.some((type) =>
    supportsBaseModel.includes(type as (typeof supportsBaseModel)[number])
  );
};

export function BountyFiltersDropdown({ ...buttonProps }: Props) {
  const colorScheme = useComputedColorScheme('dark');
  const mobile = useIsMobile();

  const [opened, setOpened] = useState(false);

  const { filters, setFilters } = useFiltersContext((state) => ({
    filters: state.bounties,
    setFilters: state.setBountyFilters,
  }));

  const filterLength =
    (filters.types?.length ?? 0) +
    (filters.baseModels?.length ?? 0) +
    // (!!filters.mode ? 1 : 0) +
    (!!filters.status ? 1 : 0) +
    (filters.period !== MetricTimeframe.AllTime ? 1 : 0);

  const clearFilters = useCallback(
    () =>
      setFilters({
        types: undefined,
        // mode: undefined,
        status: undefined,
        baseModels: undefined,
        period: MetricTimeframe.AllTime,
      }),
    [setFilters]
  );

  const showBaseModelFilter = checkSupportsBaseModel(filters.types ?? []);

  const target = (
    <Indicator
      offset={4}
      label={filterLength ? filterLength : undefined}
      size={16}
      zIndex={10}
      disabled={!filterLength}
      inline
    >
      <FilterButton icon={IconFilter} onClick={() => setOpened((o) => !o)} active={opened}>
        Filters
      </FilterButton>
    </Indicator>
  );

  const dropdown = (
    <Stack gap="lg">
      <Stack gap="md">
        <Divider
          label="Time period"
          styles={{
            label: {
              weight: 'bold',
              size: 'var(--mantine-font-size-sm)',
            },
          }}
        />
        <PeriodFilter type="bounties" variant="chips" />
      </Stack>
      <Stack gap="md">
        <Divider
          label="Bounty type"
          styles={{
            label: {
              weight: 'bold',
              size: 'var(--mantine-font-size-sm)',
            },
          }}
        />
        <Chip.Group
          value={filters.types ?? []}
          onChange={(v: string[]) => {
            const types = v as BountyType[];
            const clearBaseModelFilter = !checkSupportsBaseModel(types);
            setFilters({
              types,
              baseModels: clearBaseModelFilter ? undefined : filters.baseModels,
            });
          }}
          multiple
        >
          <Group gap={8}>
            {Object.values(BountyType).map((type, index) => (
              <FilterChip key={index} value={type}>
                <span>{getDisplayName(type)}</span>
              </FilterChip>
            ))}
          </Group>
        </Chip.Group>
      </Stack>
      {showBaseModelFilter && (
        <Stack gap="md">
          <Divider
            label="Base model"
            styles={{
              label: {
                weight: 'bold',
                size: 'var(--mantine-font-size-sm)',
              },
            }}
          />
          <Chip.Group
            value={filters.baseModels ?? []}
            onChange={(baseModels: string[]) =>
              setFilters({ baseModels: baseModels as BaseModel[] })
            }
            multiple
          >
            <Group gap={8}>
              {activeBaseModels.map((baseModel, index) => (
                <FilterChip key={index} value={baseModel}>
                  <span>{baseModel}</span>
                </FilterChip>
              ))}
            </Group>
          </Chip.Group>
        </Stack>
      )}
      {/* TODO.bounty: turn this on once we accept split bounties */}
      {/* <Stack gap="md">
        <Divider label="Bounty mode" labelProps={{ weight: 'bold', size: 'sm' }} />
        <Group gap={8}>
          {Object.values(BountyMode).map((mode, index) => (
            <Chip
              {...chipProps}
              key={index}
              checked={filters.mode === mode}
              onChange={(checked) => setFilters({ mode: checked ? mode : undefined })}
            >
              <span>{getDisplayName(mode)}</span>
            </Chip>
          ))}
        </Group>
      </Stack> */}
      <Stack gap="md">
        <Divider
          label="Bounty status"
          styles={{
            label: {
              weight: 'bold',
              size: 'var(--mantine-font-size-sm)',
            },
          }}
        />
        <Group gap={8}>
          {Object.values(BountyStatus).map((status, index) => (
            <FilterChip
              key={index}
              checked={filters.status === status}
              onChange={(checked) => setFilters({ status: checked ? status : undefined })}
            >
              <span>{getDisplayName(status)}</span>
            </FilterChip>
          ))}
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
          styles={{
            content: {
              height: 'auto',
              maxHeight: 'calc(100dvh - var(--header-height))',
              overflowY: 'auto',
            },
            body: { padding: 16, paddingTop: 0, overflowY: 'auto' },
            header: { padding: '4px 8px' },
            close: { height: 32, width: 32, '& > svg': { width: 24, height: 24 } },
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
      <Popover.Dropdown maw={468} p="md" w="100%">
        {dropdown}
      </Popover.Dropdown>
    </Popover>
  );
}

type Props = Omit<ButtonProps, 'onClick' | 'children' | 'rightIcon'>;
