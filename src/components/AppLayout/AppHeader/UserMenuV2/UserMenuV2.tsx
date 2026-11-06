import { useState } from 'react';
import { UserMenuTrigger } from '~/components/AppLayout/AppHeader/UserMenu';
import { useChatStore } from '~/components/Chat/ChatProvider';
import { useQueryNotificationsCount } from '~/components/Notifications/notifications.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import type { UserMenuBadgeItemId } from '~/shared/constants/user-menu.constants';
import { UserMenuDesktop } from './UserMenuDesktop';
import { UserMenuMobile } from './UserMenuMobile';
import { attentionCount, toAttentionCounts } from './attentionCount';
import { useUserMenuPins } from './useUserMenuPins';

export type UserMenuShellProps = {
  open: boolean;
  setOpen: (open: boolean) => void;
  pins: ReturnType<typeof useUserMenuPins>;
  trigger: React.ReactElement;
};

/**
 * The body mounts only while open, so its queries (bookmark collections, bug-report area) run on
 * open, not with the header.
 */
export default function UserMenuV2() {
  const currentUser = useCurrentUser();
  const isMobile = useIsMobile({ breakpoint: 'md' });
  const [open, setOpenState] = useState(false);
  const pins = useUserMenuPins();
  const attention = useAttentionCount(pins.mutedBadges);

  const setOpen = (next: boolean) => {
    if (!next) pins.flush();
    // On a phone the menu sheet and the chat window are both full-screen.
    if (next && isMobile) useChatStore.setState({ open: false });
    setOpenState(next);
  };

  const trigger = (
    <UserMenuTrigger
      open={open}
      badge={
        currentUser && attention > 0 ? (attention > 99 ? '99+' : String(attention)) : undefined
      }
    />
  );

  const Shell = isMobile ? UserMenuMobile : UserMenuDesktop;
  return <Shell open={open} setOpen={setOpen} pins={pins} trigger={trigger} />;
}

/**
 * Everything in the menu waiting on the viewer that they have not muted, from the counts query the
 * header already runs.
 */
function useAttentionCount(muted: UserMenuBadgeItemId[]) {
  return attentionCount(toAttentionCounts(useQueryNotificationsCount()), muted);
}
