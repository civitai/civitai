import { IconArrowRight, IconPlus } from '@tabler/icons';

import { CategoryList } from '~/components/CategoryList/CategoryList';
import { removeEmpty } from '~/utils/object-helpers';

import { useArticleFilters, useQueryArticleCategories } from '../article.utils';
import { ArticleCard } from '../Infinite/ArticleCard';
import { CategoryListEmpty } from '~/components/CategoryList/CategoryListEmpty';

type ArticleCategoriesState = {
  articleId?: number;
};

export function ArticleCategoriesInfinite({
  filters: filterOverrides = {},
  limit = 6,
}: {
  filters?: ArticleCategoriesState;
  limit?: number;
}) {
  const globalFilters = useArticleFilters();
  const filters = removeEmpty({ ...globalFilters, ...filterOverrides, limit, tags: undefined });

  const { categories, isLoading, isRefetching, fetchNextPage, hasNextPage } =
    useQueryArticleCategories(filters);
  if (!categories) return null;

  return (
    <CategoryList
      data={categories}
      render={ArticleCard}
      isLoading={isLoading}
      isRefetching={isRefetching}
      fetchNextPage={fetchNextPage}
      hasNextPage={hasNextPage}
      empty={({ id }) => <CategoryListEmpty type="article" categoryId={id} />}
      actions={(items) => [
        {
          label: 'View more',
          href: (category) => `/articles?tags=${category.id}&view=feed`,
          icon: <IconArrowRight />,
          inTitle: true,
          shallow: true,
          visible: !!items.length,
        },
        {
          label: 'Create an article',
          href: (category) => `/articles/create?category=${category.id}`,
          icon: <IconPlus />,
          inTitle: true,
        },
      ]}
    />
  );
}
