import { Badge, Button, Group, Stack, Text, createStyles } from '@mantine/core';
import React, { useMemo } from 'react';
import {
  useBrowsingLevelDebounced,
  useBrowsingModeOverrideContext,
} from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useHiddenPreferencesContext } from '~/components/HiddenPreferences/HiddenPreferencesProvider';
import { useQueryHiddenPreferences } from '~/hooks/hidden-preferences';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import {
  BrowsingLevel,
  browsingLevelLabels,
  flagifyBrowsingLevel,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils';

export function ExplainHiddenImages({
  hiddenBelowBrowsingLevel: hiddenByBrowsingLevel,
  hiddenByTags,
  hasHidden,
}: ReturnType<typeof useExplainHiddenImages>) {
  const { classes } = useStyles();
  const { data } = useQueryHiddenPreferences();
  const currentUser = useCurrentUser();
  const browsingLevel = useBrowsingLevelDebounced();
  const { setBrowsingLevelOverride } = useBrowsingModeOverrideContext();
  if (!hasHidden) return null;

  const totalHiddenByBrowsingLevel = hiddenByBrowsingLevel.length;
  const totalHiddenByTags = hiddenByTags.length;
  const showHiddenBrowsingLevels = totalHiddenByBrowsingLevel > 0 && !!currentUser?.showNsfw;

  const handleShowAll = () => {
    const browsingLevelOverride = flagifyBrowsingLevel(
      hiddenByBrowsingLevel.map((x) => x.browsingLevel)
    );
    setBrowsingLevelOverride?.(Flags.addFlag(browsingLevelOverride, browsingLevel));
  };

  return (
    <Stack spacing="sm" align="center">
      {showHiddenBrowsingLevels && (
        <Stack spacing={4}>
          <Text size="sm" color="dimmed" ta="center">
            Hidden by your browsing level:
          </Text>
          <Group spacing="xs" position="center">
            {hiddenByBrowsingLevel.map(({ browsingLevel, count }) => (
              <Badge
                key={browsingLevel}
                rightSection={count}
                variant="outline"
                classNames={classes}
              >
                {browsingLevelLabels[browsingLevel as BrowsingLevel]}
              </Badge>
            ))}
          </Group>
          <Button mt={4} onClick={handleShowAll}>
            Show Hidden
          </Button>
        </Stack>
      )}
      {!showHiddenBrowsingLevels && currentUser && totalHiddenByTags > 0 && (
        <Stack spacing={4}>
          <Text size="sm" color="dimmed" ta="center">
            Hidden by your tag preferences:
          </Text>
          <Group spacing="xs" position="center">
            {hiddenByTags.map(({ tagId, count }) => (
              <Badge key={tagId} rightSection={count} variant="outline" classNames={classes}>
                {data?.hiddenTags.find((x) => x.id === Number(tagId))?.name}
              </Badge>
            ))}
          </Group>
        </Stack>
      )}
      {!totalHiddenByTags && <Text>Images hidden due to mature content settings</Text>}
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

export function useExplainHiddenImages<
  T extends { id: number; nsfwLevel: number; tagIds?: number[] }
>(images?: T[]) {
  const browsingLevel = useBrowsingLevelDebounced();
  const hiddenPreferences = useHiddenPreferencesContext();

  return useMemo(() => {
    const browsingLevelBelowDict: Record<number, number> = {};
    const browsingLevelAboveDict: Record<number, number> = {};
    const tagDict: Record<number, number> = {};

    for (const image of images ?? []) {
      if (!image.nsfwLevel) continue;
      for (const tag of image.tagIds ?? []) {
        if (hiddenPreferences.hiddenTags.get(tag)) {
          if (!tagDict[tag]) tagDict[tag] = 1;
          else tagDict[tag]++;
        }
      }
      if (!Flags.intersects(browsingLevel, image.nsfwLevel) && image.nsfwLevel !== browsingLevel) {
        const dict =
          image.nsfwLevel < browsingLevel ? browsingLevelBelowDict : browsingLevelAboveDict;
        if (!dict[image.nsfwLevel]) dict[image.nsfwLevel] = 1;
        else dict[image.nsfwLevel]++;
      }
    }

    const hiddenBelowBrowsingLevel = Object.entries(browsingLevelBelowDict).map(([key, count]) => ({
      browsingLevel: Number(key),
      count,
    }));
    const hiddenAboveBrowsingLevel = Object.entries(browsingLevelAboveDict).map(([key, count]) => ({
      browsingLevel: Number(key),
      count,
    }));
    const hiddenByTags = Object.entries(tagDict).map(([key, count]) => ({
      tagId: Number(key),
      count,
    }));

    return {
      hiddenBelowBrowsingLevel: hiddenBelowBrowsingLevel,
      hiddenAboveBrowsingLevel,
      hiddenByTags,
      hasHidden:
        !!hiddenBelowBrowsingLevel.length ||
        !!hiddenAboveBrowsingLevel.length ||
        !!hiddenByTags.length,
    };
  }, [browsingLevel, hiddenPreferences, images]);
}
