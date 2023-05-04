import { useRouter } from 'next/router';
import { IsClient } from '~/components/IsClient/IsClient';
import { SelectMenu } from '~/components/SelectMenu/SelectMenu';
import { FilterSubTypes, useFiltersContext, useSetFilters } from '~/providers/FiltersProvider';
import { ImageSort, ModelSort, PostSort, QuestionSort } from '~/server/common/enums';
import { removeEmpty } from '~/utils/object-helpers';

type SortFilterProps = StatefulProps | DumbProps;

const sortOptions = {
  models: Object.values(ModelSort),
  posts: Object.values(PostSort),
  images: Object.values(ImageSort),
  modelImages: Object.values(ImageSort),
  questions: Object.values(QuestionSort),
};

export function SortFilter(props: SortFilterProps) {
  if (props.value) return <DumbSortFilter {...props} />;
  return <StatefulSortFilter type={props.type} />;
}

type DumbProps = {
  type: FilterSubTypes;
  value: ModelSort | PostSort | ImageSort | QuestionSort;
  onChange: (value: ModelSort | PostSort | ImageSort | QuestionSort) => void;
};
function DumbSortFilter({ type, value, onChange }: DumbProps) {
  return (
    <IsClient>
      <SelectMenu
        label={value}
        options={sortOptions[type].map((x) => ({ label: x, value: x }))}
        onClick={onChange}
        value={value}
      />
    </IsClient>
  );
}

type StatefulProps = {
  type: FilterSubTypes;
  value?: undefined;
  onChange?: undefined;
};
function StatefulSortFilter({ type }: StatefulProps) {
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
  return <DumbSortFilter type={type} value={sort} onChange={setSort} />;
}
