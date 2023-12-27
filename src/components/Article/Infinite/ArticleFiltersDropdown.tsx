import {
  Button,
  Chip,
  ChipProps,
  Divider,
  Drawer,
  Group,
  Indicator,
  Popover,
  Stack,
  createStyles,
} from '@mantine/core';
import { MetricTimeframe } from '@prisma/client';
import { IconChevronDown, IconFilter } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useCallback, useState } from 'react';
import { PeriodFilter } from '~/components/Filters';
import { useCurrentUser, useIsSameUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { ArticleQueryInput } from '~/server/schema/article.schema';
import { containerQuery } from '~/utils/mantine-css-helpers';

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
        // color: theme.colorScheme === 'dark' ? theme.white : theme.black,
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
}));

export function ArticleFiltersDropdown({ query, onChange }: Props) {
  const { classes, theme, cx } = useStyles();
  const mobile = useIsMobile();
  const currentUser = useCurrentUser();
  const router = useRouter();
  const isSameUser = useIsSameUser(router.query.username);

  const [opened, setOpened] = useState(false);

  const { filters, setFilters } = useFiltersContext((state) => ({
    filters: state.articles,
    setFilters: state.setArticleFilters,
  }));

  const mergedFilters = query || filters;

  const filterLength =
    (mergedFilters.followed ? 1 : 0) +
    (mergedFilters.period && mergedFilters.period !== MetricTimeframe.AllTime ? 1 : 0);

  const clearFilters = useCallback(() => {
    const reset = {
      followed: false,
      period: MetricTimeframe.AllTime,
    };

    if (onChange) onChange(reset);
    else setFilters(reset);
  }, [onChange, setFilters]);

  const chipProps: Partial<ChipProps> = {
    size: 'sm',
    radius: 'xl',
    variant: 'filled',
    classNames: classes,
    tt: 'capitalize',
  };

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
        {query?.period && onChange ? (
          <PeriodFilter
            type="articles"
            variant="chips"
            value={query.period}
            onChange={(period) => onChange({ period })}
          />
        ) : (
          <PeriodFilter type="articles" variant="chips" />
        )}
        {currentUser && !isSameUser && (
          <>
            <Divider label="Modifiers" labelProps={{ weight: 'bold', size: 'sm' }} />
            <Group>
              <Chip
                {...chipProps}
                checked={mergedFilters.followed}
                onChange={(checked) =>
                  onChange ? onChange({ followed: checked }) : setFilters({ followed: checked })
                }
              >
                Followed Only
              </Chip>
            </Group>
          </>
        )}
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

type Props = {
  query?: Partial<ArticleQueryInput>;
  onChange?: (params: Partial<ArticleQueryInput>) => void;
};
