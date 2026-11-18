import type { PickedTag } from '~/components/SemanticSearch/TagMultiPicker';
import { TagMultiPicker } from '~/components/SemanticSearch/TagMultiPicker';
import { trpc } from '~/utils/trpc';

/** The feed's `?tags=` as a picker: the URL holds ids, so the names of tags already set are looked up. */
export function FeedTagFilter({
  value,
  onChange,
}: {
  value: number[];
  onChange: (tagIds: number[]) => void;
}) {
  const named = trpc.useQueries((t) => value.map((id) => t.tag.getById({ id })));
  const picked: PickedTag[] = value.map((id, index) => ({
    id,
    name: named[index]?.data?.name ?? `#${id}`,
  }));

  return (
    <TagMultiPicker
      placeholder="Search tags"
      value={picked}
      onChange={(tags) => onChange(tags.map((tag) => tag.id))}
      comboboxProps={{ withinPortal: false }}
    />
  );
}
