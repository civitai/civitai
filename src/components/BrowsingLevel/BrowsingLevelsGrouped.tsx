import { Chip, Group, GroupProps, createStyles } from '@mantine/core';
import {
  useBrowsingLevel,
  useBrowsingModeContext,
  useIsBrowsingLevelSelected,
} from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { NsfwLevel } from '~/server/common/enums';
import {
  browsingLevels,
  browsingLevelLabels,
  BrowsingLevel,
} from '~/shared/constants/browsingLevel.constants';

export function BrowsingLevelsGrouped(props: GroupProps) {
  return (
    <Group spacing="xs" noWrap {...props}>
      {browsingLevels.map((level) => (
        <BrowsingLevelLabel key={level} level={level} />
      ))}
    </Group>
  );
}

function BrowsingLevelLabel({ level }: { level: BrowsingLevel }) {
  const isSelected = useIsBrowsingLevelSelected(level);
  const { toggleBrowsingLevel, useStore } = useBrowsingModeContext();
  const { classes } = useStyles();

  const browsingLevel = useStore((x) => x.browsingLevel);
  const isDefaultBrowsingLevel = browsingLevel === 0 && level === NsfwLevel.PG;

  return (
    <Chip
      classNames={classes}
      checked={isSelected || isDefaultBrowsingLevel}
      onChange={() => toggleBrowsingLevel(level)}
      variant={!isDefaultBrowsingLevel ? 'outline' : 'filled'}
    >
      {browsingLevelLabels[level]}
    </Chip>
  );
}

const useStyles = createStyles((theme, _params, getRef) => ({
  root: {
    flex: 1,
  },
  label: {
    width: '100%',
    display: 'inline-flex',
    justifyContent: 'center',
    '&[data-checked]': {
      '&, &:hover': {
        backgroundColor: theme.colors.blue[theme.fn.primaryShade()],
        color: theme.white,
      },

      [`& .${getRef('iconWrapper')}`]: {
        color: theme.white,
        display: 'none',

        [`@media (min-width: ${theme.breakpoints.xs}px)`]: {
          display: 'inline-block',
        },
      },
    },
    paddingLeft: 10,
    paddingRight: 10,
    [`@media (min-width: ${theme.breakpoints.xs}px)`]: {
      '&': {
        paddingLeft: 20,
        paddingRight: 20,
      },
    },
  },

  iconWrapper: {
    ref: getRef('iconWrapper'),
  },
}));
