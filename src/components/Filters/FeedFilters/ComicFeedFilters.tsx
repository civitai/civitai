import type { GroupProps } from '@mantine/core';
import { Group } from '@mantine/core';
import { IconBooks, IconUsersGroup, IconWorld } from '@tabler/icons-react';
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

// 'creators' matches the sitewide Followed filter (creators you follow);
// 'comics' filters to comics you follow directly (per-comic Notify engagement).
const audienceOptions = [
  { label: 'Everyone', value: 'everyone' },
  { label: 'Followed', value: 'creators' },
  { label: 'Followed Comics', value: 'comics' },
] as const;

const audienceIcons = {
  everyone: IconWorld,
  creators: IconUsersGroup,
  comics: IconBooks,
} as const;

export function ComicFeedFilters({ ...groupProps }: GroupProps) {
  const router = useRouter();
  const currentUser = useCurrentUser();

  const sort = (router.query.sort as string) || 'Newest';
  const period = (router.query.period as string) || 'AllTime';
  const audience =
    router.query.followedComics === 'true'
      ? 'comics'
      : router.query.followed === 'true'
      ? 'creators'
      : 'everyone';

  const setParams = (updates: Record<string, string | undefined>) => {
    const query = { ...router.query };
    for (const [key, value] of Object.entries(updates)) {
      if (!value) delete query[key];
      else query[key] = value;
    }
    void router.replace({ pathname: router.pathname, query }, undefined, { shallow: true });
  };
  const setParam = (key: string, value: string | undefined) => setParams({ [key]: value });

  return (
    <Group className={classes.filtersWrapper} gap={4} wrap="nowrap" {...groupProps}>
      {currentUser && (
        <SelectMenuV2
          label={audienceOptions.find((o) => o.value === audience)?.label ?? 'Everyone'}
          options={[...audienceOptions]}
          icon={audienceIcons[audience]}
          onClick={(v) =>
            setParams({
              followed: v === 'creators' ? 'true' : undefined,
              followedComics: v === 'comics' ? 'true' : undefined,
            })
          }
          value={audience}
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
