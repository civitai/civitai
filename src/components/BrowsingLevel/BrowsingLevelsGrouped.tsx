import { Chip, Group, GroupProps, createStyles } from '@mantine/core';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useBrowsingSettings, useToggleBrowsingLevel } from '~/providers/BrowserSettingsProvider';
import { useDomainSettings } from '~/providers/DomainSettingsProvider';
import { DomainSettings } from '~/server/common/constants';
import { NsfwLevel } from '~/server/common/enums';
import { browsingLevels, browsingLevelLabels } from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils';

export function BrowsingLevelsGrouped(props: GroupProps) {
  const settings = useDomainSettings();
  const currentUser = useCurrentUser();
  const baseLevels =
    (settings?.allowedNsfwLevels ?? []).length > 0
      ? (settings as DomainSettings).allowedNsfwLevels
      : browsingLevels;
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
  const { classes } = useStyles();

  // const browsingLevel = useStore((x) => x.browsingLevel);
  const isDefaultBrowsingLevel = browsingLevel === 0 && level === NsfwLevel.PG;

  return (
    <Chip
      classNames={classes}
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
