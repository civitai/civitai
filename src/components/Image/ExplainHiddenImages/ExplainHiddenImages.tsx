import { Badge, Group, Stack, Text, createStyles } from '@mantine/core';
import React, { useMemo } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useHiddenPreferencesContext } from '~/components/HiddenPreferences/HiddenPreferencesProvider';
import { useQueryHiddenPreferences } from '~/hooks/hidden-preferences';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { BrowsingLevel, browsingLevelLabels } from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils';

export function ExplainHiddenImages<
  T extends { id: number; nsfwLevel: number; tagIds?: number[] }
>({ images }: { images?: T[] }) {
  const { classes } = useStyles();
  const browsingLevel = useBrowsingLevelDebounced();
  const hiddenPreferences = useHiddenPreferencesContext();
  const { data } = useQueryHiddenPreferences();
  const currentUser = useCurrentUser();

  const { hiddenByBrowsingLevel, hiddenByTag } = useMemo(() => {
    const hiddenByBrowsingLevel: Record<number, number> = {};

    const hiddenByTag: Record<number, number> = {};

    for (const image of images ?? []) {
      for (const tag of image.tagIds ?? []) {
        if (hiddenPreferences.hiddenTags.get(tag)) {
          if (!hiddenByTag[tag]) hiddenByTag[tag] = 1;
          else hiddenByTag[tag]++;
        }
      }
      if (!Flags.intersects(browsingLevel, image.nsfwLevel)) {
        if (!hiddenByBrowsingLevel[image.nsfwLevel]) hiddenByBrowsingLevel[image.nsfwLevel] = 1;
        else hiddenByBrowsingLevel[image.nsfwLevel]++;
      }
    }

    return {
      hiddenByBrowsingLevel,
      hiddenByTag,
    };
  }, [browsingLevel, hiddenPreferences, images]);

  if (!images?.length) return null;

  const totalHiddenByBrowsingLevel = Object.values(hiddenByBrowsingLevel).reduce<number>(
    (acc, val) => acc + val,
    0
  );
  const totalHiddenByTags = Object.values(hiddenByTag).reduce<number>((acc, val) => acc + val, 0);
  const showHiddenBrowsingLevels = totalHiddenByBrowsingLevel > 0 && !!currentUser?.showNsfw;

  return (
    <Stack spacing="sm" align="center">
      {showHiddenBrowsingLevels && (
        <Stack spacing={4}>
          <Text size="sm" color="dimmed" ta="center">
            Hidden by your browsing level:
          </Text>
          <Group spacing="xs" position="center">
            {Object.entries(hiddenByBrowsingLevel).map(([level, count]) => (
              <Badge key={level} rightSection={count} variant="outline" classNames={classes}>
                {browsingLevelLabels[Number(level) as BrowsingLevel]}
              </Badge>
            ))}
          </Group>
        </Stack>
      )}
      {currentUser && totalHiddenByTags > 0 && (
        <Stack spacing={4}>
          <Text size="sm" color="dimmed" ta="center">
            Hidden by your tag preferences:
          </Text>
          <Group spacing="xs" position="center">
            {Object.entries(hiddenByTag).map(([tagId, count]) => (
              <Badge key={tagId} rightSection={count} variant="outline" classNames={classes}>
                {data?.hiddenTags.find((x) => x.id === Number(tagId))?.name}
              </Badge>
            ))}
          </Group>
        </Stack>
      )}
    </Stack>
  );
}

const useStyles = createStyles((theme) => ({
  rightSection: {
    marginLeft: 10,
    paddingLeft: 10,
    borderLeft: '1px solid',
  },
}));
