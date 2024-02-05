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
} from '@mantine/core';
import { IconChevronDown, IconFilter } from '@tabler/icons-react';
import { BuzzWithdrawalRequestStatus } from '@prisma/client';
import { getDisplayName } from '~/utils/string-helpers';
import { useCallback, useState } from 'react';
import { constants, BaseModel } from '~/server/common/constants';
import { useIsMobile } from '~/hooks/useIsMobile';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { GetPaginatedBuzzWithdrawalRequestSchema } from '~/server/schema/buzz-withdrawal-request.schema';

type Filters = Omit<GetPaginatedBuzzWithdrawalRequestSchema, 'limit'>;

export function BuzzWithdrawalRequestFilterDropdown({
  filters,
  setFilters,
  ...buttonProps
}: Props) {
  const { classes, theme, cx } = useStyles();
  const mobile = useIsMobile();

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
      showZero={false}
      dot={false}
      classNames={{ root: classes.indicatorRoot, indicator: classes.indicatorIndicator }}
      inline
    >
      <Button
        className={classes.actionButton}
        color="gray"
        radius="xl"
        variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
        {...buttonProps}
        rightIcon={<IconChevronDown className={cx({ [classes.opened]: opened })} size={16} />}
        onClick={() => setOpened((o) => !o)}
        data-expanded={opened}
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
        <Divider label="Request Status" labelProps={{ weight: 'bold', size: 'sm' }} />
        <Chip.Group
          spacing={8}
          value={filters.status ?? []}
          onChange={(status: BuzzWithdrawalRequestStatus[]) => {
            setFilters({
              status,
            });
          }}
          multiple
        >
          {Object.values(BuzzWithdrawalRequestStatus).map((type, index) => (
            <Chip key={index} value={type} {...chipProps}>
              {getDisplayName(type)}
            </Chip>
          ))}
        </Chip.Group>
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
              maxHeight: 'calc(100dvh - var(--mantine-header-height))',
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

type Props = {
  setFilters: (filters: Partial<Filters>) => void;
  filters: Filters;
} & Omit<ButtonProps, 'onClick' | 'children' | 'rightIcon'>;

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
