import { ActionIcon, Button, Group, GroupProps, Popover } from '@mantine/core';
import { IconExclamationMark } from '@tabler/icons-react';

import { SortFilter, ViewToggle } from '~/components/Filters';
import { useFeedFiltersStyles } from '~/components/Filters/FeedFilters/FeedFilters.styles';
import { ModelFiltersDropdown } from '~/components/Model/Infinite/ModelFiltersDropdown';
import { useModelQueryParams } from '~/components/Model/model.utils';
import { env } from '~/env/client.mjs';
import { PeriodMode } from '~/server/schema/base.schema';

export function ModelFeedFilters({ ...groupProps }: GroupProps) {
  const { classes, theme } = useFeedFiltersStyles();
  const { set, ...queryFilters } = useModelQueryParams();
  const { username, favorites, hidden, query, collectionId } = queryFilters;
  const periodMode = query || favorites ? ('stats' as PeriodMode) : undefined;
  if (periodMode) queryFilters.periodMode = periodMode;
  const canToggleView =
    env.NEXT_PUBLIC_UI_CATEGORY_VIEWS && !username && !favorites && !hidden && !collectionId;

  return (
    <Group className={classes.filtersWrapper} spacing={4} noWrap {...groupProps}>
      {periodMode && (
        <Popover>
          <Popover.Target>
            <ActionIcon variant="filled" color="blue" radius="xl" size={36} mr={4}>
              <IconExclamationMark size={20} strokeWidth={3} />
            </ActionIcon>
          </Popover.Target>
          <Popover.Dropdown maw={300}>
            {`To ensure that you see all possible results, we've disable the period filter.`}
            <Button mt="xs" size="xs" fullWidth onClick={() => set({ query: undefined })}>
              Clear Search
            </Button>
          </Popover.Dropdown>
        </Popover>
      )}
      <SortFilter type="models" variant="button" />
      <ModelFiltersDropdown size="xs" compact />
      {canToggleView && (
        <ViewToggle
          type="models"
          color="gray"
          radius="xl"
          size="sm"
          iconSize={14}
          variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
        />
      )}
    </Group>
  );
}
