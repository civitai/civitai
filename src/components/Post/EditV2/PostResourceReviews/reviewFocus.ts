import { create } from 'zustand';

export type ReviewFocusTarget = { imageId: number; modelVersionId: number };

/** The last resource the progress card asked to bring into view; image cards read it to expand. */
export const useReviewFocusStore = create<{ target: ReviewFocusTarget | null }>(() => ({
  target: null,
}));

const SCROLL_GAP = 8;

/**
 * The page scrolls an inner `.scroll-area`, and its sticky sub-nav sits inside that area, so
 * neither `scroll-margin-top` nor `--header-height` matches the real offset. The sub-nav is
 * measured at click time because an announcement banner changes its height.
 */
function scrollBelowStickyHeader(element: HTMLElement) {
  const container = element.closest<HTMLElement>('.scroll-area');
  if (!container) return element.scrollIntoView({ block: 'start', behavior: 'smooth' });
  const stickyHeight = container.querySelector<HTMLElement>('[data-subnav]')?.offsetHeight ?? 0;
  const top =
    element.getBoundingClientRect().top -
    container.getBoundingClientRect().top +
    container.scrollTop -
    stickyHeight -
    SCROLL_GAP;
  container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

/** Scrolls to an image card, expanding its resource list first when the resource is collapsed. */
export function focusReviewTarget(target: ReviewFocusTarget) {
  useReviewFocusStore.setState({ target });
  requestAnimationFrame(() => {
    const element = document.querySelector<HTMLElement>(`[data-image-id="${target.imageId}"]`);
    if (!element) return;
    scrollBelowStickyHeader(element);
    element.animate?.(
      [
        { boxShadow: '0 0 0 3px var(--mantine-color-blue-5)' },
        { boxShadow: '0 0 0 3px transparent' },
      ],
      { duration: 1200, easing: 'ease-out' }
    );
  });
}
