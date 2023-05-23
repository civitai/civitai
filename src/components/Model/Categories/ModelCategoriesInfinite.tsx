import { IconArrowRight, IconPlus } from '@tabler/icons-react';

import { CategoryList } from '~/components/CategoryList/CategoryList';
import { CategoryListEmpty } from '~/components/CategoryList/CategoryListEmpty';
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

  const { categories, isLoading, isRefetching, fetchNextPage, hasNextPage } =
    useQueryModelCategories(filters);
  if (!categories) return null;

  return (
    <CategoryList
      data={categories}
      render={ModelCategoryCard}
      isLoading={isLoading}
      isRefetching={isRefetching}
      itemId={(x) => x.id}
      fetchNextPage={fetchNextPage}
      hasNextPage={hasNextPage}
      empty={({ id }) => <CategoryListEmpty type="model" categoryId={id} />}
      actions={(category) => [
        {
          label: 'View more',
          href: `/?tag=${encodeURIComponent(category.name)}&view=feed`,
          icon: <IconArrowRight />,
          inTitle: true,
          shallow: true,
          visible: !!category.items.length,
        },
        {
          label: 'Upload a model',
          href: `/models/create?category=${category.id}`,
          icon: <IconPlus />,
          inTitle: true,
        },
      ]}
    />
  );
}
