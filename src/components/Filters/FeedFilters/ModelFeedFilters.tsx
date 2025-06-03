import type { GroupProps } from '@mantine/core';
import { ActionIcon, Button, Group, Popover } from '@mantine/core';
import { IconExclamationMark } from '@tabler/icons-react';

import { SortFilter } from '~/components/Filters';
import classes from '~/components/Filters/FeedFilters/FeedFilters.module.scss';
import { ModelFiltersDropdown } from '~/components/Model/Infinite/ModelFiltersDropdown';
import { useModelQueryParams } from '~/components/Model/model.utils';
import type { PeriodMode } from '~/server/schema/base.schema';
import { FollowedFilter } from '~/components/Filters/FollowedFilter';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

export function ModelFeedFilters({ ...groupProps }: GroupProps) {
  const currentUser = useCurrentUser();
  const { set, ...queryFilters } = useModelQueryParams();
  const { favorites, query } = queryFilters;
  const periodMode = query || favorites ? ('stats' as PeriodMode) : undefined;
  if (periodMode) queryFilters.periodMode = periodMode;

  return (
    <Group className={classes.filtersWrapper} gap={4} wrap="nowrap" {...groupProps}>
      {periodMode && (
        <Popover>
          <Popover.Target>
            <LegacyActionIcon variant="filled" color="blue" radius="xl" size={36} mr={4}>
              <IconExclamationMark size={20} strokeWidth={3} />
            </LegacyActionIcon>
          </Popover.Target>
          <Popover.Dropdown maw={300}>
            {`To ensure that you see all possible results, we've disabled the period filter.`}
            <Button mt="xs" size="xs" fullWidth onClick={() => set({ query: undefined })}>
              Clear Search
            </Button>
          </Popover.Dropdown>
        </Popover>
      )}
      {currentUser && <FollowedFilter type="models" variant="button" />}
      <SortFilter type="models" />
      <ModelFiltersDropdown w="100%" size="compact-sm" isFeed />
    </Group>
  );
}
