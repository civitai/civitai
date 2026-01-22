import type { GroupProps } from '@mantine/core';
import { Group } from '@mantine/core';
import { useRouter } from 'next/router';
import { SelectMenuV2 } from '~/components/SelectMenu/SelectMenu';
import { ChallengeFiltersDropdown } from '~/components/Challenge/Infinite/ChallengeFiltersDropdown';
import { ChallengeSort } from '~/server/schema/challenge.schema';
import classes from '~/components/Filters/FeedFilters/FeedFilters.module.scss';

const sortOptions = [
  { value: ChallengeSort.Newest, label: 'Newest' },
  { value: ChallengeSort.EndingSoon, label: 'Ending Soon' },
  { value: ChallengeSort.HighestPrize, label: 'Highest Prize' },
  { value: ChallengeSort.MostEntries, label: 'Most Entries' },
];

export function ChallengeFeedFilters({ ...groupProps }: GroupProps) {
  const router = useRouter();
  const sort = (router.query.sort as ChallengeSort) || ChallengeSort.Newest;

  const handleSortChange = (value: ChallengeSort) => {
    router.replace(
      { pathname: '/challenges', query: { ...router.query, sort: value } },
      undefined,
      { shallow: true }
    );
  };

  return (
    <Group className={classes.filtersWrapper} gap={8} wrap="nowrap" {...groupProps}>
      <SelectMenuV2 label={sort} value={sort} onClick={handleSortChange} options={sortOptions} />
      <ChallengeFiltersDropdown />
    </Group>
  );
}
