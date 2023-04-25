import { IsClient } from '~/components/IsClient/IsClient';
import { SelectMenu } from '~/components/SelectMenu/SelectMenu';
import { FilterSubTypes, useFiltersContext, useSetFilters } from '~/providers/FiltersProvider';
import { ImageSort, ModelSort, PostSort, QuestionSort } from '~/server/common/enums';

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
  const sort = useFiltersContext((state) => state[type].sort);
  const setFilters = useSetFilters(type);

  return (
    <DumbSortFilter
      type={type}
      value={sort}
      onChange={(sort) => setFilters({ sort: sort as any })}
    />
  );
}
