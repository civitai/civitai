import {
  ActionIcon,
  Badge,
  Center,
  Group,
  GroupProps,
  Loader,
  useMantineTheme,
} from '@mantine/core';
import { IconArrowBigDown, IconArrowBigTop, IconChevronDown, IconChevronUp } from '@tabler/icons';
import { useMemo, useState } from 'react';
import { LoginPopover } from '~/components/LoginPopover/LoginPopover';
import { TagVotableEntityType } from '~/libs/tags';
import { trpc } from '~/utils/trpc';

export function VotableTags({
  entityId: id,
  entityType: type,
  limit = 6,
  ...props
}: GalleryTagProps) {
  const queryUtils = trpc.useContext();
  const theme = useMantineTheme();
  const { data: tags, isLoading } = trpc.tag.getVotableTags.useQuery({ id, type });
  const { mutate: addVotes } = trpc.tag.addTagVotes.useMutation({
    onMutate: ({ tags, vote }) => {
      const previousTags = queryUtils.tag.getVotableTags.getData({ id, type }) ?? [];
      const isTagIds = typeof tags[0] === 'number';
      queryUtils.tag.getVotableTags.setData({ id, type }, (old = []) =>
        old.map((tag) => {
          const affectsTag = isTagIds
            ? (tags as number[]).includes(tag.id)
            : (tags as string[]).includes(tag.name);
          if (affectsTag) {
            tag.vote = vote;
            tag.score += vote;
            if (vote > 0) tag.upVotes += vote;
            else tag.downVotes += vote;
          }
          return tag;
        })
      );

      return { previousTags };
    },
    onError: (_error, _variables, context) => {
      queryUtils.tag.getVotableTags.setData({ id, type }, context?.previousTags);
    },
  });
  const { mutate: removeVotes } = trpc.tag.removeTagVotes.useMutation({
    onMutate: ({ tags }) => {
      const previousTags = queryUtils.tag.getVotableTags.getData({ id, type }) ?? [];
      const isTagIds = typeof tags[0] === 'number';
      queryUtils.tag.getVotableTags.setData({ id, type }, (old = []) =>
        old.map((tag) => {
          const affectsTag =
            tag.vote &&
            (isTagIds
              ? (tags as number[]).includes(tag.id)
              : (tags as string[]).includes(tag.name));
          if (tag.vote && affectsTag) {
            tag.score -= tag.vote;
            if (tag.vote > 0) tag.upVotes -= tag.vote;
            else tag.downVotes -= tag.vote;
            tag.vote = undefined;
          }
          return tag;
        })
      );

      return { previousTags };
    },
    onError: (_error, _variables, context) => {
      queryUtils.tag.getVotableTags.setData({ id, type }, context?.previousTags);
    },
  });

  const toggleVote = (tag: { id: number; vote?: number }, vote: number) => {
    if (tag.vote === vote) removeVotes({ tags: [tag.id], type, id });
    else addVotes({ tags: [tag.id], vote, type, id });
  };

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
      {displayedTags.map((tag) => {
        const automated = tag.automated && tag.upVotes === 0;
        const isModeration = tag.type === 'Moderation';
        const voteColor = isModeration ? theme.colors.red[7] : theme.colors.blue[5];
        const opacity = 0.2 + (Math.min(tag.score, 10) / 10) * 0.8;
        return (
          <Badge
            radius="xs"
            key={tag.id}
            variant={isModeration ? 'light' : 'filled'}
            color={isModeration ? 'red' : 'gray'}
            style={{ opacity }}
            px={0}
          >
            <Group spacing={0}>
              <LoginPopover>
                <ActionIcon
                  variant="transparent"
                  size="sm"
                  onClick={() => toggleVote(tag, 1)}
                  color={tag.vote === 1 ? voteColor : undefined}
                >
                  <IconArrowBigTop
                    strokeWidth={0}
                    fill={tag.vote === 1 ? voteColor : 'rgba(255, 255, 255, 0.3)'}
                    size="1rem"
                  />
                </ActionIcon>
              </LoginPopover>
              <span>{tag.name}</span>
              <LoginPopover>
                <ActionIcon variant="transparent" size="sm" onClick={() => toggleVote(tag, -1)}>
                  <IconArrowBigDown
                    strokeWidth={0}
                    fill={tag.vote === -1 ? voteColor : 'rgba(255, 255, 255, 0.3)'}
                    size="1rem"
                  />
                </ActionIcon>
              </LoginPopover>
            </Group>
          </Badge>
        );
      })}
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
} & Omit<GroupProps, 'id'>;
