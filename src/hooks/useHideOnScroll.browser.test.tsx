import { useRef } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../test/component-setup';
import { useHideOnScroll } from '~/hooks/useHideOnScroll';

function WindowHeader() {
  const hidden = useHideOnScroll('window');
  return (
    <>
      <p>{hidden ? 'hidden' : 'shown'}</p>
      <div style={{ height: 5000 }} />
    </>
  );
}

function PaneHeader() {
  const ref = useRef<HTMLDivElement>(null);
  const hidden = useHideOnScroll(ref);
  return (
    <div ref={ref}>
      <p>{hidden ? 'hidden' : 'shown'}</p>
      <div data-testid="chips" style={{ width: 200, overflowX: 'auto', whiteSpace: 'nowrap' }}>
        <div style={{ width: 2000, height: 20 }} />
      </div>
      <div data-testid="list" style={{ height: 300, overflowY: 'auto' }}>
        <div style={{ height: 5000 }} />
      </div>
    </div>
  );
}

const scroll = (el: HTMLElement | Window, y: number, x = 0) => {
  if (el === window) window.scrollTo(0, y);
  else {
    (el as HTMLElement).scrollTop = y;
    (el as HTMLElement).scrollLeft = x;
  }
  el.dispatchEvent(new Event('scroll'));
};

afterEach(() => window.scrollTo(0, 0));

describe('useHideOnScroll', () => {
  test('hides after scrolling down past the distance, returns after scrolling back up as far', async () => {
    renderWithProviders(<WindowHeader />);
    await expect.element(page.getByText('shown')).toBeInTheDocument();

    scroll(window, 400);
    await expect.element(page.getByText('hidden')).toBeInTheDocument();
    // Back up less than the distance: still out of the way.
    scroll(window, 330);
    await expect.element(page.getByText('hidden')).toBeInTheDocument();
    scroll(window, 250);
    await expect.element(page.getByText('shown')).toBeInTheDocument();
    // Near the top it always shows.
    scroll(window, 600);
    await expect.element(page.getByText('hidden')).toBeInTheDocument();
    scroll(window, 40);
    await expect.element(page.getByText('shown')).toBeInTheDocument();
  });

  test('inside an element, a sideways scroll (a row of chips) does not bring it back', async () => {
    renderWithProviders(<PaneHeader />);
    await expect.element(page.getByText('shown')).toBeInTheDocument();
    const list = page.getByTestId('list').element() as HTMLElement;
    const chips = page.getByTestId('chips').element() as HTMLElement;

    scroll(list, 400);
    await expect.element(page.getByText('hidden')).toBeInTheDocument();
    scroll(chips, 0, 300);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect.element(page.getByText('hidden')).toBeInTheDocument();
  });
});
