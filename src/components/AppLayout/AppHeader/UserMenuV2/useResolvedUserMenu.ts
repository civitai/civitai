import { getPrimaryShade, useComputedColorScheme, useMantineTheme } from '@mantine/core';
import { useEventMenuItems } from '~/components/AppLayout/AppHeader/useEventMenuItems';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { UserMenuItemId } from '~/shared/constants/user-menu.constants';
import { resolveUserMenu } from './resolveUserMenu';
import { getUserMenuLayout } from './user-menu.layout';
import { useUserMenuRegistry } from './useUserMenuRegistry';

export function useResolvedUserMenu({
  opened,
  pins,
  muted,
  mobile,
}: {
  opened: boolean;
  mobile: boolean;
  pins: readonly UserMenuItemId[];
  muted: readonly UserMenuItemId[];
}) {
  const currentUser = useCurrentUser();
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const registry = useUserMenuRegistry({ opened });
  const events = useEventMenuItems(theme.colors.grape[getPrimaryShade(theme, colorScheme)]);

  const layout = getUserMenuLayout({ signedIn: !!currentUser, mobile });
  const { pinned, nodes } = currentUser
    ? resolveUserMenu(layout, registry, pins, new Set(muted))
    : resolveUserMenu(layout, registry, []);

  return { signedIn: !!currentUser, events, pinned, nodes };
}
