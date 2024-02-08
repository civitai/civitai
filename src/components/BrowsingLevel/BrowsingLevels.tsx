import { Chip, Group, Paper } from '@mantine/core';
import {
  useBrowsingLevel,
  browsingLevels,
  useBrowsingLevelTags,
  browsingLevelLabels,
  toggleBrowsingLevel,
  BrowsingLevel,
} from '~/components/BrowsingLevel/browsingLevel.utils';
import { Flags } from '~/utils/flags';

export function BrowsingLevels() {
  return (
    <Paper component={Group} withBorder>
      {browsingLevels.map((level) => (
        <BrowsingLevelLabel key={level} level={level} />
      ))}
    </Paper>
  );
}

function BrowsingLevelLabel({ level }: { level: BrowsingLevel }) {
  // TODO.Briant - handle displaying tags
  const tags = useBrowsingLevelTags(level);
  const browsingLevel = useBrowsingLevel();
  const isSelected = Flags.hasFlag(browsingLevel, level);
  return (
    <Chip checked={isSelected} onChange={() => toggleBrowsingLevel(level)}>
      {browsingLevelLabels[level]}
    </Chip>
  );
}
