import { ModelSort } from '~/server/common/enums';
import { SelectMenu } from '~/components/SelectMenu/SelectMenu';
import { useModelFilters } from '~/hooks/useModelFilters';

const sortOptions = Object.values(ModelSort);

export function ListSort() {
  const {
    filters: { sort },
    setFilters,
  } = useModelFilters();

  return (
    <SelectMenu
      label={sort}
      options={sortOptions.map((x) => ({ label: x, value: x }))}
      onClick={(sort) => setFilters((state) => ({ ...state, sort }))}
      value={sort}
    />
  );
}
