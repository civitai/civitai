import type { GroupProps } from '@mantine/core';
import { Center, Group, Loader } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconChevronDown, IconChevronUp } from '@tabler/icons-react';
import { useEffect, useMemo } from 'react';
import { openSetBrowsingLevelModal } from '~/components/Dialog/triggers/set-browsing-level';
import { BrowsingLevelBadge } from '~/components/BrowsingLevel/BrowsingLevelBadge';
import { VotableTag } from '~/components/VotableTags/VotableTag';
import { VotableTagAdd } from '~/components/VotableTags/VotableTagAdd';
import { VotableTagMature } from '~/components/VotableTags/VotableTagMature';
import { useVoteForTags } from '~/components/VotableTags/votableTag.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { TagVotableEntityType, VotableTagModel } from '~/libs/tags';
import { getIsPublicBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { trpc } from '~/utils/trpc';
import { NsfwLevel } from '~/server/common/enums';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

export function VotableTags({
  entityId: id,
  entityType: type,
  limit = 6,
  tags: initialTags,
  canAdd = false,
  canAddModerated: _canAddModerated,
  collapsible = false,
  nsfwLevel,
  highlightContested,
  onTagsLoaded,
  ...props
}: GalleryTagProps) {
  const currentUser = useCurrentUser();
  const { canViewNsfw } = useFeatureFlags();
  const { data: tags = [], isLoading } = trpc.tag.getVotableTags.useQuery(
    { id, type },
    { enabled: !initialTags, initialData: initialTags }
  );
  const canAddModerated = (canAdd || _canAddModerated) && !!currentUser?.isModerator;

  const handleVote = useVoteForTags({ entityType: type, entityId: id });

  const [showAll, setShowAll] = useLocalStorage({ key: 'showAllTags', defaultValue: false });
  const displayedTags = useMemo(() => {
    if (!tags) return [];
    let displayTags = [...tags].sort((a, b) => {
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
    if (!canViewNsfw)
      displayTags = displayTags.filter((x) => getIsPublicBrowsingLevel(x.nsfwLevel));
    if (!collapsible || showAll) return displayTags;
    return displayTags.slice(0, limit);
  }, [tags, showAll, collapsible, limit, canViewNsfw]);

  useEffect(() => {
    if (onTagsLoaded && tags && !initialTags) {
      onTagsLoaded([
        {
          score: 9,
          upVotes: 0,
          downVotes: 0,
          automated: true,
          needsReview: false,
          concrete: true,
          lastUpvote: null,
          id: 111755,
          type: 'Moderation',
          nsfwLevel: 4,
          name: 'suggestive',
        },
      ]);
    }
  }, [onTagsLoaded, tags, initialTags]);

  if (!initialTags && isLoading)
    return (
      <Center p="xl">
        <Loader type="bars" />
      </Center>
    );
  if (!tags) return null;

  const showAddibles = !collapsible || showAll;
  return (
    <Group gap={4} {...props}>
      {(nsfwLevel || currentUser?.isModerator) && type === 'image' && (
        <BrowsingLevelBadge
          radius="xs"
          browsingLevel={nsfwLevel}
          className="cursor-pointer"
          onClick={() =>
            currentUser
              ? openSetBrowsingLevelModal({ imageId: id, nsfwLevel: nsfwLevel ?? NsfwLevel.XXX })
              : undefined
          }
          // sfwClassName="bg-blue-9"
        />
      )}
      {canAdd && (
        <VotableTagAdd
          addTag={(tag) => {
            handleVote({ tags: [tag], vote: 1 });
          }}
        />
      )}
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
          highlightContested={highlightContested}
          onChange={({ name, vote }) => {
            handleVote({ tags: [name], vote });
          }}
        />
      ))}
      {collapsible && tags.length > limit && (
        <LegacyActionIcon
          variant="transparent"
          size="sm"
          onClick={() => setShowAll((prev) => !prev)}
        >
          {showAll ? <IconChevronUp strokeWidth={3} /> : <IconChevronDown strokeWidth={3} />}
        </LegacyActionIcon>
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
  highlightContested?: boolean;
  onTagsLoaded?: (tags: VotableTagModel[]) => void;
} & Omit<GroupProps, 'id'>;
