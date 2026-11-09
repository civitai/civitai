/** How close to the bottom (px) still counts as reading the tail: covers sub-pixel scroll positions. */
export const TAIL_SLACK_PX = 8;

type ScrollBox = Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight'>;

export const atBottom = (el: ScrollBox): boolean =>
  el.scrollHeight - el.scrollTop - el.clientHeight <= TAIL_SLACK_PX;

/** Keeps a growing log scrolled to its newest line only while the reader is at the bottom: scrolling
 *  up stops the follow, and scrolling back to the bottom resumes it. */
export function createTailFollower() {
  let pinned = true;
  return {
    onScroll(el: ScrollBox) {
      pinned = atBottom(el);
    },
    follow(el: ScrollBox) {
      if (pinned) el.scrollTop = el.scrollHeight;
    },
  };
}
