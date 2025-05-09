import {
  Popover,
  Group,
  Indicator,
  Stack,
  Divider,
  Chip,
  ChipProps,
  Button,
  createStyles,
  Drawer,
  ButtonProps,
  useMantineTheme,
} from '@mantine/core';
import { IconFilter } from '@tabler/icons-react';
import { BountyType, MetricTimeframe } from '~/shared/utils/prisma/enums';
import { getDisplayName } from '~/utils/string-helpers';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { useCallback, useState } from 'react';
import { BountyStatus } from '~/server/common/enums';
import { activeBaseModels, BaseModel } from '~/server/common/constants';
import { useIsMobile } from '~/hooks/useIsMobile';
import { PeriodFilter } from '~/components/Filters';
import { containerQuery } from '~/utils/mantine-css-helpers';
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
  const theme = useMantineTheme();
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
      showZero={false}
      dot={false}
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
        <Divider label="Time period" labelProps={{ weight: 'bold', size: 'sm' }} />
        <PeriodFilter type="bounties" variant="chips" />
      </Stack>
      <Stack gap="md">
        <Divider label="Bounty type" labelProps={{ weight: 'bold', size: 'sm' }} />
        <Chip.Group
          gap={8}
          value={filters.types ?? []}
          onChange={(types: BountyType[]) => {
            const clearBaseModelFilter = !checkSupportsBaseModel(types);
            setFilters({
              types,
              baseModels: clearBaseModelFilter ? undefined : filters.baseModels,
            });
          }}
          multiple
        >
          {Object.values(BountyType).map((type, index) => (
            <FilterChip key={index} value={type}>
              <span>{getDisplayName(type)}</span>
            </FilterChip>
          ))}
        </Chip.Group>
      </Stack>
      {showBaseModelFilter && (
        <Stack gap="md">
          <Divider label="Base model" labelProps={{ weight: 'bold', size: 'sm' }} />
          <Chip.Group
            gap={8}
            value={filters.baseModels ?? []}
            onChange={(baseModels: BaseModel[]) => setFilters({ baseModels })}
            multiple
          >
            {activeBaseModels.map((baseModel, index) => (
              <FilterChip key={index} value={baseModel}>
                <span>{baseModel}</span>
              </FilterChip>
            ))}
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
        <Divider label="Bounty status" labelProps={{ weight: 'bold', size: 'sm' }} />
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
      <Popover.Dropdown maw={468} p="md" w="100%">
        {dropdown}
      </Popover.Dropdown>
    </Popover>
  );
}

type Props = Omit<ButtonProps, 'onClick' | 'children' | 'rightIcon'>;

const useStyles = createStyles((theme) => ({
  label: {
    fontSize: 12,
    fontWeight: 600,

    '&[data-checked]': {
      '&, &:hover': {
        color: theme.colorScheme === 'dark' ? theme.white : theme.black,
        border: `1px solid ${theme.colors[theme.primaryColor][theme.fn.primaryShade()]}`,
      },

      '&[data-variant="filled"]': {
        backgroundColor: 'transparent',
      },
    },
  },
  opened: {
    transform: 'rotate(180deg)',
    transition: 'transform 200ms ease',
  },

  actionButton: {
    [containerQuery.smallerThan('sm')]: {
      width: '100%',
    },
  },

  indicatorRoot: { lineHeight: 1 },
  indicatorIndicator: { lineHeight: 1.6 },
}));
