import { Button, Group, Menu, Text } from '@mantine/core';
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
import { styles } from './HomeContentToggle.styles';

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

export function HomeTabs() {
  const router = useRouter();
  const features = useFeatureFlags();
  const [opened, setOpened] = useState(false);

  const filteredOptions = filterHomeOptions(features);
  const groupedOptions = filteredOptions.filter((option) => option.grouped);
  const ungroupedOptions = filteredOptions.filter((option) => !option.grouped);

  return (
    <Group spacing={0}>
      {ungroupedOptions.map((option) => {
        const isActive = router.pathname === option.url;
        const Icon = option.icon;

        return (
          <Button
            key={option.key}
            component={Link}
            href={option.url}
            variant="subtle"
            color="gray"
            size="md"
            sx={option.classes?.map((c) => styles[c])}
            data-active={isActive}
          >
            <Group spacing={8} noWrap>
              <Icon size={20} />
              <Text>{getDisplayName(option.key)}</Text>
            </Group>
          </Button>
        );
      })}

      {groupedOptions.length > 0 && (
        <Menu position="bottom-end" withinPortal opened={opened} onChange={setOpened} width={200}>
          <Menu.Target>
            <Button
              variant="subtle"
              color="gray"
              size="md"
              sx={styles.moreButton}
              data-active={opened}
            >
              <Group spacing={8} noWrap>
                <Text>More</Text>
                <IconCaretDown size={16} />
              </Group>
            </Button>
          </Menu.Target>

          <Menu.Dropdown>
            {groupedOptions.map((option) => {
              const isActive = router.pathname === option.url;
              const Icon = option.icon;

              return (
                <Menu.Item
                  key={option.key}
                  component={Link}
                  href={option.url}
                  icon={<Icon size={20} />}
                  data-active={isActive}
                >
                  {getDisplayName(option.key)}
                </Menu.Item>
              );
            })}
          </Menu.Dropdown>
        </Menu>
      )}
    </Group>
  );
}
