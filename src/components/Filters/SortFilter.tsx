import { ButtonProps } from '@mantine/core';
import { useRouter } from 'next/router';
import { SelectMenu, SelectMenuV2 } from '~/components/SelectMenu/SelectMenu';
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
  MarkerSort,
  ModelSort,
  PostSort,
  QuestionSort,
  ThreadSort,
  ToolSort,
} from '~/server/common/enums';
import { removeEmpty } from '~/utils/object-helpers';

type SortFilterButtonProps = {
  variant: 'button';
  buttonProps?: ButtonProps;
};
type SortFilterMenuProps = {
  variant?: 'menu';
};
type SortFilterComponentProps = SortFilterButtonProps | SortFilterMenuProps;

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
  markers: Object.values(MarkerSort),
  tools: Object.values(ToolSort),
  buzzWithdrawalRequests: Object.values(BuzzWithdrawalRequestSort),
};

export function SortFilter(props: SortFilterProps) {
  if (props.value) return <DumbSortFilter {...props} />;
  return <StatefulSortFilter {...props} type={props.type} />;
}

type DumbProps = {
  // Dumb props should work without needing to create a full filter attribute.
  type: FilterSubTypes;
  value:
    | ModelSort
    | PostSort
    | ImageSort
    | QuestionSort
    | ArticleSort
    | CollectionSort
    | BountySort
    | ClubSort
    | MarkerSort
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
      | MarkerSort
      | ThreadSort
      | ToolSort
      | BuzzWithdrawalRequestSort
  ) => void;
} & SortFilterComponentProps;

function DumbSortFilter({ type, value, onChange, ...props }: DumbProps) {
  const showNsfw = useBrowsingSettings((x) => x.showNsfw);
  const { canViewNsfw } = useFeatureFlags();
  const sharedProps = {
    label: value,
    options: sortOptions[type]
      .map((x) => ({ label: x, value: x }))
      .filter((x) => {
        if (!canViewNsfw && (x.value === 'Newest' || x.value === 'Oldest')) return false;
        if (type === 'images') {
          if (!showNsfw && x.value === 'Newest') return false;
          return true;
        }
        return true;
      }),
    onClick: onChange,
    value,
  };
  props.variant ??= 'menu';

  return (
    <>
      {props.variant === 'menu' && <SelectMenu {...sharedProps} />}
      {props.variant === 'button' && (
        <SelectMenuV2 {...sharedProps} buttonProps={props.buttonProps} />
      )}
    </>
  );
}

type StatefulProps = {
  type: FilterSubTypes;
  value?: undefined;
  onChange?: undefined;
} & SortFilterComponentProps;

function StatefulSortFilter({ type, variant, ...props }: StatefulProps) {
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
  return (
    <DumbSortFilter type={type} value={sort} onChange={setSort} variant={variant} {...props} />
  );
}
