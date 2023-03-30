import { TagScroller } from '~/components/Tags/TagScroller';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { TagSort } from '~/server/common/enums';
import { trpc } from '~/utils/trpc';

export function ImageCategories() {
  const { data: { items } = { items: [] } } = trpc.tag.getAll.useQuery({
    entityType: ['Image'],
    sort: TagSort.MostImages,
    unlisted: false,
    categories: true,
    limit: 100,
  });

  const tags = useFiltersContext((state) => state.image.tags ?? []);
  const setFilters = useFiltersContext((state) => state.setFilters);

  return (
    <TagScroller data={items} value={tags} onChange={(tags) => setFilters({ image: { tags } })} />
  );
}
