/** How close to the bottom (px) still counts as reading the tail: covers sub-pixel scroll positions. */
export const TAIL_SLACK_PX = 8;

type ScrollBox = Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight'>;

export const atBottom = (el: ScrollBox): boolean =>
  el.scrollHeight - el.scrollTop - el.clientHeight <= TAIL_SLACK_PX;

/** Keeps a growing log scrolled to its newest line only while the reader is at the bottom. Where the
 *  reader is gets read just before each DOM update (not from scroll events, which land a frame late),
 *  so a scroll up a moment before a line arrives isn't undone. */
export function createTailFollower() {
  let stick = true;
  return {
    beforeUpdate(el: ScrollBox | undefined) {
      stick = !el || atBottom(el);
    },
    afterUpdate(el: ScrollBox | undefined) {
      if (el && stick) el.scrollTop = el.scrollHeight;
    },
  };
}
