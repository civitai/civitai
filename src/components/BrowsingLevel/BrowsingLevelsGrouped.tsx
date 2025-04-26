import { Chip, Group, GroupProps } from '@mantine/core';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useBrowsingSettings, useToggleBrowsingLevel } from '~/providers/BrowserSettingsProvider';
import { NsfwLevel } from '~/server/common/enums';
import { browsingLevels, browsingLevelLabels } from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils';
import styles from './BrowsingLevelsGrouped.module.scss';

export function BrowsingLevelsGrouped(props: GroupProps) {
  const currentUser = useCurrentUser();
  const baseLevels = browsingLevels;
  const levels = currentUser?.isModerator ? [...baseLevels, NsfwLevel.Blocked] : baseLevels;

  return (
    <Group spacing="xs" noWrap {...props}>
      {levels.map((level) => (
        <BrowsingLevelLabel key={level} level={level} />
      ))}
    </Group>
  );
}

function BrowsingLevelLabel({ level }: { level: NsfwLevel }) {
  const browsingLevel = useBrowsingSettings((x) => x.browsingLevel);
  const isSelected = Flags.hasFlag(browsingLevel, level);
  const toggleBrowsingLevel = useToggleBrowsingLevel();
  const isDefaultBrowsingLevel = browsingLevel === 0 && level === NsfwLevel.PG;

  return (
    <Chip
      classNames={styles}
      checked={isSelected || isDefaultBrowsingLevel}
      onChange={() => toggleBrowsingLevel(level)}
      variant={!isDefaultBrowsingLevel ? 'outline' : 'filled'}
    >
      {/* Turns out, that when people are using google translate that string literals should be wrapped in a span to avoid errors  */}
      {/* https://github.com/remarkjs/react-markdown/pull/365 - at least this appears to have fixed the issue */}
      <span>{browsingLevelLabels[level]}</span>
    </Chip>
  );
}

