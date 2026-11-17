import { describe, expect, it } from 'vitest';
import { createTailFollower } from './tail-follow';

// A log box 100px tall at the top of the viewport; each line is 20px, so its bottom is
// scrollTop = scrollHeight - 100. Like a browser's, the follow writes scrollHeight; unlike one, this
// box doesn't clamp it.
function logBox(lineCount: number) {
  let next = 0;
  const lines: {
    id: number;
    isConnected: boolean;
    getBoundingClientRect(): { top: number; bottom: number };
  }[] = [];
  const el = {
    scrollTop: 0,
    clientHeight: 100,
    get scrollHeight() {
      return lines.length * 20;
    },
    children: lines,
    getBoundingClientRect: () => ({ top: 0, bottom: 100 }),
    append() {
      const line = {
        id: next++,
        isConnected: true,
        // A detached element measures as all zeros, as in a browser.
        getBoundingClientRect() {
          if (!line.isConnected) return { top: 0, bottom: 0 };
          const top = lines.indexOf(line) * 20 - el.scrollTop;
          return { top, bottom: top + 20 };
        },
      };
      lines.push(line);
    },
    trimOldest() {
      const [line] = lines.splice(0, 1);
      line.isConnected = false;
    },
    /** The id of the line at the top of the view. */
    topLineId: () => lines[Math.floor(el.scrollTop / 20)]?.id,
  };
  for (let i = 0; i < lineCount; i++) el.append();
  return el;
}

/** One new line arriving, as TrainingTrace runs it: read position, update the DOM, then follow. With
 *  `trim`, the log is at its cap and the oldest line goes as the new one lands. */
const lineArrives = (
  tail: ReturnType<typeof createTailFollower>,
  el: ReturnType<typeof logBox>,
  { trim = false } = {}
) => {
  tail.beforeUpdate(el);
  el.append();
  if (trim) el.trimOldest();
  tail.afterUpdate(el);
};

describe('raw log tail follow', () => {
  it('follows new lines while the reader is at the bottom', () => {
    const tail = createTailFollower();
    const el = logBox(10);
    el.scrollTop = 100;
    lineArrives(tail, el);
    expect(el.scrollTop).toBe(220);
    lineArrives(tail, el);
    expect(el.scrollTop).toBe(240);
  });

  it('starts at the newest line on first render', () => {
    const tail = createTailFollower();
    const el = logBox(10);
    tail.beforeUpdate(undefined); // the element isn't bound yet
    tail.afterUpdate(el);
    expect(el.scrollTop).toBe(200);
  });

  it('stays where the reader scrolled up to as new lines arrive', () => {
    const tail = createTailFollower();
    const el = logBox(10);
    el.scrollTop = 40;
    lineArrives(tail, el);
    lineArrives(tail, el);
    expect(el.scrollTop).toBe(40);
  });

  it('keeps the line being read in place while the oldest lines are trimmed off the top', () => {
    const tail = createTailFollower();
    const el = logBox(20);
    el.scrollTop = 100;
    const reading = el.topLineId();
    lineArrives(tail, el, { trim: true });
    lineArrives(tail, el, { trim: true });
    expect(el.topLineId()).toBe(reading);
    expect(el.scrollTop).toBe(60);
  });

  it('leaves the scroll alone when the line being read is itself trimmed', () => {
    const tail = createTailFollower();
    const el = logBox(20);
    el.scrollTop = 0;
    tail.beforeUpdate(el);
    el.append();
    for (let i = 0; i < 6; i++) el.trimOldest(); // a burst trims every line in view
    tail.afterUpdate(el);
    expect(el.scrollTop).toBe(0);
  });

  it('follows again once the reader scrolls back to the bottom', () => {
    const tail = createTailFollower();
    const el = logBox(10);
    el.scrollTop = 40;
    lineArrives(tail, el);
    el.scrollTop = 120;
    lineArrives(tail, el);
    expect(el.scrollTop).toBe(240);
  });

  it.each([
    [8, 220],
    [9, 91],
  ])('treats %ipx short of the bottom as the bottom only within the slack', (short, expected) => {
    const tail = createTailFollower();
    const el = logBox(10);
    el.scrollTop = 100 - short;
    lineArrives(tail, el);
    expect(el.scrollTop).toBe(expected);
  });
});
