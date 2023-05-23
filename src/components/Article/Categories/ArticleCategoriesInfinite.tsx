import { IconArrowRight, IconPlus } from '@tabler/icons-react';

import { CategoryList } from '~/components/CategoryList/CategoryList';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { removeEmpty } from '~/utils/object-helpers';
import { useArticleFilters, useQueryArticleCategories } from '../article.utils';
import { ArticleCard } from '../Infinite/ArticleCard';
import { CategoryListEmpty } from '~/components/CategoryList/CategoryListEmpty';
import { GetArticlesByCategorySchema } from '~/server/schema/article.schema';

// type ArticleCategoriesState = {
//   articleId?: number;
// };

export function ArticleCategoriesInfinite({
  filters: filterOverrides = {},
  limit = 6,
}: {
  filters?: Partial<GetArticlesByCategorySchema>;
  limit?: number;
}) {
  const { adminTags } = useFeatureFlags();
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
      actions={(category) =>
        !category.adminOnly || adminTags
          ? [
              {
                label: 'View more',
                href: `/articles?tags=${category.id}&view=feed`,
                icon: <IconArrowRight />,
                inTitle: true,
                shallow: true,
                visible: !!category.items.length,
              },
              {
                label: 'Create an article',
                href: `/articles/create?category=${category.id}`,
                icon: <IconPlus />,
                inTitle: true,
              },
            ]
          : [
              {
                label: 'View more',
                href: `/articles?tags=${category.id}&view=feed`,
                icon: <IconArrowRight />,
                inTitle: true,
                shallow: true,
                visible: !!category.items.length,
              },
            ]
      }
    />
  );
}
