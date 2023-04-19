import { IsClient } from '~/components/IsClient/IsClient';
import { SelectMenu } from '~/components/SelectMenu/SelectMenu';
import { FilterSubTypes, useFiltersContext, useSetFilters } from '~/providers/FiltersProvider';
import { ImageSort, ModelSort, PostSort, QuestionSort } from '~/server/common/enums';

type SortFilterProps = {
  type: FilterSubTypes;
};

const sortOptions = {
  models: Object.values(ModelSort),
  posts: Object.values(PostSort),
  images: Object.values(ImageSort),
  modelImages: Object.values(ImageSort),
  questions: Object.values(QuestionSort),
};

export function SortFilter({ type }: SortFilterProps) {
  const sort = useFiltersContext((state) => state[type].sort);
  const setFilters = useSetFilters(type);

  return (
    <IsClient>
      <SelectMenu
        label={sort}
        options={sortOptions[type].map((x) => ({ label: x, value: x }))}
        onClick={(sort) => setFilters({ sort: sort as any })}
        value={sort}
      />
    </IsClient>
  );
}
