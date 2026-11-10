import { describe, expect, it } from 'vitest';
import { createTailFollower } from './tail-follow';

// A log box 100px tall; each line adds 20px. Its bottom is scrollTop = scrollHeight - 100. Like a
// browser's, the follow writes scrollHeight; unlike one, this box doesn't clamp it.
const logBox = (lines: number) => ({ scrollTop: 0, scrollHeight: lines * 20, clientHeight: 100 });

/** One new line arriving, as TrainingTrace runs it: read position, update the DOM, then follow. */
const lineArrives = (
  tail: ReturnType<typeof createTailFollower>,
  el: ReturnType<typeof logBox>
) => {
  tail.beforeUpdate(el);
  el.scrollHeight += 20;
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
