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
  IconCategory,
  IconClubs,
  IconFileText,
  IconHome,
  IconLayoutList,
  IconMoneybag,
  IconPhoto,
  IconVideo,
} from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { containerQuery } from '~/utils/mantine-css-helpers';

const homeOptions = {
  home: {
    url: '/',
    icon: <IconHome />,
  },
  models: {
    url: '/models',
    icon: <IconCategory />,
  },
  images: {
    url: '/images',
    icon: <IconPhoto />,
  },
  videos: {
    url: '/videos',
    icon: <IconVideo />,
  },
  posts: {
    url: '/posts',
    icon: <IconLayoutList />,
  },
  articles: {
    url: '/articles',
    icon: <IconFileText />,
  },
  bounties: {
    url: '/bounties',
    icon: <IconMoneybag />,
  },
  clubs: {
    url: '/clubs',
    icon: <IconClubs />,
  },
} as const;
type HomeOptions = keyof typeof homeOptions;

const useStyles = createStyles((theme) => ({
  label: {
    paddingTop: 6,
    paddingBottom: 6,
    paddingLeft: 6,
    paddingRight: 10,
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
  const features = useFeatureFlags();
  const [home, setHome] = useLocalStorage<HomeOptions>({
    key: 'home-selection',
    defaultValue: features.alternateHome ? 'home' : 'models',
  });

  const url = homeOptions[home]?.url;
  const set = (value: HomeOptions) => {
    setHome(value);
    return homeOptions[value]?.url;
  };

  return { home, url, set };
}

export function FullHomeContentToggle({ size, sx, ...props }: Props) {
  const { classes, theme } = useStyles();
  const router = useRouter();
  const { set } = useHomeSelection();
  const features = useFeatureFlags();
  const activePath = router.pathname.split('/').pop() || 'home';

  const options: SegmentedControlItem[] = Object.entries(homeOptions).map(([key, value]) => ({
    label: (
      <Link href={value.url} passHref>
        <Anchor variant="text">
          <Group align="center" spacing={8} onClick={() => set(key as HomeOptions)} noWrap>
            <ThemeIcon
              size={30}
              color={activePath === key ? theme.colors.dark[7] : 'transparent'}
              p={6}
            >
              {value.icon}
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
} & Omit<SegmentedControlProps, 'data' | 'value' | 'onChange'>;
