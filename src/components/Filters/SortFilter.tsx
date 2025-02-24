import { ButtonProps } from '@mantine/core';
import { useRouter } from 'next/router';
import { SelectMenuV2 } from '~/components/SelectMenu/SelectMenu';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { FilterSubTypes, useFiltersContext, useSetFilters } from '~/providers/FiltersProvider';
import {
  ArticleSort,
  BountySort,
  BuzzWithdrawalRequestSort,
  ClubSort,
  CollectionSort,
  ImageSort,
  ImageSortHidden,
  GenerationSort,
  ModelSort,
  PostSort,
  QuestionSort,
  ThreadSort,
  ToolSort,
} from '~/server/common/enums';
import { removeEmpty } from '~/utils/object-helpers';
import clsx from 'clsx';

type SortFilterComponentProps = {
  type: FilterSubTypes;
  ignoreNsfwLevel?: boolean;
} & Omit<ButtonProps, 'children' | 'type'>;

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
  clubs: Object.values(ClubSort),
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

type DumbProps = {
  // Dumb props should work without needing to create a full filter attribute.
  value:
    | ModelSort
    | PostSort
    | ImageSort
    | QuestionSort
    | ArticleSort
    | CollectionSort
    | BountySort
    | ClubSort
    | GenerationSort
    | ThreadSort
    | ToolSort
    | BuzzWithdrawalRequestSort;
  onChange: (
    value:
      | ModelSort
      | PostSort
      | ImageSort
      | QuestionSort
      | ArticleSort
      | CollectionSort
      | BountySort
      | ClubSort
      | GenerationSort
      | ThreadSort
      | ToolSort
      | BuzzWithdrawalRequestSort
  ) => void;
} & SortFilterComponentProps;

function DumbSortFilter({ type, value, onChange, ignoreNsfwLevel, ...props }: DumbProps) {
  const showNsfw = useBrowsingSettings((x) => x.showNsfw);
  const { canViewNsfw } = useFeatureFlags();

  return (
    <SelectMenuV2
      label={value}
      onClick={onChange}
      value={value}
      options={sortOptions[type]
        .map((x) => ({ label: x, value: x }))
        .filter((x) => {
          if (ignoreNsfwLevel) return true;
          if (!canViewNsfw && (x.value === 'Newest' || x.value === 'Oldest')) return false;
          if (type === 'images') {
            if (!showNsfw && x.value === 'Newest') return false;
            return true;
          }
          return true;
        })}
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

export function HeaderSortFilter(props: SortFilterProps) {
  return (
    <SortFilter
      {...props}
      className={clsx(
        'h-8 bg-transparent',
        'text-gray-8 hover:bg-gray-3',
        'dark:text-white dark:hover:bg-dark-5',
        props.className
      )}
    />
  );
}
