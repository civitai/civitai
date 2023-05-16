import { IconArrowRight, IconPlus } from '@tabler/icons';
import { CategoryList } from '~/components/CategoryList/CategoryList';
import { useImageFilters, useQueryImageCategories } from '~/components/Image/image.utils';
import { removeEmpty } from '~/utils/object-helpers';
import { ImageCategoryCard } from './ImageCategoryCard';

type ImageCategoriesState = {
  username?: string;
  modelId?: number;
  modelVersionId?: number;
};

export function ImageCategoriesInfinite({
  filters: filterOverrides = {},
  limit = 6,
}: {
  filters?: ImageCategoriesState;
  limit?: number;
}) {
  const globalFilters = useImageFilters('images');
  const filters = removeEmpty({ ...globalFilters, ...filterOverrides, limit, tags: undefined });

  const { categories, isLoading, fetchNextPage, hasNextPage } = useQueryImageCategories(filters);
  if (!categories) return null;

  return (
    <CategoryList
      data={categories}
      render={ImageCategoryCard}
      isLoading={isLoading}
      fetchNextPage={fetchNextPage}
      hasNextPage={hasNextPage}
      actions={(category) => [
        {
          label: 'View more',
          href: `/images?tags=${category.id}&view=feed`,
          icon: <IconArrowRight />,
          inTitle: true,
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
