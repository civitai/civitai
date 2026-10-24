// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  IntersectionObserverProvider,
  useInView,
} from '~/components/IntersectionObserver/IntersectionObserverProvider';

/**
 * `useInView` must keep reporting after the element under its ref is replaced.
 *
 * 🔴 The subscription used to be keyed `[ready, key]`, neither of which moves
 * when React remounts the host node — so a consumer whose element was swapped
 * after mount was never observed again, while the detached node fired one last
 * `isIntersecting: false`. `inView` latched false forever and every card built on
 * `AspectRatioCard` rendered its content as `null`.
 *
 * 🔴 Assert on `inView`, not on which elements reached `observe()`. An earlier
 * version of this file checked only the bookkeeping, and a mutation that
 * re-observed the new node with an empty callback — reproducing the production
 * symptom exactly — passed it. Subscribing is a proxy for the behaviour; the
 * behaviour is that the viewer sees the card.
 */

type Entry = { target: Element; isIntersecting: boolean };
type Recorded = {
  observed: Element[];
  unobserved: Element[];
  fire: ((entries: Entry[]) => void) | null;
};
let recorded: Recorded;
let originalObserver: unknown;

class FakeIntersectionObserver {
  constructor(callback: (entries: Entry[]) => void) {
    recorded.fire = callback;
  }
  observe(element: Element) {
    recorded.observed.push(element);
  }
  unobserve(element: Element) {
    recorded.unobserved.push(element);
  }
  disconnect() {
    recorded.fire = null;
  }
}

/**
 * Renders the ref'd div at two different depths. Changing depth is what makes
 * React discard the node rather than reuse it — the same reconciliation
 * `TwCosmeticWrapper` triggers when a cosmetic arrives after mount.
 */
function Probe({ wrapped, k }: { wrapped: boolean; k?: string }) {
  const [ref, inView] = useInView<HTMLDivElement>({ key: k });
  const target = createElement('div', {
    ref,
    'data-role': 'target',
    'data-inview': String(inView),
  });
  return wrapped ? createElement('span', null, target) : target;
}

const tree = (props: { wrapped: boolean; k?: string } | null) =>
  createElement(IntersectionObserverProvider, null, props ? createElement(Probe, props) : null);

const targetEl = (c: HTMLElement) => c.querySelector('[data-role="target"]') as HTMLElement | null;

describe('useInView, when the observed node is replaced', () => {
  beforeEach(() => {
    recorded = { observed: [], unobserved: [], fire: null };
    originalObserver = (globalThis as Record<string, unknown>).IntersectionObserver;
    (globalThis as Record<string, unknown>).IntersectionObserver = FakeIntersectionObserver;
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).IntersectionObserver = originalObserver;
  });

  it('keeps reporting inView through the swap, and releases the old node', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(tree({ wrapped: false }));
    });
    const first = targetEl(container);
    // Control: if nothing was ever observed the assertions below pass vacuously.
    expect(recorded.observed).toContain(first);

    await act(async () => {
      root.render(tree({ wrapped: true }));
    });
    const second = targetEl(container);
    // If React reused the node there is no swap and this test proves nothing.
    expect(second).not.toBe(first);
    expect(recorded.unobserved).toContain(first);

    // 🔴 The assertion the bug was actually about. Re-observing is not enough:
    // the new node has to be wired to something that sets state.
    await act(async () => {
      recorded.fire?.([{ target: second as Element, isIntersecting: true }]);
    });
    expect(targetEl(container)?.getAttribute('data-inview')).toBe('true');

    // The detached node's last gasp must not reach the live consumer.
    await act(async () => {
      recorded.fire?.([{ target: first as Element, isIntersecting: false }]);
    });
    expect(targetEl(container)?.getAttribute('data-inview')).toBe('true');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('does not resubscribe while the node stays the same', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(tree({ wrapped: false }));
    });
    const settled = recorded.observed.length;
    expect(settled).toBeGreaterThan(0);

    // Re-render twice with an unchanged tree. Without the identity guard the
    // deps-free effect unobserves and re-observes every card on every render.
    await act(async () => {
      root.render(tree({ wrapped: false }));
    });
    await act(async () => {
      root.render(tree({ wrapped: false }));
    });
    expect(recorded.observed).toHaveLength(settled);
    expect(recorded.unobserved).toHaveLength(0);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('resubscribes when the key changes even though the node does not', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(tree({ wrapped: false, k: 'a' }));
    });
    const node = targetEl(container);

    await act(async () => {
      root.render(tree({ wrapped: false, k: 'b' }));
    });
    // Same element, new key. `AdUnitFactory` is the one consumer that passes a
    // key and it relies on this.
    expect(targetEl(container)).toBe(node);
    expect(recorded.unobserved).toContain(node);
    expect(recorded.observed.filter((el) => el === node)).toHaveLength(2);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('releases the node when the consumer unmounts under a living provider', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(tree({ wrapped: false }));
    });
    const node = targetEl(container);

    // 🔴 Unmount the CHILD, not the root. React commits deletions parent-first,
    // so unmounting the root tears the provider down before the consumer, and
    // the consumer's `unobserve` becomes a silent optional-chain no-op against a
    // cleared `observerRef`. Asserting after a root unmount fails on correct
    // code and invites someone to weaken this.
    await act(async () => {
      root.render(tree(null));
    });
    expect(recorded.unobserved).toContain(node);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
