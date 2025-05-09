import { Group, Text } from '@mantine/core';
import { ToggleList } from '~/components/ToggleList/ToggleList';
import { useBrowsingSettings, useToggleBrowsingLevel } from '~/providers/BrowserSettingsProvider';
import {
  BrowsingLevel,
  browsingLevelDescriptions,
  browsingLevelLabels,
  browsingLevels,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils';

export function BrowsingLevelsStacked() {
  const levels = browsingLevels;
  return (
    <ToggleList>
      {levels.map((level) => (
        <BrowsingLevelItem key={level} level={level} />
      ))}
    </ToggleList>
  );
}

function BrowsingLevelItem({ level }: { level: BrowsingLevel }) {
  const browsingLevel = useBrowsingSettings((x) => x.browsingLevel);
  const isSelected = Flags.hasFlag(browsingLevel, level);
  const toggleBrowsingLevel = useToggleBrowsingLevel();

  return (
    <ToggleList.Item checked={isSelected} onChange={() => toggleBrowsingLevel(level)}>
      <Group wrap="nowrap">
        <Text weight={700} w={50} ta="center">
          {browsingLevelLabels[level]}
        </Text>
        <Text lh={1.2} size="sm" ta="left" sx={{ flex: '1 1' }}>
          {browsingLevelDescriptions[level]}
        </Text>
      </Group>
    </ToggleList.Item>
  );
}
