// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';

const act = (React as unknown as { act: typeof actType }).act;

// The hook's observer is a module singleton, so each test gets a fresh module and a fake observer
// it can deliver batches through by hand.
let deliver: (targets: Element[]) => void;
let frames: FrameRequestCallback[];

class FakeResizeObserver {
  constructor(cb: (entries: ResizeObserverEntry[]) => void) {
    deliver = (targets) =>
      cb(targets.map((target) => ({ target } as unknown as ResizeObserverEntry)));
  }
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

function runFrames() {
  const pending = frames;
  frames = [];
  for (const frame of pending) frame(0);
}

async function mountObserved(root: Root, callback: () => void) {
  const { useResizeObserver } = await import('~/hooks/useResizeObserver');
  let node: HTMLElement | null = null;
  function Observed() {
    const ref = useResizeObserver<HTMLDivElement>(callback);
    return React.createElement('div', {
      ref: (el: HTMLDivElement | null) => {
        ref.current = el;
        if (el) node = el;
      },
    });
  }
  await act(async () => root.render(React.createElement(Observed)));
  return node as unknown as HTMLElement;
}

describe('useResizeObserver', () => {
  const roots: Root[] = [];
  const newRoot = () => {
    const root = createRoot(document.body.appendChild(document.createElement('div')));
    roots.push(root);
    return root;
  };

  beforeEach(() => {
    vi.resetModules();
    frames = [];
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames[id - 1] = () => undefined;
    });
  });

  afterEach(async () => {
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });

  it('delivers every element when batches arrive in separate callbacks before the frame', async () => {
    const a = vi.fn();
    const b = vi.fn();
    const nodeA = await mountObserved(newRoot(), a);
    const nodeB = await mountObserved(newRoot(), b);

    deliver([nodeA]);
    deliver([nodeB]);
    runFrames();

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("another consumer unmounting does not drop a pending element's entry", async () => {
    const a = vi.fn();
    const nodeA = await mountObserved(newRoot(), a);
    const otherRoot = newRoot();
    await mountObserved(otherRoot, vi.fn());

    deliver([nodeA]);
    await act(async () => otherRoot.unmount());
    roots.splice(roots.indexOf(otherRoot), 1);
    runFrames();

    expect(a).toHaveBeenCalledTimes(1);
  });
});
