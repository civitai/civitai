import { useCallback, useRef } from 'react';
import { create } from 'zustand';

/**
 * Bars pinned to the bottom of the screen that the floating Remix tray must sit above (the image
 * page's phone action bar). Several can be mounted at once: an image page under the image modal.
 */
export const useRemixTrayClearance = create<{ bars: HTMLElement[] }>(() => ({ bars: [] }));

/** A ref callback that registers its element as a bar while attached. */
export function useRemixTrayClearanceRef() {
  const attached = useRef<HTMLElement | null>(null);
  return useCallback((el: HTMLElement | null) => {
    const prev = attached.current;
    if (prev === el) return;
    attached.current = el;
    useRemixTrayClearance.setState((state) => ({
      bars: [...state.bars.filter((bar) => bar !== prev), ...(el ? [el] : [])],
    }));
  }, []);
}
