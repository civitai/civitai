import type { ChipProps, ButtonProps } from '@mantine/core';
import {
  Popover,
  Group,
  Indicator,
  Stack,
  Divider,
  Chip,
  Button,
  Drawer,
  useMantineTheme,
  useComputedColorScheme,
} from '@mantine/core';
import { IconChevronDown, IconFilter } from '@tabler/icons-react';
import { BuzzWithdrawalRequestStatus } from '~/shared/utils/prisma/enums';
import { getDisplayName } from '~/utils/string-helpers';
import { useCallback, useState } from 'react';
import { useIsMobile } from '~/hooks/useIsMobile';
import type { GetPaginatedBuzzWithdrawalRequestSchema } from '~/server/schema/buzz-withdrawal-request.schema';
import classes from './BuzzWithdrawalRequestFiltersDropdown.module.scss';
import clsx from 'clsx';

type Filters = Omit<GetPaginatedBuzzWithdrawalRequestSchema, 'limit'>;

export function BuzzWithdrawalRequestFilterDropdown({
  filters,
  setFilters,
  ...buttonProps
}: Props) {
  const mobile = useIsMobile();
  const colorScheme = useComputedColorScheme('dark');

  const [opened, setOpened] = useState(false);
  const filterLength =
    (filters.status?.length ?? 0) +
    (filters.requestId ? 1 : 0) +
    (filters.userId ? 1 : 0) +
    (filters.username ? 1 : 0);

  const clearFilters = useCallback(
    () =>
      setFilters({
        status: undefined,
        requestId: undefined,
        userId: undefined,
        username: undefined,
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
        rightSection={<IconChevronDown className={clsx({ [classes.opened]: opened })} size={16} />}
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
        <Divider label="Request Status" className="text-sm font-bold" />
        <Chip.Group
          value={filters.status ?? []}
          onChange={(status: string[]) => {
            setFilters({
              status: status as BuzzWithdrawalRequestStatus[],
            });
          }}
          multiple
        >
          <Group gap={8}>
            {Object.values(BuzzWithdrawalRequestStatus).map((type, index) => (
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
