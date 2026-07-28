import { CategoryTags } from '~/components/CategoryTags/CategoryTags';
import { useResourceSelectContext } from '~/components/ImageGeneration/GenerationForm/ResourceSelectProvider';

export function CategoryTagFilters() {
  const { categoryTag, setCategoryTag } = useResourceSelectContext();

  return (
    <CategoryTags
      selected={categoryTag}
      setSelected={(value) => setCategoryTag(value)}
      filter={(tag) => !['celebrity'].includes(tag)}
      includeEA={false}
      includeAll={false}
    />
  );
}
