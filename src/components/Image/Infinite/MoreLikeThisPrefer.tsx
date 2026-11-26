import { Chip, Pill, Text } from '@mantine/core';
import { useRouter } from 'next/router';
import type { ReactNode } from 'react';
import { useState } from 'react';
import type { PickedTag } from '~/components/SemanticSearch/TagMultiPicker';
import { TagMultiPicker } from '~/components/SemanticSearch/TagMultiPicker';
import { removeEmpty } from '~/utils/object-helpers';
import { trpc } from '~/utils/trpc';

const ANCHOR_TAG_CHIPS = 8;

/**
 * "More like this" steering: one tag whose images move ahead among the closest matches. Picked from
 * the anchor's own tags or by search; a new pick is a history entry, so Back undoes it.
 */
export function MoreLikeThisPrefer({
  imageId,
  preferTagId,
}: {
  imageId: number;
  preferTagId?: number;
}) {
  const router = useRouter();
  const [picked, setPicked] = useState<PickedTag>();
  const { data: tags = [] } = trpc.tag.getVotableTags.useQuery({ id: imageId, type: 'image' });

  const setPrefer = (tagId: number | undefined) =>
    void router.push(
      { pathname: router.pathname, query: removeEmpty({ ...router.query, prefer: tagId }) },
      undefined,
      { shallow: true }
    );
  const searched = picked?.id === preferTagId ? picked : undefined;

  return (
    <PreferTagChips
      anchorTags={tags.slice(0, ANCHOR_TAG_CHIPS)}
      preferTagId={preferTagId}
      searchedTagId={searched?.id}
      onPrefer={setPrefer}
    >
      <div className="w-48">
        <TagMultiPicker
          placeholder="+ tag"
          value={searched ? [searched] : []}
          onChange={(next) => {
            const tag = next.find((t) => t.id !== searched?.id);
            setPicked(tag);
            setPrefer(tag?.id);
          }}
        />
      </div>
    </PreferTagChips>
  );
}

/** The Prefer row: the anchor's tags as single-select chips, then `children` (the tag search). */
export function PreferTagChips({
  anchorTags,
  preferTagId,
  searchedTagId,
  onPrefer,
  children,
}: {
  anchorTags: { id: number; name: string }[];
  preferTagId?: number;
  /** The preferred tag when it was picked by search, so the picker shows it. */
  searchedTagId?: number;
  onPrefer: (tagId: number | undefined) => void;
  children?: ReactNode;
}) {
  // A preferred tag from a shared link that is neither the anchor's nor searched here.
  const fromLink =
    !!preferTagId && preferTagId !== searchedTagId && !anchorTags.some((t) => t.id === preferTagId);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Text size="sm" fw={500}>
          Prefer:
        </Text>
        {anchorTags.map((tag) => (
          <Chip
            key={tag.id}
            size="xs"
            checked={tag.id === preferTagId}
            onChange={(checked) => onPrefer(checked ? tag.id : undefined)}
          >
            {tag.name}
          </Chip>
        ))}
        {fromLink && (
          <Pill withRemoveButton onRemove={() => onPrefer(undefined)}>
            A preferred tag
          </Pill>
        )}
        {children}
      </div>
      <Text size="xs" c="dimmed">
        Matches the subject first; use Prefer to favour a style or trait.
      </Text>
    </div>
  );
}
