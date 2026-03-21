import { useState } from 'react';
import { useRefinementList } from 'react-instantsearch';
import { CategoryTags } from '~/components/CategoryTags/CategoryTags';

export function CategoryTagFilters() {
  const [tag, setTag] = useState<string>();
  const { refine } = useRefinementList({ attribute: 'tags.name' });

  const handleSetTag = (value?: string) => {
    if (tag) refine(tag);
    if (value) refine(value);
    setTag(value);
  };

  return (
    <CategoryTags
      selected={tag}
      setSelected={handleSetTag}
      filter={(tag) => !['celebrity'].includes(tag)}
      includeEA={false}
      includeAll={false}
    />
  );
}
