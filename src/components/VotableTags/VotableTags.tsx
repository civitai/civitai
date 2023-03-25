import { ActionIcon, Center, Group, GroupProps, Loader } from '@mantine/core';
import { IconChevronDown, IconChevronUp } from '@tabler/icons';
import { useMemo, useState } from 'react';
import { VotableTag } from '~/components/VotableTags/VotableTag';
import { TagVotableEntityType, VotableTagModel } from '~/libs/tags';
import { trpc } from '~/utils/trpc';

export function VotableTags({
  entityId: id,
  entityType: type,
  limit = 6,
  tags: initialTags,
  ...props
}: GalleryTagProps) {
  const { data: tags = initialTags, isLoading } = trpc.tag.getVotableTags.useQuery(
    { id, type },
    { enabled: !initialTags }
  );
  const { mutate: addVotes } = trpc.tag.addTagVotes.useMutation();
  const { mutate: removeVotes } = trpc.tag.removeTagVotes.useMutation();

  const [showAll, setShowAll] = useState(false);
  const displayedTags = useMemo(() => {
    if (!tags) return [];
    if (showAll) return tags;
    return tags.slice(0, limit);
  }, [tags, showAll, limit]);

  if (isLoading)
    return (
      <Center p="xl">
        <Loader variant="bars" />
      </Center>
    );
  if (!tags) return null;

  return (
    <Group spacing={4} px="md" {...props}>
      {displayedTags.map((tag) => (
        <VotableTag
          key={tag.id}
          entityId={id}
          entityType={type}
          tagId={tag.id}
          name={tag.name}
          vote={tag.vote}
          type={tag.type}
          score={tag.score}
          onChange={({ tagId, vote }) => {
            if (vote === 0) removeVotes({ tags: [tagId], type, id });
            else addVotes({ tags: [tagId], vote, type, id });
          }}
        />
      ))}
      {tags.length > limit && (
        <ActionIcon variant="transparent" size="sm" onClick={() => setShowAll((prev) => !prev)}>
          {showAll ? <IconChevronUp strokeWidth={3} /> : <IconChevronDown strokeWidth={3} />}
        </ActionIcon>
      )}
    </Group>
  );
}

type GalleryTagProps = {
  entityId: number;
  entityType: TagVotableEntityType;
  limit?: number;
  tags?: VotableTagModel[];
} & Omit<GroupProps, 'id'>;
