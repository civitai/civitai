import { useEffect, useState } from 'react';
import { useResizeStore } from '~/components/Resizable/useResize';

export const GENERATION_SIDEBAR_NAME = 'generation-sidebar';
export const GENERATION_SIDEBAR_DEFAULT_WIDTH = 400;
const MIN_PAGE_WIDTH = 320;

/**
 * Whether the generator is too wide to sit beside the page and has to take the whole
 * viewport. `undefined` until the viewport is measured on the client.
 */
export function useGenerationPanelFullScreen() {
  const [fullScreen, setFullScreen] = useState<boolean>();

  // Read the widths in listeners, never in render: both change every frame while a
  // window or the sidebar is dragged, and each render here re-renders the generator.
  useEffect(() => {
    const update = () => {
      const sidebarWidth =
        useResizeStore.getState()[GENERATION_SIDEBAR_NAME] ?? GENERATION_SIDEBAR_DEFAULT_WIDTH;
      setFullScreen(sidebarWidth + MIN_PAGE_WIDTH > window.innerWidth);
    };
    update();
    window.addEventListener('resize', update);
    const unsubscribe = useResizeStore.subscribe(update);
    return () => {
      window.removeEventListener('resize', update);
      unsubscribe();
    };
  }, []);

  return fullScreen;
}
