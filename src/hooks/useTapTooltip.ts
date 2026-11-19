import type { PointerEvent as ReactPointerEvent } from 'react';
import { useEffect, useRef, useState } from 'react';

/**
 * A controlled tooltip that opens on mouse hover and on tap, for a `Tooltip` with `opened`.
 * Mantine's `events.touch` isn't enough: touch emits a mouseleave right after the tap, closing it.
 * A tap toggles it and a press anywhere else closes it; a mouse click keeps it open.
 */
export function useTapTooltip<T extends HTMLElement>() {
  const [opened, setOpened] = useState(false);
  const ref = useRef<T>(null);
  const pointerType = useRef<string>();

  useEffect(() => {
    if (!opened) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpened(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [opened]);

  return {
    opened,
    ref,
    triggerProps: {
      onPointerDown: (e: ReactPointerEvent) => {
        pointerType.current = e.pointerType;
      },
      onPointerEnter: (e: ReactPointerEvent) => e.pointerType === 'mouse' && setOpened(true),
      onPointerLeave: (e: ReactPointerEvent) => e.pointerType === 'mouse' && setOpened(false),
      onClick: () => setOpened((o) => (pointerType.current === 'mouse' ? true : !o)),
    },
  };
}
