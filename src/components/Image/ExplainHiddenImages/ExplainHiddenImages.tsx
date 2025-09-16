import { Badge, Button, Group, Stack, Text } from '@mantine/core';
import React, { useMemo } from 'react';
import {
  useBrowsingLevelDebounced,
  useBrowsingLevelContext,
} from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useHiddenPreferencesContext } from '~/components/HiddenPreferences/HiddenPreferencesProvider';
import { useQueryHiddenPreferences } from '~/hooks/hidden-preferences';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
import { useBrowsingSettingsAddons } from '~/providers/BrowsingSettingsAddonsProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { BrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import {
  browsingLevelLabels,
  flagifyBrowsingLevel,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';

export function ExplainHiddenImages({
  hiddenBelowBrowsingLevel: hiddenByBrowsingLevel,
  hiddenByTags,
  hasHidden,
}: ReturnType<typeof useExplainHiddenImages>) {
  const { data } = useQueryHiddenPreferences();
  const currentUser = useCurrentUser();
  const browsingLevel = useBrowsingLevelDebounced();
  const showNsfw = useBrowsingSettings((x) => x.showNsfw);
  const { setBrowsingLevelOverride } = useBrowsingLevelContext();
  if (!hasHidden) return null;

  const totalHiddenByBrowsingLevel = hiddenByBrowsingLevel.length;
  const totalHiddenByTags = hiddenByTags.length;
  const hiddenByBrowsingLevelFlag = flagifyBrowsingLevel(
    hiddenByBrowsingLevel.map((x) => x.browsingLevel)
  );
  const showHiddenBrowsingLevels = totalHiddenByBrowsingLevel > 0 && showNsfw;

  const handleShowAll = () => {
    const browsingLevelOverride = flagifyBrowsingLevel(
      hiddenByBrowsingLevel.map((x) => x.browsingLevel)
    );
    setBrowsingLevelOverride?.(Flags.addFlag(browsingLevelOverride, browsingLevel));
  };

  return (
    <Stack gap="sm" align="center">
      {showHiddenBrowsingLevels && (
        <Stack gap={4}>
          <Text size="sm" c="dimmed" ta="center">
            Hidden by your browsing level:
          </Text>
          <Group gap="xs" justify="center">
            {hiddenByBrowsingLevel.map(({ browsingLevel, count }) => (
              <Badge
                key={browsingLevel}
                rightSection={count}
                variant="outline"
                styles={{
                  section: {
                    marginLeft: 10,
                    paddingLeft: 10,
                    borderLeft: '1px solid',
                  },
                }}
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
        <Stack gap={4}>
          <Text size="sm" c="dimmed" ta="center">
            Hidden by your tag preferences:
          </Text>
          <Group gap="xs" justify="center">
            {hiddenByTags.map(({ tagId, count }) => (
              <Badge
                key={tagId}
                rightSection={count}
                variant="outline"
                styles={{
                  section: {
                    marginLeft: 10,
                    paddingLeft: 10,
                    borderLeft: '1px solid',
                  },
                }}
              >
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

export function useExplainHiddenImages<
  T extends { id: number; nsfwLevel: number; tagIds?: number[]; poi?: boolean }
>(images?: T[]) {
  const browsingLevel = useBrowsingLevelDebounced();
  const hiddenPreferences = useHiddenPreferencesContext();
  const { canViewNsfw } = useFeatureFlags();
  const browsingSettingsAddons = useBrowsingSettingsAddons();

  return useMemo(() => {
    const browsingLevelBelowDict: Record<number, number> = {};
    const browsingLevelAboveDict: Record<number, number> = {};
    const tagDict: Record<number, number> = {};
    const excludedTagsDict: Record<number, number> = {};

    for (const image of images ?? []) {
      if (!image.nsfwLevel) continue;
      for (const tag of image.tagIds ?? []) {
        if (hiddenPreferences.hiddenTags.get(tag)) {
          if (!tagDict[tag]) tagDict[tag] = 1;
          else tagDict[tag]++;
        }

        if (browsingSettingsAddons.settings.excludedTagIds?.includes(tag)) {
          if (!excludedTagsDict[tag]) excludedTagsDict[tag] = 1;
          else excludedTagsDict[tag]++;
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
    const hiddenByBrowsingSettings = Object.entries(excludedTagsDict).map(([key, count]) => ({
      tagId: Number(key),
      count,
    }));

    const hiddenByPoi = images?.filter((x) => x.poi && browsingSettingsAddons.settings.disablePoi);

    return {
      hiddenBelowBrowsingLevel: hiddenBelowBrowsingLevel,
      hiddenAboveBrowsingLevel,
      hiddenByBrowsingSettings,
      hiddenByTags,
      hiddenByPoi,
      hasHidden: canViewNsfw
        ? !!hiddenBelowBrowsingLevel.length ||
          !!hiddenAboveBrowsingLevel.length ||
          !!hiddenByTags.length
        : false,
    };
  }, [browsingLevel, hiddenPreferences, images]);
}
