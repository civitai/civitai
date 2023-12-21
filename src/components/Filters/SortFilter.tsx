import { useRouter } from 'next/router';
import { IsClient } from '~/components/IsClient/IsClient';
import { SelectMenu, SelectMenuV2 } from '~/components/SelectMenu/SelectMenu';
import { FilterSubTypes, useFiltersContext, useSetFilters } from '~/providers/FiltersProvider';
import {
  ArticleSort,
  BountySort,
  ClubSort,
  CollectionSort,
  ImageSort,
  ImageSortHidden,
  ModelSort,
  PostSort,
  QuestionSort,
} from '~/server/common/enums';
import { removeEmpty } from '~/utils/object-helpers';

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
};

export function SortFilter(props: SortFilterProps) {
  if (props.value) return <DumbSortFilter {...props} />;
  return <StatefulSortFilter {...props} type={props.type} />;
}

type DumbProps = {
  type: FilterSubTypes;
  variant?: 'menu' | 'button';
  includeNewest?: boolean;
  value:
    | ModelSort
    | PostSort
    | ImageSort
    | QuestionSort
    | ArticleSort
    | CollectionSort
    | BountySort
    | ClubSort;
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
  ) => void;
};
function DumbSortFilter({
  type,
  value,
  onChange,
  variant = 'menu',
  includeNewest = true,
}: DumbProps) {
  const sharedProps = {
    label: value,
    options: sortOptions[type]
      .map((x) => ({ label: x, value: x }))
      .filter((x) => includeNewest || x.value !== 'Newest'),
    onClick: onChange,
    value,
  };

  return (
    <IsClient>
      {variant === 'menu' && <SelectMenu {...sharedProps} />}
      {variant === 'button' && <SelectMenuV2 {...sharedProps} />}
    </IsClient>
  );
}

type StatefulProps = {
  type: FilterSubTypes;
  value?: undefined;
  onChange?: undefined;
  variant?: 'menu' | 'button';
  includeNewest?: boolean;
};
function StatefulSortFilter({ type, variant, includeNewest }: StatefulProps) {
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
    <DumbSortFilter
      type={type}
      value={sort}
      onChange={setSort}
      variant={variant}
      includeNewest={includeNewest}
    />
  );
}
