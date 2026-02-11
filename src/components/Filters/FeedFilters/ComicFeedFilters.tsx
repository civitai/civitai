import type { GroupProps } from '@mantine/core';
import { Group, Select } from '@mantine/core';
import { useRouter } from 'next/router';

import classes from '~/components/Filters/FeedFilters/FeedFilters.module.scss';
import { formatGenreLabel } from '~/utils/comic-helpers';
import { ComicGenre } from '~/shared/utils/prisma/enums';

const genreOptions = [
  { value: '', label: 'All Genres' },
  ...Object.keys(ComicGenre).map((g) => ({ value: g, label: formatGenreLabel(g) })),
];

const sortOptions = [
  { value: 'Newest', label: 'Newest' },
  { value: 'MostFollowed', label: 'Most Followed' },
  { value: 'MostChapters', label: 'Most Chapters' },
];

const periodOptions = [
  { value: 'AllTime', label: 'All Time' },
  { value: 'Day', label: 'Today' },
  { value: 'Week', label: 'This Week' },
  { value: 'Month', label: 'This Month' },
  { value: 'Year', label: 'This Year' },
];

export function ComicFeedFilters({ ...groupProps }: GroupProps) {
  const router = useRouter();

  const setParam = (key: string, value: string) => {
    const query = { ...router.query };
    if (!value) delete query[key];
    else query[key] = value;
    router.replace({ pathname: router.pathname, query }, undefined, { shallow: true });
  };

  return (
    <Group className={classes.filtersWrapper} gap={4} wrap="nowrap" {...groupProps}>
      <Select
        data={genreOptions}
        value={(router.query.genre as string) ?? ''}
        onChange={(v) => setParam('genre', v ?? '')}
        size="xs"
        w={130}
        placeholder="Genre"
        clearable={false}
      />
      <Select
        data={periodOptions}
        value={(router.query.period as string) ?? 'AllTime'}
        onChange={(v) => setParam('period', v ?? '')}
        size="xs"
        w={120}
        clearable={false}
      />
      <Select
        data={sortOptions}
        value={(router.query.sort as string) ?? 'Newest'}
        onChange={(v) => setParam('sort', v ?? '')}
        size="xs"
        w={140}
        clearable={false}
      />
    </Group>
  );
}
