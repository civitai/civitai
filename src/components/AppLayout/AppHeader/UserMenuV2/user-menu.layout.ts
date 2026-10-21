import type { Icon, IconProps } from '@tabler/icons-react';
import { IconBookmark, IconChartHistogram, IconCrown, IconLifebuoy } from '@tabler/icons-react';
import type { ForwardRefExoticComponent, RefAttributes } from 'react';
import type { UserMenuItemId } from '~/shared/constants/user-menu.constants';

/**
 * Data only: item definitions (link, icon, visibility, badge) live in the registry, keyed by the
 * same id. Depth is capped at `USER_MENU_MAX_DEPTH`, held by a unit test.
 */
export type UserMenuItemNode = { kind: 'item'; id: UserMenuItemId };
export type UserMenuGroupNode = {
  kind: 'group';
  id: string;
  label: string;
  icon: ForwardRefExoticComponent<IconProps & RefAttributes<Icon>>;
  children: UserMenuNode[];
};
export type UserMenuNode = UserMenuItemNode | UserMenuGroupNode;

export const USER_MENU_MAX_DEPTH = 3;

const item = (id: UserMenuItemId): UserMenuItemNode => ({ kind: 'item', id });
const group = (
  id: string,
  label: string,
  icon: UserMenuGroupNode['icon'],
  children: UserMenuNode[]
): UserMenuGroupNode => ({ kind: 'group', id, label, icon, children });

const getHelp = group('help', 'Get help', IconLifebuoy, [
  item('support-report-bug'),
  item('support-education'),
  item('support-faq'),
  item('support-discord'),
  item('support-assistant'),
  item('support-portal'),
  item('getting-started'),
  item('link-app'),
  item('civitai-link'),
]);

export const USER_MENU_LAYOUT: UserMenuNode[] = [
  group('your-stuff', 'Your stuff', IconBookmark, [
    item('collections'),
    item('liked-models'),
    item('bookmarked-articles'),
    item('following'),
    item('downloads'),
    item('vault'),
    item('bounties'),
    item('challenges'),
  ]),
  group('creator-tools', 'Creator tools', IconChartHistogram, [
    item('creator-studio'),
    item('creator-journey'),
    item('training'),
    item('placements'),
    item('my-shop'),
    item('apps'),
  ]),
  group('rewards', 'Rewards and play', IconCrown, [
    item('inventory'),
    item('prizes'),
    item('referrals'),
    item('leaderboard'),
    item('auctions'),
    item('knights-of-new'),
  ]),
  getHelp,
];

export const USER_MENU_SIGNED_OUT_LAYOUT: UserMenuNode[] = [
  item('leaderboard'),
  item('auctions'),
  getHelp,
  item('sign-in'),
];
