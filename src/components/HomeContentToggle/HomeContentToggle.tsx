import {
  Anchor,
  Group,
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlProps,
  Text,
  ThemeIcon,
  createStyles,
} from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import {
  IconCalendar,
  IconCategory,
  IconFileText,
  IconHome,
  IconLayoutList,
  IconMoneybag,
  IconPhoto,
  IconVideo,
  TablerIconsProps,
} from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { containerQuery } from '~/utils/mantine-css-helpers';

const homeOptions = {
  home: {
    url: '/',
    icon: (props: TablerIconsProps) => <IconHome {...props} />,
  },
  models: {
    url: '/models',
    icon: (props: TablerIconsProps) => <IconCategory {...props} />,
  },
  images: {
    url: '/images',
    icon: (props: TablerIconsProps) => <IconPhoto {...props} />,
  },
  videos: {
    url: '/videos',
    icon: (props: TablerIconsProps) => <IconVideo {...props} />,
  },
  posts: {
    url: '/posts',
    icon: (props: TablerIconsProps) => <IconLayoutList {...props} />,
  },
  articles: {
    url: '/articles',
    icon: (props: TablerIconsProps) => <IconFileText {...props} />,
  },
  bounties: {
    url: '/bounties',
    icon: (props: TablerIconsProps) => <IconMoneybag {...props} />,
  },
  events: {
    url: '/events',
    icon: (props: TablerIconsProps) => <IconCalendar {...props} />,
  },
} as const;
type HomeOptions = keyof typeof homeOptions;

const useStyles = createStyles<string, { hideActive?: boolean }>((_, params) => ({
  label: {
    paddingTop: 6,
    paddingBottom: 6,
    paddingLeft: 6,
    paddingRight: 10,
  },
  active: {
    // Manually adjust the active state to match the design
    marginTop: 4,
    marginLeft: 3,
    display: params.hideActive ? 'none' : 'block',
  },
  root: {
    backgroundColor: 'transparent',
    gap: 8,

    [containerQuery.smallerThan('sm')]: {
      overflow: 'auto hidden',
      maxWidth: '100%',
    },
  },
  control: { border: 'none !important' },
}));

export function useHomeSelection() {
  const [home, setHome] = useLocalStorage<HomeOptions>({
    key: 'home-selection',
    defaultValue: 'home',
  });

  const url = homeOptions[home]?.url;
  const set = (value: HomeOptions) => {
    setHome(value);
    return homeOptions[value]?.url;
  };

  return { home, url, set };
}

export function HomeContentToggle({ size, sx, ...props }: Props) {
  const router = useRouter();
  const { set, home } = useHomeSelection();
  const features = useFeatureFlags();
  const activePath = router.pathname.split('/')[1] || 'home';
  const { classes, theme } = useStyles({ hideActive: activePath !== home });

  const options: SegmentedControlItem[] = Object.entries(homeOptions).map(([key, value]) => ({
    label: (
      <Link href={value.url} passHref>
        <Anchor variant="text">
          <Group
            align="center"
            spacing={8}
            onClick={() => {
              if (key !== 'clubs') set(key as HomeOptions);
            }}
            noWrap
          >
            <ThemeIcon size={30} color={activePath === key ? 'dark.7' : 'transparent'} p={6}>
              {value.icon({
                color:
                  theme.colorScheme === 'dark' || activePath === key
                    ? theme.white
                    : theme.colors.dark[7],
              })}
            </ThemeIcon>
            <Text size="sm" transform="capitalize" inline>
              {key}
            </Text>
          </Group>
        </Anchor>
      </Link>
    ),
    value: key,
    disabled: [key === 'bounties' && !features.bounties, key === 'clubs' && !features.clubs].some(
      (b) => b
    ),
  }));

  return (
    <SegmentedControl
      {...props}
      sx={(theme) => ({
        ...(typeof sx === 'function' ? sx(theme) : sx),
      })}
      size="md"
      classNames={classes}
      value={activePath}
      data={options.filter((item) => item.disabled === undefined || item.disabled === false)}
    />
  );
}

type Props = {
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  fixed?: boolean;
} & Omit<SegmentedControlProps, 'data' | 'value' | 'onChange'>;
