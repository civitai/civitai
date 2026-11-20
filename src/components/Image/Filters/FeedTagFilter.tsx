import { useRef } from 'react';
import type { PickedTag } from '~/components/SemanticSearch/TagMultiPicker';
import { TagMultiPicker } from '~/components/SemanticSearch/TagMultiPicker';
import { trpc } from '~/utils/trpc';

/**
 * The feed's `?tags=` as a picker. The URL holds ids, so a tag that came from a link is looked up
 * by id for its name; one picked here already has it.
 */
export function FeedTagFilter({
  value,
  onChange,
}: {
  value: number[];
  onChange: (tagIds: number[]) => void;
}) {
  const pickedNames = useRef(new Map<number, string>());
  const unnamed = value.filter((id) => !pickedNames.current.has(id));
  const lookedUp = trpc.useQueries((t) => unnamed.map((id) => t.tag.getById({ id })));
  const lookedUpNames = new Map(unnamed.map((id, index) => [id, lookedUp[index]?.data?.name]));

  const picked: PickedTag[] = value.map((id) => ({
    id,
    name: pickedNames.current.get(id) ?? lookedUpNames.get(id) ?? `#${id}`,
  }));

  return (
    <TagMultiPicker
      placeholder="Search tags"
      value={picked}
      onChange={(tags) => {
        for (const tag of tags) pickedNames.current.set(tag.id, tag.name);
        onChange(tags.map((tag) => tag.id));
      }}
      comboboxProps={{ withinPortal: false }}
    />
  );
}
