import { usePostQueryParams } from '~/components/Post/post.utils';
import { TagScroller } from '~/components/Tags/TagScroller';
import { trpc } from '~/utils/trpc';

export function PostCategories() {
  const { data: items = [] } = trpc.post.getTags.useQuery({ limit: 100 });
  const { tags, set } = usePostQueryParams();

  return <TagScroller data={items} value={tags} onChange={(tags) => set({ tags })} />;
}
