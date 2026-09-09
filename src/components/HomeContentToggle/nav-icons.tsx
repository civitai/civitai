import type { IconProps } from '@tabler/icons-react';
import {
  IconBook,
  IconBookmark,
  IconCalendar,
  IconCategory,
  IconCloudLock,
  IconContract,
  IconCrown,
  IconCube,
  IconFileText,
  IconGavel,
  IconHome,
  IconLayoutGrid,
  IconLayoutList,
  IconMoneybag,
  IconPhoto,
  IconShoppingBag,
  IconTrophy,
  IconVideo,
} from '@tabler/icons-react';
import type { NavKey } from '~/shared/constants/nav.constants';

/**
 * Split out of the registry so the registry stays importable by the node test project. The
 * `Record<NavKey, …>` means a new key cannot ship without an icon.
 */
export const navIcons: Record<NavKey, (props: IconProps) => JSX.Element> = {
  home: (props) => <IconHome {...props} />,
  models: (props) => <IconCategory {...props} />,
  images: (props) => <IconPhoto {...props} />,
  videos: (props) => <IconVideo {...props} />,
  '3d-models': (props) => <IconCube {...props} />,
  hubs: (props) => <IconLayoutGrid {...props} />,
  posts: (props) => <IconLayoutList {...props} />,
  articles: (props) => <IconFileText {...props} />,
  comics: (props) => <IconBook {...props} />,
  bounties: (props) => <IconMoneybag {...props} />,
  challenges: (props) => <IconTrophy {...props} />,
  events: (props) => <IconCalendar {...props} />,
  updates: (props) => <IconContract {...props} />,
  shop: (props) => <IconShoppingBag {...props} />,
  leaderboard: (props) => <IconCrown {...props} />,
  auctions: (props) => <IconGavel {...props} />,
  vault: (props) => <IconCloudLock {...props} />,
  collections: (props) => <IconBookmark {...props} />,
};
