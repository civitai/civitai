import {
  Badge,
  Divider,
  Chip,
  Group,
  Text,
  Popover,
  Stack,
  useMantineTheme,
  lighten,
} from '@mantine/core';
import { TagType } from '~/shared/utils/prisma/enums';
import { IconPlus } from '@tabler/icons-react';
import React, { useMemo } from 'react';
import { moderationCategories } from '~/libs/moderation';
import { NsfwLevel } from '~/server/common/enums';
import { getIsPublicBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { getDisplayName } from '~/utils/string-helpers';

export function VotableTagMature({ tags, addTag }: VotableTagMatureProps) {
  const theme = useMantineTheme();
  // State
  const matureTags = useMemo(() => {
    const matureTags: Record<string, { has: boolean; locked: boolean }> = {};
    for (const { name, id, nsfwLevel } of tags)
      if (!getIsPublicBrowsingLevel(nsfwLevel)) matureTags[name] = { has: true, locked: id !== 0 };
    return matureTags;
  }, [tags]);

  // Style
  const hasMature = Object.keys(matureTags).length > 0;
  const badgeColor = theme.variantColorResolver(
    hasMature
      ? { color: 'red', variant: 'light', theme }
      : { color: 'gray', variant: 'filled', theme }
  );
  const badgeBorder = lighten(badgeColor.background ?? theme.colors.gray[4], 0.05);

  return (
    <Popover width={400} withArrow withinPortal zIndex={1000}>
      <Popover.Target>
        <Badge
          radius="xs"
          className="cursor-pointer px-[5px]"
          style={{
            backgroundColor: badgeColor.background,
            borderColor: badgeBorder,
            color: badgeColor.color,
          }}
        >
          <Group gap={4} wrap="nowrap">
            <IconPlus size={14} strokeWidth={2.5} />
            Moderated Content
          </Group>
        </Badge>
      </Popover.Target>
      <Popover.Dropdown className="-mt-3 max-w-[300px]" p={0}>
        <Stack py="sm">
          <Text className="text-center font-medium">Moderated Content Tags</Text>
          {moderationCategories.map((category) => {
            if (!category.children?.length || category.noInput || category.hidden) return null;
            return (
              <Stack gap="xs" key={category.value}>
                <Divider label={getDisplayName(category.label)} labelPosition="center" />
                <Group gap={5} px="sm">
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
