import { create } from 'zustand';

export type ReviewFocusTarget = { imageId: number; modelVersionId: number };

/** The last resource the progress card asked to bring into view; image cards read it to expand. */
export const useReviewFocusStore = create<{ target: ReviewFocusTarget | null }>(() => ({
  target: null,
}));

/** Scrolls to an image card, expanding its resource list first when the resource is collapsed. */
export function focusReviewTarget(target: ReviewFocusTarget) {
  useReviewFocusStore.setState({ target });
  requestAnimationFrame(() => {
    const element = document.querySelector<HTMLElement>(`[data-image-id="${target.imageId}"]`);
    if (!element) return;
    element.scrollIntoView({ block: 'start', behavior: 'smooth' });
    element.animate?.(
      [
        { boxShadow: '0 0 0 3px var(--mantine-color-blue-5)' },
        { boxShadow: '0 0 0 3px transparent' },
      ],
      { duration: 1200, easing: 'ease-out' }
    );
  });
}
