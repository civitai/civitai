import { TagType } from '@prisma/client';
import { useUpdateHiddenPreferences, useHiddenPreferencesData } from '~/hooks/hidden-preferences';
import { VotableTagModel } from '~/libs/tags';
import { trpc } from '~/utils/trpc';
import produce from 'immer';
import { useVotableTagStore } from '~/components/VotableTags/VotableTag';

const defaultVotable: Partial<VotableTagModel> = {
  id: 0,
  vote: 1,
  score: 1,
  upVotes: 1,
  downVotes: 0,
};

export const useVoteForTags = ({
  entityId,
  entityType,
}: {
  entityId: number;
  entityType: 'image' | 'model';
}) => {
  const queryUtils = trpc.useContext();
  const updateHiddenPreferences = useUpdateHiddenPreferences();
  const { hiddenTags } = useHiddenPreferencesData();
  const setVote = useVotableTagStore((state) => state.setVote);

  const { mutate: addVotes } = trpc.tag.addTagVotes.useMutation();
  const { mutate: removeVotes } = trpc.tag.removeTagVotes.useMutation();

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
      { id: entityId, type: entityType },
      produce((old: VotableTagModel[] | undefined) => {
        if (!old) return;
        for (const tag of preppedTags) {
          const existingIndex = old.findIndex((x) => x.name === tag.name);
          if (existingIndex !== -1) {
            const existing = old[existingIndex];
            if (existing.id === 0 && vote <= 0) {
              old.splice(existingIndex, 1);
            } else {
              setVote({ entityId, entityType, name: tag.name, vote });
              existing.vote = vote;
            }
          } else {
            old.push(tag);
            setVote({ entityId, entityType, name: tag.name, vote });
          }
        }
      })
    );
  };

  const handleVote = ({
    tags,
    vote,
    tagType = 'UserGenerated',
  }: {
    tags: string[];
    vote: number;
    tagType?: TagType;
  }) => {
    if (vote == 0) removeVotes({ tags, type: entityType, id: entityId });
    else addVotes({ tags, vote, type: entityType, id: entityId });
    handleTagMutation(tags, vote, tagType);
    if (
      entityType === 'image' &&
      hiddenTags.filter((x) => x.hidden).some((x) => tags.includes(x.name))
    ) {
      updateHiddenPreferences({ kind: entityType, data: [{ id: entityId }], hidden: vote > 0 });
    }
  };

  return handleVote;
};
