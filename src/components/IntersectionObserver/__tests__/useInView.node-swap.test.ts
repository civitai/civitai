// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  IntersectionObserverProvider,
  useInView,
} from '~/components/IntersectionObserver/IntersectionObserverProvider';

/**
 * `useInView` must re-observe when the element under its ref is replaced.
 *
 * 🔴 This is not hypothetical tidiness. The subscription used to be keyed
 * `[ready, key]`, neither of which moves when React remounts the host node — so
 * a consumer whose element is swapped after mount was never observed again,
 * while the detached old node fired one last callback with
 * `isIntersecting: false`. `inView` latched false permanently and every card
 * built on `AspectRatioCard` rendered its content as `null` forever.
 *
 * It shipped invisibly because the only elements that ever got swapped were ones
 * given a cosmetic asynchronously — `TwCosmeticWrapper` returns children bare
 * with no cosmetic and wraps them in a div with one, which changes the subtree's
 * depth. Every cosmetic before that was present on the first render. The card
 * browser tests could not catch it either: they stub `useElementInView` to
 * return `true`.
 */

type Recorded = { observed: Element[]; unobserved: Element[] };
let recorded: Recorded;

class FakeIntersectionObserver {
  constructor(_callback: IntersectionObserverCallback) {}
  observe(element: Element) {
    recorded.observed.push(element);
  }
  unobserve(element: Element) {
    recorded.unobserved.push(element);
  }
  disconnect() {}
}

/**
 * Renders the ref'd div at two different depths. Changing depth is what makes
 * React discard the DOM node rather than reuse it — the same reconciliation the
 * cosmetic wrapper triggers in production.
 */
function Probe({ wrapped }: { wrapped: boolean }) {
  const [ref] = useInView<HTMLDivElement>();
  const target = createElement('div', { ref, 'data-role': 'target' });
  return wrapped ? createElement('span', null, target) : target;
}

function renderProbe(container: HTMLElement, wrapped: boolean) {
  return createElement(IntersectionObserverProvider, null, createElement(Probe, { wrapped }));
}

describe('useInView, when the observed node is replaced', () => {
  beforeEach(() => {
    recorded = { observed: [], unobserved: [] };
    (globalThis as any).IntersectionObserver = FakeIntersectionObserver;
  });

  it('observes the new node and releases the old one', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(renderProbe(container, false));
    });

    const first = container.querySelector('[data-role="target"]');
    expect(first).toBeTruthy();
    // Control: without this the assertions below pass vacuously on an empty list.
    expect(recorded.observed).toContain(first);

    await act(async () => {
      root.render(renderProbe(container, true));
    });

    const second = container.querySelector('[data-role="target"]');
    // The reconciliation this test exists for. If React reused the node there is
    // nothing to re-observe and the test is not exercising the bug.
    expect(second).not.toBe(first);

    expect(recorded.observed).toContain(second);
    expect(recorded.unobserved).toContain(first);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
