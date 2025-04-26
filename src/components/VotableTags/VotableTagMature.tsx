import { Badge, Divider, Chip, Group, Text, Popover, Stack } from '@mantine/core';
import { TagType } from '~/shared/utils/prisma/enums';
import { IconPlus } from '@tabler/icons-react';
import React, { useMemo } from 'react';
import { moderationCategories } from '~/libs/moderation';
import { NsfwLevel } from '~/server/common/enums';
import { getIsPublicBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { getDisplayName } from '~/utils/string-helpers';
import classes from './VotableTagMature.module.scss';

export function VotableTagMature({ tags, addTag }: VotableTagMatureProps) {
  // State
  const matureTags = useMemo(() => {
    const matureTags: Record<string, { has: boolean; locked: boolean }> = {};
    for (const { name, id, nsfwLevel } of tags)
      if (!getIsPublicBrowsingLevel(nsfwLevel)) matureTags[name] = { has: true, locked: id !== 0 };
    return matureTags;
  }, [tags]);

  // Style
  const hasMature = Object.keys(matureTags).length > 0;

  return (
    <Popover width={400} withArrow withinPortal zIndex={1000}>
      <Popover.Target>
        <Badge
          radius="xs"
          className={`${classes.badge} ${hasMature ? classes.badgeHasMature : ''}`}
          px={5}
        >
          <Group spacing={4} noWrap>
            <IconPlus size={14} strokeWidth={2.5} />
            Moderated Content
          </Group>
        </Badge>
      </Popover.Target>
      <Popover.Dropdown p={0}>
        <Stack py="sm">
          <Text ta="center" weight={500}>
            Moderated Content Tags
          </Text>
          {moderationCategories.map((category) => {
            if (!category.children?.length || category.noInput || category.hidden) return null;
            return (
              <Stack spacing="xs" key={category.value}>
                <Divider label={getDisplayName(category.label)} labelPosition="center" />
                <Group spacing={5} px="sm">
                  {category.children
                    .filter((x) => !x.hidden)
                    .map((child) => (
                      <Chip
                        variant="filled"
                        radius="xs"
                        size="xs"
                        key={child.value}
                        color="red"
                        onChange={() => addTag(child.value)}
                        disabled={matureTags[child.value]?.locked ?? false}
                        checked={matureTags[child.value]?.has ?? false}
                      >
                        <span>{child.label}</span>
                      </Chip>
                    ))}
                </Group>
              </Stack>
            );
          })}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

type VotableTagMatureProps = {
  addTag: (tag: string) => void;
  tags: { id: number; name: string; type: TagType; nsfwLevel: NsfwLevel }[];
};

