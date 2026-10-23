import { Badge } from '@mantine/core';
import { IconBell, IconBellOff, IconPin, IconPinFilled } from '@tabler/icons-react';
import clsx from 'clsx';
import { createContext, useCallback, useEffect, useRef, useState } from 'react';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { QueueCountBadge } from '~/components/Placement/QueueCountBadge';
import type { UserMenuItem } from '~/components/AppLayout/AppHeader/hooks';
import type { ResolvedMenuItem } from './resolveUserMenu';
import type { useUserMenuPins } from './useUserMenuPins';
import {
  findUserMenuGroup,
  USER_MENU_LAYOUT,
  USER_MENU_SIGNED_OUT_LAYOUT,
} from './user-menu.layout';
import { useTrackEvent } from '~/components/TrackView/track.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { TrackActionInput } from '~/server/schema/track.schema';
import { isUserMenuBadgeItemId } from '~/shared/constants/user-menu.constants';
import type { UserMenuItemId } from '~/shared/constants/user-menu.constants';
import { USER_MENU_HEADER_GROUP } from '~/shared/constants/user-menu-groups.constants';
import { Currency } from '~/shared/utils/prisma/enums';

export function MenuItemLabel({ item }: { item: UserMenuItem & { badgeMuted?: boolean } }) {
  return (
    <span className="flex items-center gap-1">
      <span className="text-sm leading-none">{item.label}</span>
      {item.currency && <CurrencyIcon currency={Currency.BUZZ} size={16} />}
      {(item.isNew || (!!item.newUntil && Date.now() < item.newUntil.getTime())) && (
        <Badge color="green.8" variant="filled" size="sm" ml={4}>
          NEW
        </Badge>
      )}
      <QueueCountBadge
        count={item.badge ?? 0}
        max={99}
        ml={4}
        color={item.badgeMuted ? 'gray' : undefined}
      />
    </span>
  );
}

/** Reveals on hover/focus of a `group` ancestor; `touch` shows it always, faintly. */
export function PinGlyph({ pinned, touch }: { pinned: boolean; touch?: boolean }) {
  const Glyph = pinned ? IconPinFilled : IconPin;
  return (
    <Glyph
      size={16}
      stroke={1.5}
      aria-hidden
      className={clsx(
        'transition-opacity',
        touch
          ? pinned
            ? 'opacity-80'
            : 'opacity-40'
          : 'opacity-0 group-hover:opacity-70 group-focus-visible:opacity-70 group-data-[hovered]:opacity-70'
      )}
    />
  );
}

export type PinTarget = Pick<ResolvedMenuItem, 'id' | 'label'>;

/** The profile row above the menu is in no group, but it is a pinnable item. */
export const PROFILE_PIN: PinTarget = { id: 'profile', label: 'Your Profile' };

/** Bell on a row whose count lights the avatar; crossed out while that count is muted. */
export function MuteGlyph({ muted, touch }: { muted: boolean; touch?: boolean }) {
  const Glyph = muted ? IconBellOff : IconBell;
  return (
    <Glyph
      size={16}
      stroke={1.5}
      aria-hidden
      className={clsx(
        'transition-opacity',
        touch
          ? muted
            ? 'opacity-80'
            : 'opacity-40'
          : muted
          ? 'opacity-60'
          : 'opacity-0 group-hover:opacity-70 group-focus-visible:opacity-70 group-data-[hovered]:opacity-70'
      )}
    />
  );
}

/** Toggles the mute on a row's count; absent where counts cannot be muted (signed out, legacy). */
export const BadgeMuteCtx = createContext<
  ((item: Pick<ResolvedMenuItem, 'id' | 'label'>) => void) | undefined
>(undefined);

/** A count can be muted only where it is shown: a mutable item with something waiting. */
export const canMuteBadge = (item: { id?: UserMenuItemId; badge?: number }, toggleMute: unknown) =>
  !!toggleMute && isUserMenuBadgeItemId(item.id) && (item.badge ?? 0) > 0;

/** Render `region` once in the menu: it is the live region the announcements go to. */
export function usePinActions(pins: ReturnType<typeof useUserMenuPins>) {
  const [message, setMessage] = useState('');
  const announce = useCallback((text: string) => setMessage(text), []);
  const toggle = (item: PinTarget) => {
    if (!pins.canEdit) return;
    const wasPinned = pins.pins.includes(item.id);
    pins.toggle(item.id);
    announce(`${wasPinned ? 'Unpinned' : 'Pinned'} ${item.label}`);
  };
  const toggleMute = (item: Pick<ResolvedMenuItem, 'id' | 'label'>) => {
    if (!pins.canEdit || !isUserMenuBadgeItemId(item.id)) return;
    const wasMuted = pins.mutedBadges.includes(item.id);
    pins.toggleBadgeMute(item.id);
    announce(`${wasMuted ? 'Unmuted' : 'Muted'} the count on ${item.label}`);
  };
  const region = (
    <div aria-live="polite" className="sr-only">
      {message}
    </div>
  );
  return { toggle, toggleMute, announce, region };
}

/**
 * A drop ends in a click on the row that was dragged. dnd-kit stops that click's propagation but
 * does not cancel it, so React never sees it and the browser still follows the link: a full page
 * load. This cancels it, from a window listener that runs before dnd-kit's document one.
 */
export function useDragClickGuard() {
  const dragging = useRef(false);
  useEffect(() => {
    const cancel = (event: MouseEvent) => {
      if (!dragging.current) return;
      event.preventDefault();
      event.stopPropagation();
    };
    // dnd-kit skips the end and cancel callbacks when the browser cancels a drag before it has
    // rendered, which would leave every later click cancelled. Every drag starts after a pointerdown.
    const reset = (event: PointerEvent) => {
      if (event.isPrimary) dragging.current = false;
    };
    window.addEventListener('click', cancel, true);
    window.addEventListener('pointerdown', reset, true);
    return () => {
      window.removeEventListener('click', cancel, true);
      window.removeEventListener('pointerdown', reset, true);
    };
  }, []);
  return {
    onDragStart: () => {
      dragging.current = true;
    },
    // Cleared after the click the drop produces, which is dispatched before any timer runs.
    onDragSettled: () => {
      window.setTimeout(() => (dragging.current = false));
    },
  };
}

export type UserMenuSurface = 'desktop' | 'mobile';

export function userMenuClickAction({
  id,
  signedIn,
  fromPins,
  surface,
}: {
  id: UserMenuItemId;
  signedIn: boolean;
  fromPins: boolean;
  surface: UserMenuSurface;
}): TrackActionInput {
  const layout = signedIn ? USER_MENU_LAYOUT : USER_MENU_SIGNED_OUT_LAYOUT;
  return {
    type: 'UserMenu_Click',
    details: { item: id, group: findUserMenuGroup(layout, id) ?? null, pinned: fromPins, surface },
  };
}

/**
 * Records an item opened from the menu. Call it from the row's own click handler: the click
 * `useDragClickGuard` cancels never reaches React, and a pin toggle stops its click before the row.
 */
export function useTrackMenuOpen(surface: UserMenuSurface) {
  const { trackAction } = useTrackEvent();
  const signedIn = !!useCurrentUser();
  return (id: UserMenuItemId | undefined, fromPins: boolean) => {
    if (!id) return;
    trackAction(userMenuClickAction({ id, signedIn, fromPins, surface })).catch(() => undefined);
  };
}

/**
 * Records the profile and Buzz rows above the menu. They link where the `profile` and
 * `buzz-dashboard` items do, so opens from both places show whether a pin of either is redundant.
 */
export function useTrackHeaderOpen(surface: UserMenuSurface) {
  const { trackAction } = useTrackEvent();
  return (item: Extract<UserMenuItemId, 'profile' | 'buzz-dashboard'>) =>
    trackAction({
      type: 'UserMenu_Click',
      details: { item, group: USER_MENU_HEADER_GROUP, pinned: false, surface },
    }).catch(() => undefined);
}

export const isPinKey = (event: React.KeyboardEvent) =>
  event.key.toLowerCase() === 'p' &&
  !event.altKey &&
  !event.ctrlKey &&
  !event.metaKey &&
  !event.shiftKey;

export const isMuteKey = (event: React.KeyboardEvent) =>
  event.key.toLowerCase() === 'm' &&
  !event.altKey &&
  !event.ctrlKey &&
  !event.metaKey &&
  !event.shiftKey;

export const pinMoveDirection = (event: React.KeyboardEvent) =>
  !event.altKey ? 0 : event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
