import { TagScroller } from '~/components/Tags/TagScroller';
import { TagSort } from '~/server/common/enums';
import { trpc } from '~/utils/trpc';
import { useRouter } from 'next/router';
import { parseNumericStringArray } from '~/utils/query-string-helpers';

export function ImageCategories() {
  const router = useRouter();
  const tagIds = parseNumericStringArray(router.query.tags);
  const handleChange = (ids: number[]) => {
    const { pathname, query } = router;
    router.replace({ pathname, query: { ...query, tags: ids } }, undefined, {
      shallow: true,
      scroll: false,
    });
  };

  return <DumbImageCategories value={tagIds ?? []} onChange={handleChange} />;
}

export function DumbImageCategories({
  value,
  onChange,
}: {
  value: number[];
  onChange: (ids: number[]) => void;
}) {
  const { data: { items } = { items: [] } } = trpc.tag.getAll.useQuery({
    entityType: ['Image'],
    sort: TagSort.MostImages,
    unlisted: false,
    categories: true,
    limit: 100,
  });

  return <TagScroller data={items} value={value} onChange={onChange} />;
}
