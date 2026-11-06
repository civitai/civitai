import { useEffect } from 'react';

/**
 * Centres the highlighted comment (the element `comment-<id>`) in the viewport, then centres it
 * again if images, late mounts or paginated batches have moved it out of view.
 */
export function useScrollToHighlightedComment(isHighlighted: boolean, commentId: number) {
  useEffect(() => {
    if (!isHighlighted) return;
    const elem = document.getElementById(`comment-${commentId}`);
    if (!elem) return;
    const center = () => elem.scrollIntoView({ behavior: 'auto', block: 'center' });
    const recenterIfDrifted = () => {
      const rect = elem.getBoundingClientRect();
      if (rect.top < 0 || rect.bottom > window.innerHeight) center();
    };
    center();
    const t1 = window.setTimeout(recenterIfDrifted, 100);
    const t2 = window.setTimeout(recenterIfDrifted, 500);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [isHighlighted, commentId]);
}
