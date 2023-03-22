import { TagScroller } from '~/components/Tags/TagScroller';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { TagSort } from '~/server/common/enums';
import { trpc } from '~/utils/trpc';

export function PostCategories() {
  // const { data: { items } = { items: [] } } = trpc.tag.getAll.useQuery({
  //   entityType: ['Post'],
  //   sort: TagSort.MostPosts,
  //   unlisted: false,
  //   categories: true,
  //   limit: 100,
  // });

  const { data: items = [] } = trpc.post.getTags.useQuery({ limit: 100 });

  const tags = useFiltersContext((state) => state.post.tags);
  const setFilters = useFiltersContext((state) => state.setFilters);

  return (
    <TagScroller data={items} value={tags} onChange={(tags) => setFilters({ post: { tags } })} />
  );
}
