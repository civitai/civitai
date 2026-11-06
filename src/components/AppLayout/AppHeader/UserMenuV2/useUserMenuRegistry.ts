import { IconAward, IconScreenShare, IconSwords, IconTrophy } from '@tabler/icons-react';
import { useMantineTheme, getPrimaryShade, useComputedColorScheme } from '@mantine/core';
import { useGetActionMenuItems, useGetMenuItems } from '~/components/AppLayout/AppHeader/hooks';
import { openCivitaiLinkDialog } from '~/components/CivitaiLink/CivitaiLinkPopover';
import { useQueryNotificationsCount } from '~/components/Notifications/notifications.utils';
import { useSupportMenuItems } from '~/components/Support/useSupportMenuItems';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { UserMenuRegistry } from './resolveUserMenu';

/** Definitions shared with the current menu come from `useGetMenuItems`; the rest are added here. */
export function useUserMenuRegistry({ opened }: { opened: boolean }): UserMenuRegistry {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const groups = useGetMenuItems();
  const actions = useGetActionMenuItems();
  const support = useSupportMenuItems({ opened });
  const { unclaimedPrizes } = useQueryNotificationsCount();

  const registry: UserMenuRegistry = {};
  for (const group of groups) {
    if (group.visible === false) continue;
    for (const item of group.items) if (item.id) registry[item.id] = item;
  }
  for (const item of actions) if (item.id) registry[item.id] = item;
  for (const { id, ...item } of support) registry[id] = { ...item, external: !!item.href };

  registry.prizes = {
    href: '/prizes',
    visible: !!currentUser,
    icon: IconAward,
    color: theme.colors.yellow[getPrimaryShade(theme, colorScheme ?? 'dark')],
    label: 'Prizes',
    badge: unclaimedPrizes,
    badgeTooltip: "Prizes you haven't claimed yet",
  };
  // The site pages, as the nav bar links them; `challenges` is "Your Challenges".
  registry['browse-challenges'] = {
    href: '/challenges',
    visible: features.challengePlatform,
    icon: IconTrophy,
    color: theme.colors.pink[getPrimaryShade(theme, colorScheme ?? 'dark')],
    label: 'Challenges',
  };
  registry.crucibles = {
    href: '/crucibles',
    visible: features.crucible,
    icon: IconSwords,
    color: theme.colors.pink[getPrimaryShade(theme, colorScheme ?? 'dark')],
    label: 'Crucibles',
  };
  registry['civitai-link'] = {
    visible: !!currentUser && features.buzzSpendPop,
    icon: IconScreenShare,
    label: 'Civitai Link',
    onClick: () => openCivitaiLinkDialog(),
  };

  return registry;
}
