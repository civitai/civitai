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
} from '@mantine/core';
import { IconChevronDown, IconFilter } from '@tabler/icons-react';
import { BountyMode, BountyType, MetricTimeframe } from '@prisma/client';
import { getDisplayName } from '~/utils/string-helpers';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { useCallback, useState } from 'react';
import { BountyStatus } from '~/server/common/enums';
import { constants, BaseModel } from '~/server/common/constants';
import { useIsMobile } from '~/hooks/useIsMobile';

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

export function BountyFiltersDropdown() {
  const { classes, theme, cx } = useStyles();
  const mobile = useIsMobile();

  const [opened, setOpened] = useState(false);

  const { filters, setFilters } = useFiltersContext((state) => ({
    filters: state.bounties,
    setFilters: state.setBountyFilters,
  }));

  const filterLength =
    (filters.types?.length ?? 0) +
    (filters.baseModels?.length ?? 0) +
    (!!filters.mode ? 1 : 0) +
    (!!filters.status ? 1 : 0) +
    (filters.period !== MetricTimeframe.AllTime ? 1 : 0);

  const clearFilters = useCallback(
    () =>
      setFilters({
        types: undefined,
        mode: undefined,
        status: undefined,
        baseModels: undefined,
        period: MetricTimeframe.AllTime,
      }),
    [setFilters]
  );

  const chipProps: Partial<ChipProps> = {
    size: 'sm',
    radius: 'xl',
    variant: 'filled',
    classNames: classes,
  };

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
      <Button
        className={classes.actionButton}
        color="gray"
        radius="xl"
        variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
        rightIcon={<IconChevronDown className={cx({ [classes.opened]: opened })} size={16} />}
        onClick={() => setOpened((o) => !o)}
      >
        <Group spacing={4} noWrap>
          <IconFilter size={16} />
          Filters
        </Group>
      </Button>
    </Indicator>
  );

  const dropdown = (
    <Stack spacing="lg">
      <Stack spacing="md">
        <Divider label="Time period" labelProps={{ weight: 'bold', size: 'sm' }} />
        <Chip.Group
          spacing={8}
          value={filters.period}
          onChange={(period: MetricTimeframe) => setFilters({ period })}
        >
          {Object.values(MetricTimeframe).map((type, index) => (
            <Chip key={index} value={type} {...chipProps}>
              {getDisplayName(type)}
            </Chip>
          ))}
        </Chip.Group>
      </Stack>
      <Stack spacing="md">
        <Divider label="Bounty type" labelProps={{ weight: 'bold', size: 'sm' }} />
        <Chip.Group
          spacing={8}
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
            <Chip key={index} value={type} {...chipProps}>
              {getDisplayName(type)}
            </Chip>
          ))}
        </Chip.Group>
      </Stack>
      {showBaseModelFilter && (
        <Stack spacing="md">
          <Divider label="Base model" labelProps={{ weight: 'bold', size: 'sm' }} />
          <Chip.Group
            spacing={8}
            value={filters.baseModels ?? []}
            onChange={(baseModels: BaseModel[]) => setFilters({ baseModels })}
            multiple
          >
            {constants.baseModels.map((baseModel, index) => (
              <Chip key={index} value={baseModel} {...chipProps}>
                {baseModel}
              </Chip>
            ))}
          </Chip.Group>
        </Stack>
      )}
      <Stack spacing="md">
        <Divider label="Bounty mode" labelProps={{ weight: 'bold', size: 'sm' }} />
        <Group spacing={8}>
          {Object.values(BountyMode).map((mode, index) => (
            <Chip
              {...chipProps}
              key={index}
              checked={filters.mode === mode}
              onChange={(checked) => setFilters({ mode: checked ? mode : undefined })}
            >
              {getDisplayName(mode)}
            </Chip>
          ))}
        </Group>
      </Stack>
      <Stack spacing="md">
        <Divider label="Bounty status" labelProps={{ weight: 'bold', size: 'sm' }} />
        <Group spacing={8}>
          {Object.values(BountyStatus).map((status, index) => (
            <Chip
              {...chipProps}
              key={index}
              checked={filters.status === status}
              onChange={(checked) => setFilters({ status: checked ? status : undefined })}
            >
              {getDisplayName(status)}
            </Chip>
          ))}
        </Group>
      </Stack>
      {filterLength > 0 && (
        <Button
          color="gray"
          variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
          onClick={clearFilters}
          // sx={{ position: 'absolute', bottom: 0 }}
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
          withCloseButton={false}
          size="90%"
          position="bottom"
          styles={{
            body: { padding: 16 },
            drawer: {
              height: 'auto',
              maxHeight: 'calc(100dvh - var(--mantine-header-height))',
              overflowY: 'auto',
            },
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

const useStyles = createStyles((theme) => ({
  label: {
    fontSize: 12,
    fontWeight: 600,

    '&[data-checked]': {
      '&, &:hover': {
        color: theme.white,
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
    [theme.fn.smallerThan('sm')]: {
      width: '100%',
    },
  },
}));
