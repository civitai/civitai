import type { ButtonProps } from '@mantine/core';
import { useRouter } from 'next/router';
import { isSortAvailable } from '~/components/Filters/sort-availability';
import { useSortAvailability } from '~/components/Filters/useSortAvailability';
import { SelectMenuV2 } from '~/components/SelectMenu/SelectMenu';
import type { FilterSubTypes } from '~/providers/FiltersProvider';
import { useFiltersContext, useSetFilters } from '~/providers/FiltersProvider';
import {
  ArticleSort,
  BountySort,
  BuzzWithdrawalRequestSort,
  CollectionSort,
  GenerationSort,
  ImageSort,
  ImageSortHidden,
  ModelSort,
  PostSort,
  QuestionSort,
  ThreadSort,
  ToolSort,
} from '~/server/common/enums';
import { removeEmpty } from '~/utils/object-helpers';

type SortFilterComponentProps = {
  type: Exclude<FilterSubTypes, 'changelogs' | 'auctions'>;
  ignoreNsfwLevel?: boolean;
  options?: { label: SortOption; value: SortOption }[];
} & Omit<ButtonProps, 'children' | 'type' | 'style'>;

type SortFilterProps = StatefulProps | DumbProps;

const sortOptions = {
  models: Object.values(ModelSort),
  posts: Object.values(PostSort),
  images: Object.values(ImageSort).filter((x) => !Object.values(ImageSortHidden).includes(x)),
  modelImages: Object.values(ImageSort).filter((x) => !Object.values(ImageSortHidden).includes(x)),
  questions: Object.values(QuestionSort),
  articles: Object.values(ArticleSort),
  collections: Object.values(CollectionSort),
  bounties: Object.values(BountySort),
  videos: Object.values(ImageSort).filter((x) => !Object.values(ImageSortHidden).includes(x)),
  threads: Object.values(ThreadSort),
  generation: Object.values(GenerationSort),
  tools: Object.values(ToolSort),
  buzzWithdrawalRequests: Object.values(BuzzWithdrawalRequestSort),
};

export function SortFilter(props: SortFilterProps) {
  if ('value' in props) return <DumbSortFilter {...props} />;
  return <StatefulSortFilter {...props} type={props.type} />;
}

type SortOption =
  | ModelSort
  | PostSort
  | ImageSort
  | QuestionSort
  | ArticleSort
  | CollectionSort
  | BountySort
  | GenerationSort
  | ThreadSort
  | ToolSort
  | BuzzWithdrawalRequestSort;

type DumbProps = {
  // Dumb props should work without needing to create a full filter attribute.
  value: SortOption;
  onChange: (value: SortOption) => void;
} & SortFilterComponentProps;

function DumbSortFilter({ type, value, onChange, ignoreNsfwLevel, options, ...props }: DumbProps) {
  const availability = useSortAvailability();

  return (
    <SelectMenuV2
      label={value}
      onClick={onChange}
      value={value}
      options={(options ?? sortOptions[type].map((x) => ({ label: x, value: x }))).filter(
        (x) => ignoreNsfwLevel || isSortAvailable({ type, value: x.value }, availability)
      )}
      {...props}
    />
  );
}

type StatefulProps = SortFilterComponentProps;

function StatefulSortFilter({ type, ...props }: StatefulProps) {
  const { query, pathname, replace } = useRouter();
  const globalSort = useFiltersContext((state) => state[type].sort);
  const querySort = query.sort as typeof globalSort | undefined;

  const setFilters = useSetFilters(type);
  const setSort = (sort: typeof globalSort) => {
    if (querySort && querySort !== sort)
      replace({ pathname, query: removeEmpty({ ...query, sort: undefined }) }, undefined, {
        shallow: true,
      });
    setFilters({ sort: sort as any });
  };

  const sort = querySort ? querySort : globalSort;
  return <DumbSortFilter type={type} value={sort} onChange={setSort} {...props} />;
}
