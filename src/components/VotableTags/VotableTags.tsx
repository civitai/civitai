import { ActionIcon, Center, Group, GroupProps, Loader, createStyles } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconChevronDown, IconChevronUp } from '@tabler/icons-react';
import { useMemo } from 'react';
import { openSetBrowsingLevelModal } from '~/components/Dialog/dialog-registry';
import { BrowsingLevelBadge } from '~/components/ImageGuard/ImageGuard2';
import { VotableTag } from '~/components/VotableTags/VotableTag';
import { VotableTagAdd } from '~/components/VotableTags/VotableTagAdd';
import { VotableTagMature } from '~/components/VotableTags/VotableTagMature';
import { useVoteForTags } from '~/components/VotableTags/votableTag.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { TagVotableEntityType, VotableTagModel } from '~/libs/tags';
import { getIsPublicBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { trpc } from '~/utils/trpc';

export function VotableTags({
  entityId: id,
  entityType: type,
  limit = 6,
  tags: initialTags,
  canAdd = false,
  canAddModerated: _canAddModerated,
  collapsible = false,
  nsfwLevel,
  ...props
}: GalleryTagProps) {
  const currentUser = useCurrentUser();
  const { classes } = useStyles();
  const { data: tags = [], isLoading } = trpc.tag.getVotableTags.useQuery(
    { id, type },
    { enabled: !initialTags, initialData: initialTags }
  );
  const canAddModerated = (canAdd || _canAddModerated) && !!currentUser?.isModerator;

  const handleVote = useVoteForTags({ entityType: type, entityId: id });

  const [showAll, setShowAll] = useLocalStorage({ key: 'showAllTags', defaultValue: false });
  const displayedTags = useMemo(() => {
    if (!tags) return [];
    const displayTags = [...tags].sort((a, b) => {
      const aMod = !getIsPublicBrowsingLevel(a.nsfwLevel);
      const bMod = !getIsPublicBrowsingLevel(b.nsfwLevel);
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
    <Group spacing={4} {...props}>
      {nsfwLevel && type === 'image' && (
        <BrowsingLevelBadge
          radius="xs"
          browsingLevel={nsfwLevel}
          className="cursor-pointer"
          onClick={() =>
            currentUser ? openSetBrowsingLevelModal({ imageId: id, nsfwLevel }) : undefined
          }
          sfwClassName={classes.nsfwBadge}
        />
      )}
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
          nsfwLevel={tag.nsfwLevel}
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
  nsfwLevel?: number;
} & Omit<GroupProps, 'id'>;

const useStyles = createStyles((theme) => ({
  nsfwBadge: {
    backgroundColor: theme.colors.blue[9],
  },
}));
