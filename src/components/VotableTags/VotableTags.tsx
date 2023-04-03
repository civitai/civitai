import { ActionIcon, Center, Group, GroupProps, Loader, MantineProvider } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { TagType } from '@prisma/client';
import { IconChevronDown, IconChevronUp } from '@tabler/icons';
import produce from 'immer';
import { useMemo } from 'react';
import { useVotableTagStore, VotableTag } from '~/components/VotableTags/VotableTag';
import { VotableTagAdd } from '~/components/VotableTags/VotableTagAdd';
import { VotableTagMature } from '~/components/VotableTags/VotableTagMature';
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
  canAddModerated = false,
  collapsible = false,
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
  canAddModerated = canAddModerated && !initialTags;

  const handleTagMutation = (changedTags: string[], vote: number, tagType: TagType) => {
    const preppedTags = changedTags.map(
      (tag) =>
        ({
          ...defaultVotable,
          name: tag,
          type: tagType,
          vote,
        } as VotableTagModel)
    );

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

  const { mutate: addVotes } = trpc.tag.addTagVotes.useMutation();
  const { mutate: removeVotes } = trpc.tag.removeTagVotes.useMutation();

  const handleVote = ({ tag, tagType, vote }: { tag: string; tagType?: TagType; vote: number }) => {
    tagType ??= 'UserGenerated';
    if (vote == 0) removeVotes({ tags: [tag], type, id });
    else addVotes({ tags: [tag], vote, type, id });
    handleTagMutation([tag], vote, tagType);
  };

  const [showAll, setShowAll] = useLocalStorage({ key: 'showAllTags', defaultValue: false });
  const displayedTags = useMemo(() => {
    if (!tags) return [];
    const displayTags = tags.sort((a, b) => {
      const aMod = a.type === 'Moderation';
      const bMod = b.type === 'Moderation';
      const aNew = a.id === 0;
      const bNew = b.id === 0;
      if (aNew && !bNew) return -1;
      if (!aNew && bNew) return 1;
      if (aMod && !bMod) return -1;
      if (!aMod && bMod) return 1;
      return 0;
    });
    if (!collapsible || showAll) return displayTags;
    return displayTags.slice(0, limit);
  }, [tags, showAll, collapsible, limit, currentUser?.isModerator]);

  if (!initialTags && isLoading)
    return (
      <Center p="xl">
        <Loader variant="bars" />
      </Center>
    );
  if (!tags) return null;

  const showAddibles = !collapsible || showAll;
  return (
    <MantineProvider theme={{ colorScheme: 'dark' }}>
      <Group spacing={4} {...props}>
        {canAdd && (
          <VotableTagAdd
            addTag={(tag) => {
              handleVote({ tag, vote: 1 });
            }}
          />
        )}
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
              handleVote({ tag: name, vote });
            }}
          />
        ))}
        {showAddibles && (
          <>
            {canAddModerated && (
              <VotableTagMature
                tags={tags}
                addTag={(tag) => {
                  const vote = tags.find((x) => x.name === tag && x.id === 0) ? 0 : 1;
                  handleVote({ tag, vote, tagType: 'Moderation' });
                }}
              />
            )}
          </>
        )}
        {collapsible && tags.length > limit && (
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
  canAddModerated?: boolean;
  collapsible?: boolean;
} & Omit<GroupProps, 'id'>;
