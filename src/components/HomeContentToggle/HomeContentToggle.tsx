import {
  Anchor,
  Group,
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlProps,
  Tabs,
  TabsProps,
  Text,
  ThemeIcon,
  createStyles,
  Badge,
  Menu,
  Button,
  keyframes,
} from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import {
  IconCalendar,
  IconCaretDown,
  IconCategory,
  IconClubs,
  IconCpu,
  IconFileText,
  IconHome,
  IconLayoutList,
  IconMoneybag,
  IconPhoto,
  IconShoppingBag,
  IconVideo,
  IconProps,
  IconRainbow,
} from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { getDisplayName } from '~/utils/string-helpers';
import { isDefined } from '~/utils/type-guards';

type HomeOption = {
  url: string;
  icon: (props: IconProps) => JSX.Element;
  highlight?: boolean;
  grouped?: boolean;
  classes?: string[];
};
const homeOptions: Record<string, HomeOption> = {
  home: {
    url: '/',
    icon: (props: IconProps) => <IconHome {...props} />,
  },
  models: {
    url: '/models',
    icon: (props: IconProps) => <IconCategory {...props} />,
  },
  images: {
    url: '/images',
    icon: (props: IconProps) => <IconPhoto {...props} />,
  },
  videos: {
    url: '/videos',
    icon: (props: IconProps) => <IconVideo {...props} />,
  },
  posts: {
    url: '/posts',
    icon: (props: IconProps) => <IconLayoutList {...props} />,
    grouped: true,
  },
  articles: {
    url: '/articles',
    icon: (props: IconProps) => <IconFileText {...props} />,
  },
  bounties: {
    url: '/bounties',
    icon: (props: IconProps) => <IconMoneybag {...props} />,
    grouped: true,
  },
  events: {
    url: '/events',
    icon: (props: IconProps) => <IconCalendar {...props} />,
  },
  // clubs: {
  //   url: '/clubs',
  //   icon: (props: IconProps) => <IconClubs {...props} />,
  // },
  // builds: {
  //   url: '/builds',
  //   icon: (props: IconProps) => <IconCpu {...props} />,
  //   grouped: true,
  // },
  shop: {
    url: '/shop',
    icon: (props: IconProps) => <IconShoppingBag {...props} />,
    highlight: true,
  },
};
type HomeOptions = keyof typeof homeOptions;

const useStyles = createStyles<string, { hideActive?: boolean }>((_, params) => ({
  label: {
    paddingTop: 4,
    paddingBottom: 4,
    paddingLeft: 6,
    paddingRight: 10,
  },
  active: {
    // Manually adjust the active state to match the design
    marginTop: 4,
    marginLeft: 3,
    borderRadius: 0,
    display: params.hideActive ? 'none' : 'block',
  },
  themeIcon: {
    root: {
      backgroundColor: 'transparent',
    },
  },
  root: {
    backgroundColor: 'transparent',
    gap: 8,
    borderRadius: 0,

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
              set(key as HomeOptions);
            }}
            noWrap
          >
            <ThemeIcon size={30} color={'transparent'} p={4}>
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
    disabled: [
      key === 'bounties' && !features.bounties,
      key === 'clubs' && !features.clubs,
      key === 'shop' && !features.cosmeticShop,
    ].some((b) => b),
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

const rainbowTextAnimation = keyframes({
  '0%': {
    backgroundPosition: '0% 50%',
  },
  '50%': {
    backgroundPosition: '100% 50%',
  },
  '100%': {
    backgroundPosition: '0% 50%',
  },
});
const useTabsStyles = createStyles((theme) => ({
  root: {
    overflow: 'auto hidden',
  },
  tab: {
    paddingTop: 8,
    paddingBottom: 8,
    paddingLeft: 10,
    paddingRight: 16,
    color: theme.colorScheme === 'dark' ? theme.white : theme.colors.gray[8],
    [`&[data-active]`]: {
      color: theme.colorScheme === 'dark' ? theme.white : theme.colors.gray[8],
      background: theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[4],
      [`&:hover`]: {
        background: theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[4],
      },
    },
    [`&:hover`]: {
      background: theme.colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[3],
    },
  },
  tabLabel: {
    fontSize: 16,
    fontWeight: 500,
    textTransform: 'capitalize',
  },
  tabsList: {
    backgroundColor: 'transparent',
    gap: 8,
    borderRadius: 0,
    flexWrap: 'nowrap',

    [containerQuery.smallerThan('sm')]: {
      maxWidth: '100%',
    },
  },
  tabHighlight: {
    backgroundColor: theme.fn.rgba(theme.colors.green[3], theme.colorScheme === 'dark' ? 0.1 : 0.3),
    backgroundImage: `linear-gradient(to left, violet, indigo, blue, green, yellow, orange, red);`,
    backgroundSize: '50px',
    backgroundPosition: '-300% 50%',
    backgroundRepeat: 'no-repeat',
    color: theme.colorScheme === 'dark' ? theme.colors.green[3] : theme.colors.green[8],
    animation: 'button-highlight 5s linear infinite',
    willChange: 'background-position',
  },

  tabRainbow: {
    background: `linear-gradient(
        90deg,
        rgba(255, 0, 0, 1) 0%,
        rgba(255, 154, 0, 1) 10%,
        rgba(208, 222, 33, 1) 20%,
        rgba(79, 220, 74, 1) 30%,
        rgba(63, 218, 216, 1) 40%,
        rgba(47, 201, 226, 1) 50%,
        rgba(28, 127, 238, 1) 60%,
        rgba(95, 21, 242, 1) 70%,
        rgba(186, 12, 248, 1) 80%,
        rgba(251, 7, 217, 1) 90%,
        rgba(255, 0, 0, 1) 100%
    ) 0/200%`,
    animation: `${rainbowTextAnimation} 10s linear infinite`,
    ':hover': {
      background: `linear-gradient(
        90deg,
        rgba(255, 0, 0, 1) 0%,
        rgba(255, 154, 0, 1) 10%,
        rgba(208, 222, 33, 1) 20%,
        rgba(79, 220, 74, 1) 30%,
        rgba(63, 218, 216, 1) 40%,
        rgba(47, 201, 226, 1) 50%,
        rgba(28, 127, 238, 1) 60%,
        rgba(95, 21, 242, 1) 70%,
        rgba(186, 12, 248, 1) 80%,
        rgba(251, 7, 217, 1) 90%,
        rgba(255, 0, 0, 1) 100%
    ) 0/200%`,
    },
    '&[data-active]': {
      background: `linear-gradient(
        90deg,
        rgba(255, 0, 0, 1) 0%,
        rgba(255, 154, 0, 1) 10%,
        rgba(208, 222, 33, 1) 20%,
        rgba(79, 220, 74, 1) 30%,
        rgba(63, 218, 216, 1) 40%,
        rgba(47, 201, 226, 1) 50%,
        rgba(28, 127, 238, 1) 60%,
        rgba(95, 21, 242, 1) 70%,
        rgba(186, 12, 248, 1) 80%,
        rgba(251, 7, 217, 1) 90%,
        rgba(255, 0, 0, 1) 100%
    ) 0/200%`,
    },
  },
  moreButton: {
    padding: '8px 10px 8px 16px',
    fontSize: 16,
    fontWeight: 500,
    display: 'none',

    [`&[data-active="true"]`]: {
      background: theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[4],
      color: theme.colorScheme === 'dark' ? theme.white : theme.colors.gray[8],
    },

    ['@container (min-width: 992px) and (max-width: 1440px)']: {
      display: 'block',
    },
  },

  groupedOptions: {
    display: 'block',

    ['@container (min-width: 992px) and (max-width: 1440px)']: {
      display: 'none',
    },
  },
}));

export function HomeTabs({ sx, ...tabProps }: HomeTabProps) {
  const router = useRouter();
  const { set } = useHomeSelection();
  const features = useFeatureFlags();
  const activePath = router.pathname.split('/')[1] || 'home';
  const { classes, cx } = useTabsStyles();

  const [moreOpened, setMoreOpened] = useState(false);

  const tabs = Object.entries(homeOptions)
    .filter(
      ([key]) =>
        ![
          key === 'bounties' && !features.bounties,
          key === 'clubs' && !features.clubs,
          key === 'shop' && !features.cosmeticShop,
        ].some((b) => b)
    )
    .map(([key, value]) => {
      return (
        <Link key={key} href={value.url} passHref>
          <Anchor
            variant="text"
            className={cx(value.grouped && classes.groupedOptions)}
            onClick={() => set(key as HomeOptions)}
          >
            <Tabs.Tab
              value={key}
              icon={value.icon({ size: 16 })}
              className={cx(
                value.classes
                  ?.map((c) => {
                    if (classes.hasOwnProperty(c)) return classes[c as keyof typeof classes];
                    return null;
                  })
                  .filter(isDefined)
              )}
            >
              <Group spacing={4} noWrap>
                <Text className={classes.tabLabel} inline>
                  {getDisplayName(key)}
                </Text>
              </Group>
            </Tabs.Tab>
          </Anchor>
        </Link>
      );
    });

  // TODO.homeTabs: make these be a select dropdown on mobile
  return (
    <Group spacing={8} className={classes.root} noWrap>
      <Tabs
        variant="pills"
        radius="xl"
        defaultValue="home"
        color="gray"
        {...tabProps}
        sx={(theme) => ({
          ...(typeof sx === 'function' ? sx(theme) : sx),
        })}
        value={activePath}
        classNames={classes}
      >
        <Tabs.List>{tabs}</Tabs.List>
      </Tabs>
      <Menu position="bottom-end" onChange={setMoreOpened}>
        <Menu.Target>
          <Button
            radius="xl"
            size="sm"
            color="gray"
            variant="subtle"
            data-active={moreOpened}
            className={classes.moreButton}
          >
            <Group spacing={4} noWrap>
              More
              <IconCaretDown size={16} fill="currentColor" />
            </Group>
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          {Object.entries(homeOptions)
            .filter(([, value]) => value.grouped)
            .map(([key, value]) => (
              <Link key={key} href={value.url} passHref>
                <Menu.Item
                  component="a"
                  icon={value.icon({ size: 16 })}
                  className={cx(
                    value.classes
                      ?.map((c) => {
                        if (classes.hasOwnProperty(c)) return classes[c as keyof typeof classes];
                        return null;
                      })
                      .filter(isDefined)
                  )}
                >
                  <Group spacing={8} noWrap>
                    <Text tt="capitalize">{getDisplayName(key)}</Text>
                  </Group>
                </Menu.Item>
              </Link>
            ))}
        </Menu.Dropdown>
      </Menu>
    </Group>
  );
}

type HomeTabProps = Omit<TabsProps, 'value' | 'defaultValue' | 'children'>;
