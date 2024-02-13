import { Chip, Group, GroupProps, createStyles } from '@mantine/core';
import {
  useBrowsingModeContext,
  useIsBrowsingLevelSelected,
} from '~/components/BrowsingLevel/BrowsingLevelProvider';
import {
  browsingLevels,
  browsingLevelLabels,
  BrowsingLevel,
} from '~/components/BrowsingLevel/browsingLevel.utils';

export function BrowsingLevelsGrouped(props: GroupProps) {
  return (
    <Group spacing={4} {...props}>
      {browsingLevels.map((level) => (
        <BrowsingLevelLabel key={level} level={level} />
      ))}
    </Group>
  );
}

function BrowsingLevelLabel({ level }: { level: BrowsingLevel }) {
  const isSelected = useIsBrowsingLevelSelected(level);
  const { toggleBrowsingLevel } = useBrowsingModeContext();
  const { classes } = useStyles();
  return (
    <Chip classNames={classes} checked={isSelected} onChange={() => toggleBrowsingLevel(level)}>
      {browsingLevelLabels[level]}
    </Chip>
  );
}

const useStyles = createStyles((theme, _params, getRef) => ({
  label: {
    '&[data-checked]': {
      '&, &:hover': {
        backgroundColor: theme.colors.blue[theme.fn.primaryShade()],
        color: theme.white,
      },

      [`& .${getRef('iconWrapper')}`]: {
        color: theme.white,
      },
    },
  },

  iconWrapper: {
    ref: getRef('iconWrapper'),
  },
}));
