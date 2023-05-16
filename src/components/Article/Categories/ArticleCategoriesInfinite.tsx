import { IconArrowRight, IconPlus } from '@tabler/icons';

import { CategoryList } from '~/components/CategoryList/CategoryList';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { removeEmpty } from '~/utils/object-helpers';
import { useArticleFilters, useQueryArticleCategories } from '../article.utils';
import { ArticleCard } from '../Infinite/ArticleCard';

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
      isLoading={isLoading || isRefetching}
      fetchNextPage={fetchNextPage}
      hasNextPage={hasNextPage}
      actions={(category) =>
        !category.adminOnly || adminTags
          ? [
              {
                label: 'View more',
                href: `/articles?tags=${category.id}&view=feed`,
                icon: <IconArrowRight />,
                inTitle: true,
                shallow: true,
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
              },
            ]
      }
    />
  );
}
