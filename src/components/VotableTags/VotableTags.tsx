import { ActionIcon, Center, Group, GroupProps, Loader, MantineProvider } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconChevronDown, IconChevronUp } from '@tabler/icons';
import { useMemo } from 'react';
import { VotableTag } from '~/components/VotableTags/VotableTag';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { TagVotableEntityType, VotableTagModel } from '~/libs/tags';
import { trpc } from '~/utils/trpc';

export function VotableTags({
  entityId: id,
  entityType: type,
  limit = 6,
  tags: initialTags,
  ...props
}: GalleryTagProps) {
  const currentUser = useCurrentUser();
  const { data: tags = initialTags, isLoading } = trpc.tag.getVotableTags.useQuery(
    { id, type },
    { enabled: !initialTags }
  );
  const { mutate: addVotes } = trpc.tag.addTagVotes.useMutation();
  const { mutate: removeVotes } = trpc.tag.removeTagVotes.useMutation();

  const [showAll, setShowAll] = useLocalStorage({ key: 'showAllTags', defaultValue: false });
  const displayedTags = useMemo(() => {
    if (!tags) return [];
    let displayTags = tags;
    if (currentUser?.isModerator)
      displayTags = tags.sort((a, b) => {
        const aMod = a.type === 'Moderation';
        const bMod = b.type === 'Moderation';
        if (aMod && !bMod) return -1;
        if (!aMod && bMod) return 1;
        return 0;
      });
    if (showAll) return displayTags;
    return displayTags.slice(0, limit);
  }, [tags, showAll, limit, currentUser?.isModerator]);

  if (!initialTags && isLoading)
    return (
      <Center p="xl">
        <Loader variant="bars" />
      </Center>
    );
  if (!tags) return null;

  return (
    <MantineProvider theme={{ colorScheme: 'dark' }}>
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
    </MantineProvider>
  );
}

type GalleryTagProps = {
  entityId: number;
  entityType: TagVotableEntityType;
  limit?: number;
  tags?: VotableTagModel[];
} & Omit<GroupProps, 'id'>;
