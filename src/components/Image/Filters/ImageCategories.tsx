import { TagScroller } from '~/components/Tags/TagScroller';
import { useRouter } from 'next/router';
import { parseNumericStringArray } from '~/utils/query-string-helpers';
import { useCategoryTags } from '~/components/Tags/tag.utils';
import { TagTarget } from '@prisma/client';

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
  const { data: items } = useCategoryTags({ entityType: TagTarget.Image });

  return <TagScroller data={items} value={value} onChange={onChange} />;
}
