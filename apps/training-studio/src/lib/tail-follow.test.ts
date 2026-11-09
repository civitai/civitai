import { describe, expect, it } from 'vitest';
import { createTailFollower } from './tail-follow';

// A log box 100px tall; each line adds 20px.
const logBox = (lines: number) => ({ scrollTop: 0, scrollHeight: lines * 20, clientHeight: 100 });

describe('raw log tail follow', () => {
  it('follows new lines while the reader is at the bottom', () => {
    const tail = createTailFollower();
    const el = logBox(10);
    tail.follow(el);
    expect(el.scrollTop).toBe(200);
    el.scrollHeight += 20;
    tail.follow(el);
    expect(el.scrollTop).toBe(220);
  });

  it('stays where the reader scrolled up to as new lines arrive', () => {
    const tail = createTailFollower();
    const el = logBox(10);
    tail.follow(el);
    el.scrollTop = 40;
    tail.onScroll(el);
    el.scrollHeight += 20;
    tail.follow(el);
    expect(el.scrollTop).toBe(40);
  });

  it('follows again once the reader scrolls back to the bottom, within a few px', () => {
    const tail = createTailFollower();
    const el = logBox(10);
    el.scrollTop = 40;
    tail.onScroll(el);
    el.scrollTop = 196; // 4px short of the bottom
    tail.onScroll(el);
    el.scrollHeight += 20;
    tail.follow(el);
    expect(el.scrollTop).toBe(220);
  });
});
