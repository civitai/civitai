import {
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
  IconFileText,
  IconHome,
  IconLayoutList,
  IconPhoto,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

const homeOptions = {
  home: '/',
  models: '/models',
  images: '/images',
  posts: '/posts',
  articles: '/articles',
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

    [theme.fn.smallerThan('sm')]: {
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

  const url = homeOptions[home];
  const set = (value: HomeOptions) => {
    setHome(value);
    return homeOptions[value];
  };

  return { home, url, set };
}

export function FullHomeContentToggle({ size, sx, ...props }: Props) {
  const { classes } = useStyles();
  const router = useRouter();
  const { set } = useHomeSelection();
  const features = useFeatureFlags();
  const activePath = router.pathname.split('/').pop() || 'home';

  const data: SegmentedControlItem[] = [
    {
      label: (
        <Group align="center" spacing={8} noWrap>
          <ThemeIcon size={30} color={activePath === 'models' ? 'dark' : 'gray'} p={6}>
            <IconCategory />
          </ThemeIcon>
          <Text size="sm" inline>
            Models
          </Text>
        </Group>
      ),
      value: 'models',
    },
    {
      label: (
        <Group align="center" spacing={8} noWrap>
          <ThemeIcon size={30} color={activePath === 'images' ? 'dark' : 'gray'} p={6}>
            <IconPhoto />
          </ThemeIcon>
          <Text size="sm" inline>
            Images
          </Text>
        </Group>
      ),
      value: 'images',
    },
    {
      label: (
        <Group align="center" spacing={8} noWrap>
          <ThemeIcon size={30} color={activePath === 'posts' ? 'dark' : 'gray'} p={6}>
            <IconLayoutList />
          </ThemeIcon>
          <Text size="sm" inline>
            Posts
          </Text>
        </Group>
      ),
      value: 'posts',
    },
  ];
  if (features.articles)
    data.push({
      label: (
        <Group align="center" spacing={8} noWrap>
          <ThemeIcon size={30} color={activePath === 'articles' ? 'dark' : 'gray'} p={6}>
            <IconFileText />
          </ThemeIcon>
          <Text size="sm" inline>
            Articles
          </Text>
        </Group>
      ),
      value: 'articles',
    });
  if (features.alternateHome)
    data.unshift({
      label: (
        <Group align="center" spacing={8} noWrap>
          <ThemeIcon size={30} color={activePath === 'home' ? 'dark' : 'gray'} p={6}>
            <IconHome />
          </ThemeIcon>
          <Text size="sm" inline>
            Home
          </Text>
        </Group>
      ),
      value: 'home',
    });

  return (
    <SegmentedControl
      {...props}
      sx={(theme) => ({
        ...(typeof sx === 'function' ? sx(theme) : sx),
      })}
      size="md"
      classNames={classes}
      value={activePath}
      data={data}
      onChange={(value) => {
        const url = set(value as HomeOptions);
        router.push(url);
      }}
    />
  );
}

type Props = {
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
} & Omit<SegmentedControlProps, 'data' | 'value' | 'onChange'>;
