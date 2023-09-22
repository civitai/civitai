import { useRouter } from 'next/router';
import { IsClient } from '~/components/IsClient/IsClient';
import { SelectMenu, SelectMenuV2 } from '~/components/SelectMenu/SelectMenu';
import { FilterSubTypes, useFiltersContext, useSetFilters } from '~/providers/FiltersProvider';
import {
  ArticleSort,
  BountySort,
  CollectionSort,
  ImageSort,
  ModelSort,
  PostSort,
  QuestionSort,
} from '~/server/common/enums';
import { removeEmpty } from '~/utils/object-helpers';

type SortFilterProps = StatefulProps | DumbProps;

const sortOptions = {
  models: Object.values(ModelSort),
  posts: Object.values(PostSort),
  images: Object.values(ImageSort),
  modelImages: Object.values(ImageSort),
  questions: Object.values(QuestionSort),
  articles: Object.values(ArticleSort),
  collections: Object.values(CollectionSort),
  bounties: Object.values(BountySort),
};

export function SortFilter(props: SortFilterProps) {
  if (props.value) return <DumbSortFilter {...props} />;
  return <StatefulSortFilter {...props} type={props.type} />;
}

type DumbProps = {
  type: FilterSubTypes;
  variant?: 'menu' | 'button';
  value:
    | ModelSort
    | PostSort
    | ImageSort
    | QuestionSort
    | ArticleSort
    | CollectionSort
    | BountySort;
  onChange: (
    value:
      | ModelSort
      | PostSort
      | ImageSort
      | QuestionSort
      | ArticleSort
      | CollectionSort
      | BountySort
  ) => void;
};
function DumbSortFilter({ type, value, onChange, variant = 'menu' }: DumbProps) {
  const sharedProps = {
    label: value,
    options: sortOptions[type].map((x) => ({ label: x, value: x })),
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
};
function StatefulSortFilter({ type, variant }: StatefulProps) {
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
  return <DumbSortFilter type={type} value={sort} onChange={setSort} variant={variant} />;
}
