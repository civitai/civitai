import React, { Component, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { ScrollAreaContext } from '~/components/ScrollArea/ScrollAreaContext';
import { useScrollMargin } from '~/hooks/useScrollMargin';
import { renderWithProviders } from '../../test/component-setup';

// `useScrollMargin` — the offset a virtualizer maps `scrollTop` through.
//
// The offset changes without the list itself changing: a description above it expands, an
// ad loads, a panel opens. Measuring once on mount is what blanked the model-page gallery
// (CU 868kgxjv7) — the virtualizer kept windowing against the pre-expansion offset and
// unmounted rows that were on screen.
//
// The hook re-measures on every commit, so the tests that assert it STOPS (no scroll
// container, element never attached) matter as much as the ones that assert it measures.
//
// Browser mode because every assertion is real layout: `offsetTop` chains, `offsetParent`
// resolution and `ResizeObserver` delivery.

const SPACER = 'spacer';
const TARGET = 'target';

function Target() {
  const ref = useRef<HTMLDivElement>(null);
  const scrollMargin = useScrollMargin(ref);

  return <div ref={ref} data-testid={TARGET} data-margin={scrollMargin} style={{ height: 400 }} />;
}

/** A scroll container with resizable content above the measured element. */
function Harness({
  spacerHeight = 300,
  withTarget = true,
  nested = false,
}: {
  spacerHeight?: number;
  withTarget?: boolean;
  /** Wrap the target so the offset has to be summed across an ancestor chain. */
  nested?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const content = (
    <>
      <div data-testid={SPACER} style={{ height: spacerHeight }} />
      {withTarget ? <Target /> : null}
      <div style={{ height: 2000 }} />
    </>
  );

  return (
    <ScrollAreaContext.Provider value={{ ref: scrollRef as React.RefObject<HTMLDivElement> }}>
      <div
        ref={scrollRef}
        data-testid="scroll-area"
        style={{ height: 200, overflowY: 'auto', position: 'relative' }}
      >
        {nested ? <div style={{ paddingTop: 50 }}>{content}</div> : content}
      </div>
    </ScrollAreaContext.Provider>
  );
}

const margin = () =>
  Number(document.querySelector(`[data-testid="${TARGET}"]`)?.getAttribute('data-margin'));

let renders = 0;

/** Counts its own renders; `attach` false leaves the measured ref empty forever. */
function CountingTarget({ attach }: { attach: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useScrollMargin(ref);
  renders++;

  return <div ref={attach ? ref : undefined} data-testid={TARGET} style={{ height: 400 }} />;
}

/** ~18 frames — long enough for a per-frame retry loop to be obvious. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

/** Resize outside React so only the ResizeObserver can notice. */
function setSpacerHeight(height: number) {
  const spacer = document.querySelector(`[data-testid="${SPACER}"]`) as HTMLElement;
  spacer.style.height = `${height}px`;
}

describe('useScrollMargin', () => {
  test('measures the offset from the scroll container on mount', async () => {
    renderWithProviders(<Harness spacerHeight={300} />);

    await vi.waitFor(() => expect(margin()).toBe(300));
  });

  test('sums the offset across the ancestor chain', async () => {
    renderWithProviders(<Harness spacerHeight={300} nested />);

    await vi.waitFor(() => expect(margin()).toBe(350));
  });

  test('re-measures when content above it grows without a re-render', async () => {
    renderWithProviders(<Harness spacerHeight={300} />);
    await vi.waitFor(() => expect(margin()).toBe(300));

    setSpacerHeight(2000);

    await vi.waitFor(() => expect(margin()).toBe(2000));
  });

  test('re-measures when the growth is nested below the scroll container', async () => {
    // The app's case: the description that expands is buried several levels under the
    // scroll container, so only the child it grows is observable.
    renderWithProviders(<Harness spacerHeight={300} nested />);
    await vi.waitFor(() => expect(margin()).toBe(350));

    setSpacerHeight(2000);

    await vi.waitFor(() => expect(margin()).toBe(2050));
  });

  test('re-measures when content above it shrinks back', async () => {
    renderWithProviders(<Harness spacerHeight={2000} />);
    await vi.waitFor(() => expect(margin()).toBe(2000));

    setSpacerHeight(300);

    await vi.waitFor(() => expect(margin()).toBe(300));
  });

  test('measures an element that mounts after the hook', async () => {
    // Lists commonly render behind a loading state, so the ref is empty on the
    // hook's first commit. A mount-only effect would leave the margin at 0 forever.
    function LateMount() {
      const [ready, setReady] = useState(false);
      return (
        <>
          <button onClick={() => setReady(true)}>load</button>
          <Harness spacerHeight={300} withTarget={ready} />
        </>
      );
    }

    renderWithProviders(<LateMount />);
    expect(document.querySelector(`[data-testid="${TARGET}"]`)).toBeNull();

    await userEvent.click(page.getByRole('button', { name: 'load' }));

    await vi.waitFor(() => expect(margin()).toBe(300));
  });

  test('settles when the measured element never attaches', async () => {
    // `MasonryGridVirtual`'s empty state and `downloads.tsx`'s "no results" both call the
    // hook while never rendering the ref, so re-measuring per commit must not self-feed.
    renders = 0;
    renderWithProviders(
      <ScrollAreaContext.Provider
        value={{ ref: { current: document.body as unknown as HTMLDivElement } }}
      >
        <CountingTarget attach={false} />
      </ScrollAreaContext.Provider>
    );

    await settle();

    expect(renders).toBeLessThan(5);
  });

  test('settles when there is no scroll container in the tree', async () => {
    renders = 0;
    renderWithProviders(<CountingTarget attach />);

    await settle();

    expect(renders).toBeLessThan(6);
  });

  describe('when the layout reacts to the margin the hook publishes', () => {
    // The margin is fed to `useVirtualizer`, which decides what renders inside the scroll
    // container. If any of that lands above the measured element — directly, or through a
    // container the virtualizer sizes — measuring on every commit re-measures a position
    // that the last measurement moved, and there is no offset that holds still.
    //
    // Re-measuring per commit with no bound turns that into an unbroken chain of
    // synchronous re-renders: React counts 50 nested updates and throws "Maximum update
    // depth exceeded", which is not recoverable — the nearest error boundary replaces the
    // page. So the hook has to give up on a moving target rather than chase it.

    /** Offset flips between two values, so no published margin is ever the measured one. */
    function TwoCycle({ onRender }: { onRender?: () => void }) {
      const ref = useRef<HTMLDivElement>(null);
      const scrollMargin = useScrollMargin(ref);
      onRender?.();

      return (
        <>
          <div data-testid="feedback-spacer" style={{ height: scrollMargin > 200 ? 100 : 400 }} />
          <div ref={ref} data-testid={TARGET} data-margin={scrollMargin} style={{ height: 100 }} />
        </>
      );
    }

    function CoupledHarness({ children }: { children: ReactNode }) {
      const scrollRef = useRef<HTMLDivElement>(null);

      return (
        <ScrollAreaContext.Provider value={{ ref: scrollRef as React.RefObject<HTMLDivElement> }}>
          <div
            ref={scrollRef}
            data-testid="scroll-area"
            style={{ height: 200, overflowY: 'auto', position: 'relative' }}
          >
            {children}
          </div>
        </ScrollAreaContext.Provider>
      );
    }

    class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
      state = { error: null as Error | null };
      static getDerivedStateFromError(error: Error) {
        return { error };
      }
      render() {
        return this.state.error ? (
          <div data-testid="crashed">{this.state.error.message}</div>
        ) : (
          this.props.children
        );
      }
    }

    const crashed = () => document.querySelector('[data-testid="crashed"]')?.textContent ?? null;

    test('gives up instead of exceeding the update depth', async () => {
      renderWithProviders(
        <Boundary>
          <CoupledHarness>
            <TwoCycle />
          </CoupledHarness>
        </Boundary>
      );

      await settle();

      expect(crashed()).toBeNull();
    });

    test('stops re-rendering once it has given up', async () => {
      let renderCount = 0;
      renderWithProviders(
        <Boundary>
          <CoupledHarness>
            <TwoCycle onRender={() => renderCount++} />
          </CoupledHarness>
        </Boundary>
      );

      await settle();
      const afterSettle = renderCount;
      await settle();

      expect(crashed()).toBeNull();
      expect(renderCount).toBe(afterSettle);
    });

    test('a real resize above it still re-measures after it has given up', async () => {
      // Giving up must not deafen the hook to the case #3426 exists for: the budget is
      // spent on chasing our own output, and a resize above the list is not that.
      function Coupled() {
        const ref = useRef<HTMLDivElement>(null);
        const scrollMargin = useScrollMargin(ref);

        return (
          <>
            <div data-testid={SPACER} style={{ height: 0 }} />
            <div
              data-testid="feedback-spacer"
              style={{ height: scrollMargin % 2 === 0 ? 401 : 100 }}
            />
            <div
              ref={ref}
              data-testid={TARGET}
              data-margin={scrollMargin}
              style={{ height: 100 }}
            />
          </>
        );
      }

      renderWithProviders(
        <Boundary>
          <CoupledHarness>
            <Coupled />
          </CoupledHarness>
        </Boundary>
      );
      await settle();
      expect(crashed()).toBeNull();
      const givenUpAt = margin();

      setSpacerHeight(1000);

      await vi.waitFor(() => expect(margin()).not.toBe(givenUpAt));
      expect(crashed()).toBeNull();
    });
  });
});
