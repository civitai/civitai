import { Group, Paper, Stack, Switch, Text, createStyles } from '@mantine/core';
import {
  useBrowsingLevel,
  useBrowsingModeContext,
  useIsBrowsingLevelSelected,
} from '~/components/BrowsingLevel/BrowsingLevelProvider';
import {
  getBrowsingLevelDetails,
  getVisibleBrowsingLevels,
  getIsDefaultBrowsingLevel,
} from '~/shared/constants/browsingLevel.constants';

export function BrowsingLevelsStacked() {
  const { classes } = useStyles();
  const browsingLevel = useBrowsingLevel();

  return (
    <Paper withBorder p={0} className={classes.root}>
      {getVisibleBrowsingLevels(browsingLevel).map((level) => (
        <BrowsingLevelItem key={level} level={level} />
      ))}
    </Paper>
  );
}

function BrowsingLevelItem({ level }: { level: number }) {
  const isSelected = useIsBrowsingLevelSelected(level);
  const { toggleBrowsingLevel, useStore } = useBrowsingModeContext();
  const { classes, cx } = useStyles();

  const { name, description } = getBrowsingLevelDetails(level);
  const isDefaultBrowsingLevel = useStore((x) => getIsDefaultBrowsingLevel(x.browsingLevel, level));

  return (
    <Group
      position="apart"
      py="sm"
      px="md"
      onClick={() => toggleBrowsingLevel(level)}
      className={cx({ [classes.active]: isSelected })}
      noWrap
    >
      <Stack spacing={4}>
        <Text weight={700}>{name}</Text>
        <Text lh={1.2} size="sm" ta="left">
          {description}
        </Text>
      </Stack>
      <Switch checked={isSelected} onClick={() => toggleBrowsingLevel(level)} />
    </Group>
  );
}

const useStyles = createStyles((theme) => ({
  root: {
    ['& > div']: {
      ['&:hover']: {
        background: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[2],
        cursor: 'pointer',
      },
      ['&:not(:last-child)']: {
        borderBottom: `1px ${
          theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3]
        } solid`,
      },
    },
  },
  active: {
    background: theme.colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[1],
  },
}));
