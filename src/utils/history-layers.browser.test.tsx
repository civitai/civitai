import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  closeHistoryLayer,
  countHistoryLayers,
  handleHistoryPop,
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

afterEach(() => {
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

    await back();
    expect(lower).toHaveBeenCalledOnce();
    expect(countHistoryLayers()).toBe(0);
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
    // That pop is ours: Next must be told not to navigate.
    let fromNext: boolean | undefined;
    addEventListener('popstate', (e) => (fromNext = handleHistoryPop(e.state)), {
      once: true,
      capture: true,
    });
    const done = popped();
    closeHistoryLayer(id);
    await done;

    expect(fromNext).toBe(true);
    expect(close).not.toHaveBeenCalled();
    expect(countHistoryLayers()).toBe(0);
    // The next Back is the page's again, not a layer's.
    expect(handleHistoryPop({})).toBe(false);
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
    expect(countHistoryLayers()).toBe(0);
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

  test("Next's beforePopState and the window listener get one answer for the same pop", async () => {
    const close = vi.fn();
    openHistoryLayer(close);
    let fromNext: boolean | undefined;
    // Next's listener runs before ours and hands the same state object to beforePopState.
    const asNext = (e: PopStateEvent) => (fromNext = handleHistoryPop(e.state));
    addEventListener('popstate', asNext, { once: true, capture: true });
    await back();

    expect(fromNext).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });
});
