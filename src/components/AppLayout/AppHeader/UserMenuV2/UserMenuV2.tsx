import { useState } from 'react';
import { UserMenuTrigger } from '~/components/AppLayout/AppHeader/UserMenu';
import { useQueryNotificationsCount } from '~/components/Notifications/notifications.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import type { UserMenuBadgeItemId } from '~/shared/constants/user-menu.constants';
import { UserMenuDesktop } from './UserMenuDesktop';
import { UserMenuMobile } from './UserMenuMobile';
import { attentionCount } from './attentionCount';
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
    setOpenState(next);
  };

  const trigger = (
    <UserMenuTrigger
      open={open}
      className="relative"
      indicator={
        currentUser && attention > 0 ? (
          <span
            className="absolute -top-0.5 left-0 z-10 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-6 px-1 text-[10px] font-bold leading-none text-white @max-md:left-auto @max-md:right-0"
            aria-label={`${attention} waiting for you`}
          >
            {attention > 99 ? '99+' : attention}
          </span>
        ) : undefined
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
  const { pendingPlacements, pendingCollectionReviews, unopenedBoxes, unclaimedPrizes } =
    useQueryNotificationsCount();
  return attentionCount(
    {
      placements: pendingPlacements,
      collections: pendingCollectionReviews,
      inventory: unopenedBoxes,
      prizes: unclaimedPrizes,
    },
    muted
  );
}
