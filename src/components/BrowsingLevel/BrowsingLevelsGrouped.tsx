import type { GroupProps, MantineSize } from '@mantine/core';
import { Chip, Group } from '@mantine/core';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useBrowsingSettings, useToggleBrowsingLevel } from '~/providers/BrowserSettingsProvider';
import { NsfwLevel } from '~/server/common/enums';
import {
  browsingLevels,
  browsingLevelLabels,
  nsfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import classes from './BrowsingLevelsGrouped.module.scss';
import { useIsRegionRestricted } from '~/hooks/useIsRegionRestricted';

export function BrowsingLevelsGrouped({ size, ...props }: GroupProps & { size?: MantineSize }) {
  const currentUser = useCurrentUser();
  const baseLevels = browsingLevels;
  const levels = currentUser?.isModerator ? [...baseLevels, NsfwLevel.Blocked] : baseLevels;

  return (
    <Group gap="xs" wrap="nowrap" {...props}>
      {levels.map((level) => (
        <BrowsingLevelLabel key={level} level={level} size={size} />
      ))}
    </Group>
  );
}

function BrowsingLevelLabel({ level, size }: { level: NsfwLevel; size?: MantineSize }) {
  const browsingLevel = useBrowsingSettings((x) => x.browsingLevel);
  const { isRestricted } = useIsRegionRestricted();
  const isSelected = Flags.hasFlag(browsingLevel, level);
  const toggleBrowsingLevel = useToggleBrowsingLevel();
  const disabled = isRestricted && Flags.hasFlag(nsfwBrowsingLevelsFlag, level);

  // const browsingLevel = useStore((x) => x.browsingLevel);
  const isDefaultBrowsingLevel = browsingLevel === 0 && level === NsfwLevel.PG;

  return (
    <Chip
      classNames={classes}
      checked={isSelected || isDefaultBrowsingLevel}
      onChange={() => toggleBrowsingLevel(level)}
      variant="filled"
      disabled={disabled}
      size={size}
    >
      {/* Turns out, that when people are using google translate that string literals should be wrapped in a span to avoid errors  */}
      {/* https://github.com/remarkjs/react-markdown/pull/365 - at least this appears to have fixed the issue */}
      <span>{browsingLevelLabels[level]}</span>
    </Chip>
  );
}
