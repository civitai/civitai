import { ActionIcon, Center, Group, GroupProps, Loader, MantineProvider } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { TagType } from '@prisma/client';
import { IconChevronDown, IconChevronUp } from '@tabler/icons-react';
import produce from 'immer';
import { useMemo } from 'react';
import { useVotableTagStore, VotableTag } from '~/components/VotableTags/VotableTag';
import { VotableTagAdd } from '~/components/VotableTags/VotableTagAdd';
import { VotableTagMature } from '~/components/VotableTags/VotableTagMature';
import { useVoteForTags } from '~/components/VotableTags/votableTag.utils';
import { useUpdateHiddenPreferences } from '~/hooks/hidden-preferences';
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
  const { data: tags = [], isLoading } = trpc.tag.getVotableTags.useQuery(
    { id, type },
    { enabled: !initialTags, initialData: initialTags }
  );
  canAdd = canAdd && !initialTags;
  canAddModerated = canAddModerated && !initialTags;

  const handleVote = useVoteForTags({ entityType: type, entityId: id });

  const [showAll, setShowAll] = useLocalStorage({ key: 'showAllTags', defaultValue: false });
  const displayedTags = useMemo(() => {
    if (!tags) return [];
    const displayTags = [...tags].sort((a, b) => {
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
  }, [tags, showAll, collapsible, limit]);

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
              handleVote({ tags: [tag], vote: 1 });
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
            needsReview={tag.needsReview}
            concrete={tag.concrete}
            lastUpvote={tag.lastUpvote}
            type={tag.type}
            nsfw={tag.nsfw}
            score={tag.score}
            onChange={({ name, vote }) => {
              handleVote({ tags: [name], vote });
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
                  handleVote({ tags: [tag], vote, tagType: 'Moderation' });
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
