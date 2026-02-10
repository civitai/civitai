import { Badge, Button, Group, Menu, Text } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import type { IconProps } from '@tabler/icons-react';
import {
  IconBook,
  IconCalendar,
  IconCaretDown,
  IconCategory,
  IconContract,
  IconFileText,
  IconHome,
  IconLayoutList,
  IconMoneybag,
  IconPhoto,
  IconPointFilled,
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
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import { getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import classes from './HomeContentToggle.module.css';
import animationClasses from '~/libs/animations.module.scss';

type HomeOption = {
  key: string;
  url: string;
  icon: (props: IconProps) => JSX.Element;
  new?: Date;
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
    key: 'comics',
    url: '/comics',
    icon: (props: IconProps) => <IconBook {...props} />,
    new: new Date('2026-03-01'),
  },
  {
    key: 'bounties',
    url: '/bounties',
    icon: (props: IconProps) => <IconMoneybag {...props} />,
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
    key: 'updates',
    url: '/changelog',
    icon: (props: IconProps) => <IconContract {...props} />,
    grouped: true,
    // new: new Date('2025-05-26'),
  },
  {
    key: 'shop',
    url: '/shop',
    icon: (props: IconProps) => <IconShoppingBag {...props} />,
    classes: ['tabRainbow'],
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
        key === 'challenges' && !features.challengePlatform,
      ].some((b) => b)
  );
}

export function HomeTabs() {
  const router = useRouter();
  const features = useFeatureFlags();
  const activePath = router.pathname.split('/')[1] || 'home';

  const [moreOpened, setMoreOpened] = useState(false);
  const [lastSeenChangelog] = useLocalStorage<number>({
    key: 'last-seen-changelog',
    defaultValue: 0,
    getInitialValueInEffect: false,
  });

  const { data: latestChangelog } = trpc.changelog.getLatest.useQuery();

  const options = filterHomeOptions(features);

  return (
    <div className="flex items-center gap-1 overflow-x-auto overflow-y-hidden text-black @md:overflow-visible dark:text-white">
      {options.map(({ key, ...value }) => {
        return (
          <Button
            key={key}
            variant="default"
            component={Link}
            href={value.url}
            className={clsx('h-8 overflow-visible rounded-full border-none py-2 pl-3 pr-4', {
              ['bg-gray-4 dark:bg-dark-4']:
                activePath === key || (activePath === 'changelog' && key === 'updates'),
              [classes.groupedOptions]: value.grouped,
              [classes.tabHighlight]: key === 'shop',
            })}
            classNames={{ label: 'flex gap-2 items-center capitalize overflow-visible' }}
          >
            {value.icon({ size: 16 })}
            <span className="text-base font-medium capitalize">{getDisplayName(key)}</span>
            {key === 'updates' && (latestChangelog ?? 0) > lastSeenChangelog && (
              <IconPointFilled color="green" size={20} />
            )}
            {!!value.new && value.new > new Date() && <Badge>New</Badge>}
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
            <Group gap={4} wrap="nowrap">
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
                  leftSection={value.icon({ size: 16 })}
                  className={clsx(
                    value.classes
                      ?.map((c) => {
                        if (classes.hasOwnProperty(c)) return classes[c as keyof typeof classes];
                        return null;
                      })
                      .filter(isDefined)
                  )}
                >
                  <Group gap={8} wrap="nowrap">
                    <Text tt="capitalize">{getDisplayName(value.key)}</Text>
                    {value.key === 'updates' && (latestChangelog ?? 0) > lastSeenChangelog && (
                      <IconPointFilled color="green" size={20} />
                    )}
                    {!!value.new && value.new > new Date() && <Badge>New</Badge>}
                  </Group>
                </Menu.Item>
              </Link>
            ))}
        </Menu.Dropdown>
      </Menu>
    </div>
  );
}
