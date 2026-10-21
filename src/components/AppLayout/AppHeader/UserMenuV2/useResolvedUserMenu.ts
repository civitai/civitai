import { getPrimaryShade, useComputedColorScheme, useMantineTheme } from '@mantine/core';
import { useEventMenuItems } from '~/components/AppLayout/AppHeader/useEventMenuItems';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { UserMenuItemId } from '~/shared/constants/user-menu.constants';
import { resolveUserMenu } from './resolveUserMenu';
import { USER_MENU_LAYOUT, USER_MENU_SIGNED_OUT_LAYOUT } from './user-menu.layout';
import { useUserMenuRegistry } from './useUserMenuRegistry';

export function useResolvedUserMenu({
  opened,
  pins,
}: {
  opened: boolean;
  pins: readonly UserMenuItemId[];
}) {
  const currentUser = useCurrentUser();
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const registry = useUserMenuRegistry({ opened });
  const events = useEventMenuItems(theme.colors.grape[getPrimaryShade(theme, colorScheme)]);

  const { pinned, nodes } = currentUser
    ? resolveUserMenu(USER_MENU_LAYOUT, registry, pins)
    : resolveUserMenu(USER_MENU_SIGNED_OUT_LAYOUT, registry, []);

  return { signedIn: !!currentUser, events, pinned, nodes };
}
