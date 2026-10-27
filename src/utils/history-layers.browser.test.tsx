import { StrictMode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../test/component-setup';
import { useHistoryLayer } from '~/hooks/useHistoryLayer';
import {
  closeHistoryLayer,
  countHistoryLayers,
  forgetHistoryLayers,
  handleHistoryPop,
  historyLayerDepth,
  historyLayersSettled,
  openHistoryLayer,
  resetHistoryLayers,
} from '~/utils/history-layers';

// Real browser history: every back() here is a real traversal that fires popstate.
const popped = () =>
  new Promise<void>((resolve) =>
    addEventListener('popstate', () => setTimeout(resolve), { once: true })
  );
const back = async (steps = 1) => {
  const done = popped();
  history.go(-steps);
  await done;
};
// Next's listener runs before ours and hands beforePopState the event's own state object.
const asNext = () => {
  const seen: { state?: unknown; handled?: boolean } = {};
  addEventListener(
    'popstate',
    (e) => {
      seen.state = e.state;
      seen.handled = handleHistoryPop(e.state);
    },
    { once: true, capture: true }
  );
  return seen;
};

let pageEntry = 0;
beforeEach(() => {
  // The page's own entry under each test's layers: a real state with no layer on it.
  history.pushState({ page: ++pageEntry }, '');
});
afterEach(async () => {
  await historyLayersSettled();
  resetHistoryLayers();
});

describe('history layers', () => {
  test('Back closes the top layer and stays on the page', async () => {
    const lower = vi.fn();
    const upper = vi.fn();
    const length = history.length;
    openHistoryLayer(lower);
    openHistoryLayer(upper);
    expect(history.length).toBe(length + 2);

    await back();
    expect(upper).toHaveBeenCalledOnce();
    expect(lower).not.toHaveBeenCalled();
    expect(countHistoryLayers()).toBe(1);

    const next = asNext();
    await back();
    expect(lower).toHaveBeenCalledOnce();
    expect(countHistoryLayers()).toBe(0);
    // Back onto the page's own entry was still a layer's pop: the page must not navigate.
    expect(next.handled).toBe(true);
  });

  test('Forward onto a layer Back closed leaves it closed and the one below open', async () => {
    const lower = vi.fn();
    const upper = vi.fn();
    openHistoryLayer(lower);
    openHistoryLayer(upper);
    await back();
    const done = popped();
    history.forward();
    await done;

    expect(upper).toHaveBeenCalledOnce();
    expect(lower).not.toHaveBeenCalled();
    expect(countHistoryLayers()).toBe(1);
  });

  test('closing a layer from the UI goes back over its entry without calling its close', async () => {
    const close = vi.fn();
    const id = openHistoryLayer(close);
    const next = asNext();
    const done = popped();
    closeHistoryLayer(id);
    await done;

    // That pop is ours: Next must be told not to navigate.
    expect(next.handled).toBe(true);
    expect(close).not.toHaveBeenCalled();
    expect(countHistoryLayers()).toBe(0);
    expect(history.state).toEqual({ page: pageEntry });
  });

  test('closing a lower layer from the UI closes the ones above it', async () => {
    const lower = vi.fn();
    const upper = vi.fn();
    const id = openHistoryLayer(lower);
    openHistoryLayer(upper);
    const done = popped();
    closeHistoryLayer(id);
    await done;

    expect(upper).toHaveBeenCalledOnce();
    expect(lower).not.toHaveBeenCalled();
    expect(history.state).toEqual({ page: pageEntry });
  });

  test("Next's beforePopState and the window listener get one answer for the same pop", async () => {
    const close = vi.fn();
    openHistoryLayer(close);
    const next = asNext();
    await back();

    expect(next.handled).toBe(true);
    // The window listener, asked about the same pop after Next, gets the same answer.
    expect(handleHistoryPop(next.state)).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  test("a pop to another page is a navigation: it is not the layers' to handle", async () => {
    const close = vi.fn();
    openHistoryLayer(close);
    // The URL has already changed by the time a pop to another page is handled.
    const here = location.href;
    history.replaceState(history.state, '', '/somewhere-else');
    const handled = handleHistoryPop({ as: '/somewhere-else' });
    history.replaceState(history.state, '', here);
    expect(handled).toBe(false);
    expect(close).not.toHaveBeenCalled();
    expect(countHistoryLayers()).toBe(0);
  });

  test("Safari's null state still closes the top layer", () => {
    const lower = vi.fn();
    const upper = vi.fn();
    openHistoryLayer(lower);
    openHistoryLayer(upper);
    expect(handleHistoryPop(null)).toBe(true);
    expect(upper).toHaveBeenCalledOnce();
    expect(lower).not.toHaveBeenCalled();
  });

  test('every layer entry knows how many sit above the page, ones left behind included', async () => {
    openHistoryLayer(vi.fn());
    // A navigation leaves that entry behind; a layer opened over it still counts it.
    forgetHistoryLayers(); // what routeChangeStart does
    openHistoryLayer(vi.fn());
    expect(historyLayerDepth()).toBe(2);
  });

  test('Back onto an entry left behind by a gone layer steps past it to the page', async () => {
    openHistoryLayer(vi.fn());
    forgetHistoryLayers(); // what routeChangeStart does
    const close = vi.fn();
    openHistoryLayer(close);

    await back();
    expect(close).toHaveBeenCalledOnce();
    await historyLayersSettled();
    expect(history.state).toEqual({ page: pageEntry });
  });
});

describe('useHistoryLayer', () => {
  function Layer() {
    const [opened, setOpened] = useState(true);
    useHistoryLayer(opened, () => setOpened(false));
    return opened ? <p>Open layer</p> : <p>Closed layer</p>;
  }

  test('strict mode mounts it twice but it takes one entry', async () => {
    const length = history.length;
    renderWithProviders(
      <StrictMode>
        <Layer />
      </StrictMode>
    );
    await expect.element(page.getByText('Open layer')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(history.length).toBe(length + 1);
    expect(countHistoryLayers()).toBe(1);

    await back();
    await expect.element(page.getByText('Closed layer')).toBeInTheDocument();
  });

  test('unmounting an open layer goes back over its entry', async () => {
    function Host() {
      const [shown, setShown] = useState(true);
      return (
        <>
          {shown && <Layer />}
          <button onClick={() => setShown(false)}>Remove</button>
        </>
      );
    }
    renderWithProviders(<Host />);
    await expect.element(page.getByText('Open layer')).toBeInTheDocument();
    await page.getByRole('button', { name: 'Remove' }).click();
    await historyLayersSettled();
    expect(history.state).toEqual({ page: pageEntry });
  });
});
