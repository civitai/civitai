import { useMemo } from 'react';
import { PostCategoryCard } from './PostCategoryCard';
import { usePostFilters, useQueryPostCategories } from '~/components/Post/post.utils';
import { removeEmpty } from '~/utils/object-helpers';
import { IconArrowRight, IconPlus } from '@tabler/icons';
import { CategoryList } from '~/components/CategoryList/CategoryList';

type PostCategoriesState = {
  username?: string;
  modelId?: number;
  modelVersionId?: number;
};

export function PostCategoriesInfinite({
  filters: filterOverrides = {},
  limit = 6,
}: {
  filters?: PostCategoriesState;
  limit?: number;
}) {
  const globalFilters = usePostFilters();
  const filters = removeEmpty({ ...globalFilters, ...filterOverrides, limit, tags: undefined });

  const { categories, isLoading, fetchNextPage, hasNextPage } = useQueryPostCategories(filters);
  if (!categories) return null;

  return (
    <CategoryList
      data={categories}
      render={PostCategoryCard}
      isLoading={isLoading}
      fetchNextPage={fetchNextPage}
      hasNextPage={hasNextPage}
      actions={[
        {
          label: 'View more',
          href: (category) => `/posts?tags=${category.id}&view=feed`,
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
