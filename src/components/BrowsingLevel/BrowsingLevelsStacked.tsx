import { Group, Paper, Switch, Text, createStyles } from '@mantine/core';
import {
  useBrowsingModeContext,
  useIsBrowsingLevelSelected,
} from '~/components/BrowsingLevel/BrowsingLevelProvider';
import {
  BrowsingLevel,
  browsingLevelDescriptions,
  browsingLevelLabels,
  browsingLevels,
} from '~/shared/constants/browsingLevel.constants';

export function BrowsingLevelsStacked() {
  const { classes } = useStyles();

  return (
    <Paper withBorder p={0} className={classes.root}>
      {browsingLevels.map((level) => (
        <BrowsingLevelItem key={level} level={level} />
      ))}
    </Paper>
  );
}

function BrowsingLevelItem({ level }: { level: BrowsingLevel }) {
  const isSelected = useIsBrowsingLevelSelected(level);
  const { toggleBrowsingLevel } = useBrowsingModeContext();
  const { classes, cx } = useStyles();

  return (
    <Group
      position="apart"
      py="sm"
      px="md"
      onClick={() => toggleBrowsingLevel(level)}
      className={cx({ [classes.active]: isSelected })}
      noWrap
    >
      <Group noWrap>
        <Text weight={700} w={50} ta="center">
          {browsingLevelLabels[level]}
        </Text>
        <Text lh={1.2} size="sm" ta="left" sx={{ flex: '1 1' }}>
          {browsingLevelDescriptions[level]}
        </Text>
      </Group>
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
