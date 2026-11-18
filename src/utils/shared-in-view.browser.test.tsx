import { describe, expect, test } from 'vitest';
import { observeInView } from '~/utils/shared-in-view';

const frames = async (n: number) => {
  for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r));
};

function box() {
  const el = document.createElement('div');
  el.style.cssText = 'width:20px;height:20px;position:fixed;top:0;left:0';
  document.body.appendChild(el);
  return el;
}

describe('observeInView', () => {
  test('reports each change of visibility, to the listener of that element', async () => {
    const a = box();
    const b = box();
    const seenA: boolean[] = [];
    const seenB: boolean[] = [];
    const stopA = observeInView(a, (v) => seenA.push(v));
    const stopB = observeInView(b, (v) => seenB.push(v));
    await expect.poll(() => seenA.at(-1)).toBe(true);
    a.style.top = '-5000px';
    await expect.poll(() => seenA.at(-1)).toBe(false);
    expect(seenB.at(-1)).toBe(true);
    stopA();
    stopB();
    a.remove();
    b.remove();
  });

  test('an unobserved element is never reported again', async () => {
    const el = box();
    const seen: boolean[] = [];
    const stop = observeInView(el, (v) => seen.push(v));
    await expect.poll(() => seen.length).toBe(1);
    stop();
    el.style.top = '-5000px';
    await frames(10);
    expect(seen).toEqual([true]);
    el.remove();
  });
});
