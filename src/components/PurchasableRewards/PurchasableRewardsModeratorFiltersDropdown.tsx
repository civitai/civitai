import {
  Popover,
  Group,
  Indicator,
  Stack,
  Divider,
  Chip,
  ChipProps,
  Button,
  Drawer,
  ButtonProps,
  useMantineTheme,
  useComputedColorScheme,
} from '@mantine/core';
import { IconChevronDown, IconFilter } from '@tabler/icons-react';
import { BuzzWithdrawalRequestStatus, PurchasableRewardUsage } from '~/shared/utils/prisma/enums';
import { getDisplayName } from '~/utils/string-helpers';
import { useCallback, useState } from 'react';
import { useIsMobile } from '~/hooks/useIsMobile';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { GetPaginatedPurchasableRewardsModeratorSchema } from '~/server/schema/purchasable-reward.schema';
import { PurchasableRewardModeratorViewMode } from '~/server/common/enums';
import classes from './PurchasableRewardsFiltersDropdown.module.scss';
import clsx from 'clsx';

type Filters = Omit<GetPaginatedPurchasableRewardsModeratorSchema, 'limit'>;

export function PurchasableRewardsFiltersModeratorDropdown({
  filters,
  setFilters,
  ...buttonProps
}: Props) {
  const mobile = useIsMobile();
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');

  const [opened, setOpened] = useState(false);
  const filterLength =
    (filters.archived !== undefined ? 1 : 0) + (!!filters.usage ? filters.usage.length : 0);

  const clearFilters = useCallback(
    () =>
      setFilters({
        archived: undefined,
        usage: undefined,
        mode: filters.mode,
      }),
    [setFilters]
  );

  const chipProps: Partial<ChipProps> = {
    size: 'sm',
    radius: 'xl',
    variant: 'filled',
    classNames: classes,
  };

  const target = (
    <Indicator
      offset={4}
      label={filterLength ? filterLength : undefined}
      size={16}
      zIndex={10}
      disabled={!filterLength}
      classNames={{ root: classes.indicatorRoot, indicator: classes.indicatorIndicator }}
      inline
    >
      <Button
        className={classes.actionButton}
        color="gray"
        radius="xl"
        variant={colorScheme === 'dark' ? 'filled' : 'light'}
        {...buttonProps}
        rightIcon={<IconChevronDown className={clsx({ [classes.opened]: opened })} size={16} />}
        onClick={() => setOpened((o) => !o)}
        data-expanded={opened}
      >
        <Group gap={4} wrap="nowrap">
          <IconFilter size={16} />
          Filters
        </Group>
      </Button>
    </Indicator>
  );

  const dropdown = (
    <Stack gap="lg">
      <Stack gap="md">
        <Divider label="Mode" className="text-sm font-bold" />
        <Chip.Group
          value={filters.mode ?? PurchasableRewardModeratorViewMode.Available}
          onChange={(mode) => {
            setFilters({
              mode: mode as PurchasableRewardModeratorViewMode,
            });
          }}
        >
          <Group gap={8}>
            {Object.values(PurchasableRewardModeratorViewMode).map((type, index) => (
              <Chip key={index} value={type} {...chipProps}>
                <span>{getDisplayName(type)}</span>
              </Chip>
            ))}
          </Group>
        </Chip.Group>
        <Divider label="Archived" className="text-sm font-bold" />
        <Chip.Group
          value={
            filters.archived === true ? 'true' : filters.archived === false ? 'false' : undefined
          }
          onChange={(v) => {
            setFilters({
              archived: v === 'true' ? true : v === 'false' ? false : undefined,
            });
          }}
        >
          <Group gap={8}>
            <Chip value="true" {...chipProps}>
              <span>Yes</span>
            </Chip>
            <Chip value="false" {...chipProps}>
              <span>No</span>
            </Chip>
          </Group>
        </Chip.Group>
        <Divider label="Usage" className="text-sm font-bold" />
        <Chip.Group
          value={filters.usage ?? []}
          onChange={(usage) => {
            setFilters({
              usage: usage as PurchasableRewardUsage[],
            });
          }}
          multiple
        >
          <Group gap={8}>
            {Object.values(PurchasableRewardUsage).map((type, index) => (
              <Chip key={index} value={type} {...chipProps}>
                <span>{getDisplayName(type)}</span>
              </Chip>
            ))}
          </Group>
        </Chip.Group>
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

type Props = {
  setFilters: (filters: Partial<Filters>) => void;
  filters: Filters;
} & Omit<ButtonProps, 'onClick' | 'children' | 'rightIcon'>;
