import { Chip, Group, GroupProps, createStyles } from '@mantine/core';
import {
  useBrowsingModeContext,
  useIsBrowsingLevelSelected,
  useBrowsingLevel,
} from '~/components/BrowsingLevel/BrowsingLevelProvider';
import {
  getBrowsingLevelDetails,
  getVisibleBrowsingLevels,
  getIsDefaultBrowsingLevel,
} from '~/shared/constants/browsingLevel.constants';

export function BrowsingLevelsGrouped(props: GroupProps) {
  const browsingLevel = useBrowsingLevel();

  return (
    <Group spacing="xs" noWrap {...props}>
      {getVisibleBrowsingLevels(browsingLevel).map((level) => (
        <BrowsingLevelLabel key={level} level={level} />
      ))}
    </Group>
  );
}

function BrowsingLevelLabel({ level }: { level: number }) {
  const isSelected = useIsBrowsingLevelSelected(level);
  const { toggleBrowsingLevel, useStore } = useBrowsingModeContext();
  const { classes } = useStyles();

  const isDefaultBrowsingLevel = useStore((x) => getIsDefaultBrowsingLevel(x.browsingLevel, level));

  return (
    <Chip
      classNames={classes}
      checked={isSelected || isDefaultBrowsingLevel}
      onChange={() => toggleBrowsingLevel(level)}
      variant={!isDefaultBrowsingLevel ? 'outline' : 'filled'}
    >
      {getBrowsingLevelDetails(level).name}
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
