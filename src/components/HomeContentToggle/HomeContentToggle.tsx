import { Button, createStyles, Group, Menu, Text } from '@mantine/core';
import {
  IconCalendar,
  IconCaretDown,
  IconCategory,
  IconFileText,
  IconHome,
  IconLayoutList,
  IconMoneybag,
  IconPhoto,
  IconProps,
  IconShoppingBag,
  IconTools,
  IconTrophy,
  IconVideo,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { FeatureAccess } from '~/server/services/feature-flags.service';
import { getDisplayName } from '~/utils/string-helpers';
import { isDefined } from '~/utils/type-guards';

type HomeOption = {
  key: string;
  url: string;
  icon: (props: IconProps) => JSX.Element;
  highlight?: boolean;
  grouped?: boolean;
  classes?: string[];
};
export const homeOptions: HomeOption[] = [
  {
    key: 'home',
    url: '/',
    icon: (props: IconProps) => <IconHome {...props} />,
  },
  {
    key: 'models',
    url: '/models',
    icon: (props: IconProps) => <IconCategory {...props} />,
  },
  {
    key: 'images',
    url: '/images',
    icon: (props: IconProps) => <IconPhoto {...props} />,
  },
  {
    key: 'videos',
    url: '/videos',
    icon: (props: IconProps) => <IconVideo {...props} />,
  },
  {
    key: 'posts',
    url: '/posts',
    icon: (props: IconProps) => <IconLayoutList {...props} />,
    grouped: true,
  },
  {
    key: 'articles',
    url: '/articles',
    icon: (props: IconProps) => <IconFileText {...props} />,
  },
  {
    key: 'bounties',
    url: '/bounties',
    icon: (props: IconProps) => <IconMoneybag {...props} />,
    grouped: true,
  },
  {
    key: 'tools',
    url: '/tools',
    icon: (props: IconProps) => <IconTools {...props} />,
    grouped: true,
  },
  {
    key: 'challenges',
    url: '/challenges',
    icon: (props: IconProps) => <IconTrophy {...props} />,
    grouped: true,
  },
  {
    key: 'events',
    url: '/events',
    icon: (props: IconProps) => <IconCalendar {...props} />,
    grouped: true,
  },
  {
    key: 'shop',
    url: '/shop',
    icon: (props: IconProps) => <IconShoppingBag {...props} />,
    classes: ['tabHighlight'],
  },
];

export function filterHomeOptions(features: FeatureAccess) {
  return homeOptions.filter(
    ({ key }) =>
      ![
        key === 'bounties' && !features.bounties,
        key === 'clubs' && !features.clubs,
        key === 'shop' && !features.cosmeticShop,
        key === 'articles' && !features.articles,
        key === 'tools' && !features.toolSearch,
      ].some((b) => b)
  );
}

const useTabsStyles = createStyles((theme) => ({
  tabHighlight: {
    backgroundColor: theme.fn.rgba(
      theme.colors.yellow[3],
      theme.colorScheme === 'dark' ? 0.1 : 0.3
    ),
    backgroundImage: `linear-gradient(90deg, ${theme.fn.rgba(
      theme.colors.yellow[4],
      0
    )}, ${theme.fn.rgba(
      theme.colors.yellow[4],
      theme.colorScheme === 'dark' ? 0.1 : 0.2
    )}, ${theme.fn.rgba(theme.colors.yellow[4], 0)})`,
    backgroundSize: '50px',
    backgroundPosition: '-300% 50%',
    backgroundRepeat: 'no-repeat',
    color: theme.colorScheme === 'dark' ? theme.colors.yellow[3] : theme.colors.yellow[8],
    animation: 'button-highlight 5s linear infinite',
    willChange: 'background-position',
  },

  // tabRainbow: {
  //   background: `linear-gradient(
  //       90deg,
  //       rgba(255, 0, 0, 1) 0%,
  //       rgba(255, 154, 0, 1) 10%,
  //       rgba(208, 222, 33, 1) 20%,
  //       rgba(79, 220, 74, 1) 30%,
  //       rgba(63, 218, 216, 1) 40%,
  //       rgba(47, 201, 226, 1) 50%,
  //       rgba(28, 127, 238, 1) 60%,
  //       rgba(95, 21, 242, 1) 70%,
  //       rgba(186, 12, 248, 1) 80%,
  //       rgba(251, 7, 217, 1) 90%,
  //       rgba(255, 0, 0, 1) 100%
  //   ) 0/200%`,
  //   animation: `${rainbowTextAnimation} 10s linear infinite`,
  //   ':hover': {
  //     background: `linear-gradient(
  //       90deg,
  //       rgba(255, 0, 0, 1) 0%,
  //       rgba(255, 154, 0, 1) 10%,
  //       rgba(208, 222, 33, 1) 20%,
  //       rgba(79, 220, 74, 1) 30%,
  //       rgba(63, 218, 216, 1) 40%,
  //       rgba(47, 201, 226, 1) 50%,
  //       rgba(28, 127, 238, 1) 60%,
  //       rgba(95, 21, 242, 1) 70%,
  //       rgba(186, 12, 248, 1) 80%,
  //       rgba(251, 7, 217, 1) 90%,
  //       rgba(255, 0, 0, 1) 100%
  //   ) 0/200%`,
  //   },
  //   '&[data-active]': {
  //     background: `linear-gradient(
  //       90deg,
  //       rgba(255, 0, 0, 1) 0%,
  //       rgba(255, 154, 0, 1) 10%,
  //       rgba(208, 222, 33, 1) 20%,
  //       rgba(79, 220, 74, 1) 30%,
  //       rgba(63, 218, 216, 1) 40%,
  //       rgba(47, 201, 226, 1) 50%,
  //       rgba(28, 127, 238, 1) 60%,
  //       rgba(95, 21, 242, 1) 70%,
  //       rgba(186, 12, 248, 1) 80%,
  //       rgba(251, 7, 217, 1) 90%,
  //       rgba(255, 0, 0, 1) 100%
  //   ) 0/200%`,
  //   },
  // },
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

export function HomeTabs() {
  const router = useRouter();
  const features = useFeatureFlags();
  const activePath = router.pathname.split('/')[1] || 'home';
  const { classes, cx } = useTabsStyles();

  const [moreOpened, setMoreOpened] = useState(false);

  const options = filterHomeOptions(features);

  return (
    <div className="flex items-center gap-1 overflow-x-auto overflow-y-hidden">
      {options.map(({ key, ...value }) => {
        return (
          <Button
            variant="default"
            key={key}
            component={Link}
            href={value.url}
            className={clsx('h-8 rounded-full border-none py-2 pl-3 pr-4', {
              ['bg-gray-4 dark:bg-dark-4']: activePath === key,
              [classes.groupedOptions]: value.grouped,
              [classes.tabHighlight]: key === 'shop',
            })}
            classNames={{ label: 'flex gap-2 items-center capitalize overflow-visible' }}
          >
            {value.icon({ size: 16 })}
            <span className="text-base font-medium capitalize">{getDisplayName(key)}</span>
          </Button>
        );
      })}
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
          {options
            .filter((value) => value.grouped)
            .map((value) => (
              <Link legacyBehavior key={value.key} href={value.url} passHref>
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
                    <Text tt="capitalize">{getDisplayName(value.key)}</Text>
                  </Group>
                </Menu.Item>
              </Link>
            ))}
        </Menu.Dropdown>
      </Menu>
    </div>
  );
}
