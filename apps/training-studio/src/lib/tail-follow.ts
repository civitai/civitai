/** How close to the bottom (px) still counts as reading the tail: covers sub-pixel scroll positions. */
export const TAIL_SLACK_PX = 8;

type ScrollBox = Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight'>;
type Box = { getBoundingClientRect(): Pick<DOMRect, 'top' | 'bottom'> };
type Line = Box & { readonly isConnected: boolean };
/** The scrolling log element, whose children are its lines. */
export type LogBox = ScrollBox & Box & { readonly children: ArrayLike<Line> };

export const atBottom = (el: ScrollBox): boolean =>
  el.scrollHeight - el.scrollTop - el.clientHeight <= TAIL_SLACK_PX;

/** The last line whose top is inside the view: the one least likely to be trimmed off the top. */
function lastVisibleLine(el: LogBox): Line | undefined {
  const viewBottom = el.getBoundingClientRect().bottom;
  let last: Line | undefined;
  for (let i = 0; i < el.children.length; i++) {
    const line = el.children[i];
    if (line.getBoundingClientRect().top >= viewBottom) break;
    last = line;
  }
  return last;
}

const offsetIn = (el: LogBox, line: Line) =>
  line.getBoundingClientRect().top - el.getBoundingClientRect().top;

/** Keeps a growing log scrolled to its newest line only while the reader is at the bottom. Where the
 *  reader is gets read just before each DOM update (not from scroll events, which land a frame late),
 *  so a scroll up a moment before a line arrives isn't undone.
 *
 *  A reader who has scrolled up keeps the line they're reading where it is, even as the oldest lines
 *  are trimmed off the top, which browser scroll anchoring covers only where it's supported. The log
 *  sets `overflow-anchor: none` so the two don't both adjust. */
export function createTailFollower() {
  let stick = true;
  let anchor: { line: Line; offset: number } | undefined;
  return {
    beforeUpdate(el: LogBox | undefined) {
      stick = !el || atBottom(el);
      const line = el && !stick ? lastVisibleLine(el) : undefined;
      anchor = el && line ? { line, offset: offsetIn(el, line) } : undefined;
    },
    afterUpdate(el: LogBox | undefined) {
      if (!el) return;
      if (stick) el.scrollTop = el.scrollHeight;
      else if (anchor?.line.isConnected) el.scrollTop += offsetIn(el, anchor.line) - anchor.offset;
    },
  };
}
