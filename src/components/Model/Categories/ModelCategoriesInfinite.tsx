import { IconArrowRight, IconPlus } from '@tabler/icons';

import { CategoryList } from '~/components/CategoryList/CategoryList';
import { useModelFilters, useQueryModelCategories } from '~/components/Model/model.utils';
import { removeEmpty } from '~/utils/object-helpers';

import { ModelCategoryCard } from './ModelCategoryCard';

type ModelCategoriesState = {
  username?: string;
  modelId?: number;
  modelVersionId?: number;
};

export function ModelCategoriesInfinite({
  filters: filterOverrides = {},
  limit = 6,
}: {
  filters?: ModelCategoriesState;
  limit?: number;
}) {
  const globalFilters = useModelFilters();
  const filters = removeEmpty({ ...globalFilters, ...filterOverrides, limit, tags: undefined });

  const { categories, isLoading, fetchNextPage, hasNextPage } = useQueryModelCategories(filters);
  if (!categories) return null;

  return (
    <CategoryList
      data={categories}
      render={ModelCategoryCard}
      isLoading={isLoading}
      fetchNextPage={fetchNextPage}
      hasNextPage={hasNextPage}
      actions={[
        {
          label: 'View more',
          href: (category) => `/?tags=${category.id}&view=feed`,
          icon: <IconArrowRight />,
          inTitle: true,
        },
        {
          label: 'Make post',
          href: (category) => `/posts/create?tag=${category.id}`,
          icon: <IconPlus />,
          inTitle: true,
        },
      ]}
    />
  );
}
