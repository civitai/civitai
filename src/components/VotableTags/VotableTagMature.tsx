import {
  Autocomplete,
  Badge,
  createStyles,
  Divider,
  Chip,
  Group,
  Text,
  Box,
  Popover,
  Stack,
} from '@mantine/core';
import { useDebouncedValue, useDisclosure } from '@mantine/hooks';
import { TagTarget, TagType } from '@prisma/client';
import { IconPlus, IconRating18Plus } from '@tabler/icons';
import React, { useMemo } from 'react';
import { useState } from 'react';
import { moderationCategories } from '~/libs/moderation';
import { getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

export function VotableTagMature({ tags, addTag }: VotableTagMatureProps) {
  // State
  const matureTags = useMemo(() => {
    const matureTags: Record<string, { has: boolean; locked: boolean }> = {};
    for (const { name, type, id } of tags)
      if (type === 'Moderation') matureTags[name] = { has: true, locked: id !== 0 };
    return matureTags;
  }, [tags]);

  // Style
  const hasMature = Object.keys(matureTags).length > 0;
  const { classes } = useStyles({ hasMature });

  return (
    <Popover width={400} withArrow withinPortal>
      <Popover.Target>
        <Badge radius="xs" className={classes.badge} px={5}>
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
                        {child.label}
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
  tags: { id: number; name: string; type: TagType }[];
};

const useStyles = createStyles((theme, { hasMature }: { hasMature: boolean }) => {
  const badgeColor = theme.fn.variant({
    color: hasMature ? 'red' : 'gray',
    variant: hasMature ? 'light' : 'filled',
  });
  const badgeBorder = theme.fn.lighten(badgeColor.background ?? theme.colors.gray[4], 0.05);
  return {
    badge: {
      cursor: 'pointer',
      backgroundColor: badgeColor.background,
      borderColor: badgeBorder,
      color: badgeColor.color,
      userSelect: 'none',
    },
    inner: {
      display: 'flex',
    },
    createOption: {
      fontSize: theme.fontSizes.sm,
      padding: theme.spacing.xs,
      borderRadius: theme.radius.sm,

      '&:hover': {
        backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[1],
      },
    },
    input: {
      textTransform: 'uppercase',
      fontWeight: 'bold',
      fontSize: 11,
    },
    dropdown: {
      marginTop: -12,
      maxWidth: '300px !important',
    },
  };
});
