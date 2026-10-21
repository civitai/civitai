import { Badge } from '@mantine/core';
import { IconPin, IconPinFilled } from '@tabler/icons-react';
import clsx from 'clsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { QueueCountBadge } from '~/components/Placement/QueueCountBadge';
import type { UserMenuItem } from '~/components/AppLayout/AppHeader/hooks';
import type { ResolvedMenuItem } from './resolveUserMenu';
import type { useUserMenuPins } from './useUserMenuPins';
import { Currency } from '~/shared/utils/prisma/enums';

export function MenuItemLabel({ item }: { item: UserMenuItem }) {
  return (
    <span className="flex items-center gap-1">
      <span className="text-sm leading-none">{item.label}</span>
      {item.currency && <CurrencyIcon currency={Currency.BUZZ} size={16} />}
      {(item.isNew || (!!item.newUntil && Date.now() < item.newUntil.getTime())) && (
        <Badge color="green.8" variant="filled" size="sm" ml={4}>
          NEW
        </Badge>
      )}
      <QueueCountBadge count={item.badge ?? 0} max={99} ml={4} />
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

/** Render `region` once in the menu: it is the live region the announcements go to. */
export function usePinActions(pins: ReturnType<typeof useUserMenuPins>) {
  const [message, setMessage] = useState('');
  const announce = useCallback((text: string) => setMessage(text), []);
  const toggle = (item: ResolvedMenuItem) => {
    if (!pins.canEdit) return;
    const wasPinned = pins.pins.includes(item.id);
    pins.toggle(item.id);
    announce(`${wasPinned ? 'Unpinned' : 'Pinned'} ${item.label}`);
  };
  const region = (
    <div aria-live="polite" className="sr-only">
      {message}
    </div>
  );
  return { toggle, announce, region };
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
    window.addEventListener('click', cancel, true);
    return () => window.removeEventListener('click', cancel, true);
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

export const isPinKey = (event: React.KeyboardEvent) =>
  event.key.toLowerCase() === 'p' &&
  !event.altKey &&
  !event.ctrlKey &&
  !event.metaKey &&
  !event.shiftKey;

export const pinMoveDirection = (event: React.KeyboardEvent) =>
  !event.altKey ? 0 : event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
