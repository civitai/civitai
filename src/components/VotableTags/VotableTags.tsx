import { ActionIcon, Center, Group, GroupProps, Loader, MantineProvider } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconChevronDown, IconChevronUp } from '@tabler/icons';
import produce from 'immer';
import { useMemo } from 'react';
import { useVotableTagStore, VotableTag } from '~/components/VotableTags/VotableTag';
import { VotableTagAdd } from '~/components/VotableTags/VotableTagAdd';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { TagVotableEntityType, VotableTagModel } from '~/libs/tags';
import { trpc } from '~/utils/trpc';

const defaultVotable: Partial<VotableTagModel> = {
  id: 0,
  vote: 1,
  score: 1,
  upVotes: 1,
  downVotes: 0,
};

export function VotableTags({
  entityId: id,
  entityType: type,
  limit = 6,
  tags: initialTags,
  canAdd = false,
  ...props
}: GalleryTagProps) {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useContext();
  const setVote = useVotableTagStore((state) => state.setVote);
  const { data: tags = initialTags, isLoading } = trpc.tag.getVotableTags.useQuery(
    { id, type },
    { enabled: !initialTags }
  );
  canAdd = canAdd && !initialTags;

  const handleTagMutation = (changedTags: string[], vote: number) => {
    const preppedTags = changedTags.map(
      (tag) =>
        ({
          ...defaultVotable,
          name: tag,
          type: 'UserGenerated',
          vote,
        } as VotableTagModel)
    );
    console.log(changedTags);

    queryUtils.tag.getVotableTags.setData(
      { id, type },
      produce((old: VotableTagModel[] | undefined) => {
        if (!old) return;
        for (const tag of preppedTags) {
          const existingIndex = old.findIndex((x) => x.name === tag.name);
          if (existingIndex !== -1) {
            const existing = old[existingIndex];
            if (existing.id === 0 && vote <= 0) old.splice(existingIndex, 1);
            else {
              setVote({ entityId: id, entityType: type, name: tag.name, vote });
              existing.vote = vote;
            }
          } else old.push(tag);
        }
      })
    );
  };

  const { mutate: addVotes } = trpc.tag.addTagVotes.useMutation({
    onMutate: (x) => handleTagMutation(x.tags as string[], x.vote),
  });
  const { mutate: removeVotes } = trpc.tag.removeTagVotes.useMutation({
    onMutate: (x) => handleTagMutation(x.tags as string[], 0),
  });

  const [showAll, setShowAll] = useLocalStorage({ key: 'showAllTags', defaultValue: false });
  const displayedTags = useMemo(() => {
    if (!tags) return [];
    let displayTags = tags;
    if (currentUser?.isModerator) {
      displayTags = tags.sort((a, b) => {
        const aMod = a.type === 'Moderation';
        const bMod = b.type === 'Moderation';
        if (aMod && !bMod) return -1;
        if (!aMod && bMod) return 1;
        return 0;
      });
      console.log('sorted');
    }
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
            key={tag.name}
            entityId={id}
            entityType={type}
            tagId={tag.id}
            name={tag.name}
            initialVote={tag.vote}
            type={tag.type}
            score={tag.score}
            onChange={({ name, vote }) => {
              if (vote === 0) removeVotes({ tags: [name], type, id });
              else addVotes({ tags: [name], vote, type, id });
            }}
          />
        ))}
        {canAdd && (
          <VotableTagAdd
            addTag={(tag) => {
              console.log('add tag', tag);
              addVotes({ type, tags: [tag], vote: 1, id });
            }}
          />
        )}
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
  canAdd?: boolean;
} & Omit<GroupProps, 'id'>;
