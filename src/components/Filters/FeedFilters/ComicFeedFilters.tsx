import type { GroupProps } from '@mantine/core';
import { Group } from '@mantine/core';
import { IconUsersGroup, IconWorld } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import classes from '~/components/Filters/FeedFilters/FeedFilters.module.scss';
import { SelectMenuV2 } from '~/components/SelectMenu/SelectMenu';
import { useCurrentUser } from '~/hooks/useCurrentUser';

const sortOptions = [
  { label: 'Newest', value: 'Newest' },
  { label: 'Most Followed', value: 'MostFollowed' },
  { label: 'Most Chapters', value: 'MostChapters' },
] as const;

const periodOptions = [
  { label: 'All Time', value: 'AllTime' },
  { label: 'Today', value: 'Day' },
  { label: 'This Week', value: 'Week' },
  { label: 'This Month', value: 'Month' },
  { label: 'This Year', value: 'Year' },
] as const;

export function ComicFeedFilters({ ...groupProps }: GroupProps) {
  const router = useRouter();
  const currentUser = useCurrentUser();

  const sort = (router.query.sort as string) || 'Newest';
  const period = (router.query.period as string) || 'AllTime';
  const followed = (router.query.followed as string) || 'false';

  const setParam = (key: string, value: string | undefined) => {
    const query = { ...router.query };
    if (!value) delete query[key];
    else query[key] = value;
    void router.replace({ pathname: router.pathname, query }, undefined, { shallow: true });
  };

  return (
    <Group className={classes.filtersWrapper} gap={4} wrap="nowrap" {...groupProps}>
      {currentUser && (
        <SelectMenuV2
          label={followed === 'true' ? 'Followed' : 'Everyone'}
          options={[
            { label: 'Followed', value: 'true' },
            { label: 'Everyone', value: 'false' },
          ]}
          icon={followed === 'true' ? IconUsersGroup : IconWorld}
          onClick={(v) => setParam('followed', v === 'false' ? undefined : v)}
          value={followed}
          size="compact-sm"
        />
      )}
      <SelectMenuV2
        label={sortOptions.find((o) => o.value === sort)?.label ?? 'Newest'}
        options={[...sortOptions]}
        onClick={(v) => setParam('sort', v === 'Newest' ? undefined : v)}
        value={sort}
        size="compact-sm"
      />
      <SelectMenuV2
        label={periodOptions.find((o) => o.value === period)?.label ?? 'All Time'}
        options={[...periodOptions]}
        onClick={(v) => setParam('period', v === 'AllTime' ? undefined : v)}
        value={period}
        size="compact-sm"
      />
    </Group>
  );
}
