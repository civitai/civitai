import { describe, expect, it, vi } from 'vitest';
import { closeUpdates, syncUpdates, unseenNow, type Updates, type UpdatesState } from './updates';

const entry = (id: string) => ({ id, title: 'T.', body: 'B.', link: null });
const updates = (unseen: number): Updates => ({
  entries: [entry('2030-01-02-b'), entry('2030-01-01-a')],
  unseen,
});
const fresh = (): UpdatesState => ({ open: false, seen: null, autoOpened: false });

function deps(stored: Record<string, string> = {}, send = vi.fn(async () => true)) {
  const storage = {
    getItem: (key: string) => stored[key] ?? null,
    setItem: (key: string, value: string) => void (stored[key] = value),
  };
  return {
    stored,
    send,
    refresh: vi.fn(),
    deps: { userId: 7, storage: () => storage, send, refresh: vi.fn() },
  };
}

describe('syncUpdates', () => {
  it('opens unseen entries once, where the page allows it', () => {
    const state = fresh();
    const { deps: d } = deps();
    syncUpdates(state, updates(2), d, false);
    expect(state.open).toBe(false);
    syncUpdates(state, updates(2), d, true);
    expect(state.open).toBe(true);
    state.open = false;
    syncUpdates(state, updates(2), d, true);
    expect(state.open).toBe(false);
  });

  it('does not open with nothing unseen', () => {
    const state = fresh();
    syncUpdates(state, updates(0), deps().deps, true);
    expect(state.open).toBe(false);
  });

  it('sends a dismissal this browser already made instead of showing the entries again', async () => {
    const state = fresh();
    const { deps: d, send } = deps({ 'knights:whats-new-entry:7': '2030-01-02-b' });
    syncUpdates(state, updates(2), d, true);
    expect(state.open).toBe(false);
    expect(unseenNow(updates(2), state)).toBe(0);
    expect(send).toHaveBeenCalledOnce();
  });

  it('shows entries newer than the ones this browser closed', () => {
    const state = fresh();
    const { deps: d } = deps({ 'knights:whats-new-entry:7': '2030-01-01-a' });
    syncUpdates(state, updates(1), d, true);
    expect(state.open).toBe(true);
  });
});

describe('closeUpdates', () => {
  it('clears the dot at once, remembers the newest entry here and records it on the server', async () => {
    const state = { ...fresh(), open: true };
    const { deps: d, stored, send } = deps();
    closeUpdates(state, updates(2), d);
    expect(state.open).toBe(false);
    expect(unseenNow(updates(2), state)).toBe(0);
    expect(stored['knights:whats-new-entry:7']).toBe('2030-01-02-b');
    expect(send).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(d.refresh).toHaveBeenCalledOnce());
  });

  it('records nothing when the dialog was opened from the button with nothing unseen', () => {
    const state = { ...fresh(), open: true };
    const { deps: d, stored, send } = deps();
    closeUpdates(state, updates(0), d);
    expect(state.open).toBe(false);
    expect(stored).toEqual({});
    expect(send).not.toHaveBeenCalled();
  });

  it('still closes when storage and the server both fail', async () => {
    const state = { ...fresh(), open: true };
    const send = vi.fn(async () => {
      throw new Error('down');
    });
    const d = {
      userId: 7,
      storage: () => {
        throw new Error('blocked');
      },
      send,
      refresh: vi.fn(),
    };
    closeUpdates(state, updates(2), d);
    expect(state.open).toBe(false);
    expect(unseenNow(updates(2), state)).toBe(0);
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    expect(d.refresh).not.toHaveBeenCalled();
  });
});
