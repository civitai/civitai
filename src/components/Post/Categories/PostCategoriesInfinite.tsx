import { IconArrowRight, IconPlus } from '@tabler/icons-react';
import { CategoryList } from '~/components/CategoryList/CategoryList';
import { CategoryListEmpty } from '~/components/CategoryList/CategoryListEmpty';
import { usePostFilters, useQueryPostCategories } from '~/components/Post/post.utils';
import { removeEmpty } from '~/utils/object-helpers';
import { PostCategoryCard } from './PostCategoryCard';

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

  const { categories, isLoading, isRefetching, fetchNextPage, hasNextPage } =
    useQueryPostCategories(filters);
  if (!categories) return null;

  return (
    <CategoryList
      data={categories}
      render={PostCategoryCard}
      isLoading={isLoading}
      isRefetching={isRefetching}
      fetchNextPage={fetchNextPage}
      hasNextPage={hasNextPage}
      empty={({ id }) => <CategoryListEmpty type="post" categoryId={id} />}
      actions={(category) => [
        {
          label: 'View more',
          href: `/posts?tags=${category.id}&view=feed`,
          icon: <IconArrowRight />,
          inTitle: true,
          visible: !!category.items.length,
        },
        {
          label: 'Make post',
          href: `/posts/create?tag=${category.id}`,
          icon: <IconPlus />,
          inTitle: true,
        },
      ]}
    />
  );
}
