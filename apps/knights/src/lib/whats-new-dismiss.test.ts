import { describe, expect, it, vi } from 'vitest';
import {
  closeWhatsNew,
  syncWhatsNew,
  whatsNewShowing,
  type DismissDeps,
  type DismissState,
  type SeenStorage,
} from './whats-new-dismiss';

const fakeStorage = (): SeenStorage & { items: Map<string, string> } => {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
  };
};

const deferred = () => {
  let resolve!: (ok: boolean) => void;
  const promise = new Promise<boolean>((r) => (resolve = r));
  return { promise, resolve };
};

const setup = (overrides: Partial<DismissDeps> = {}) => {
  const storage = fakeStorage();
  const deps: DismissDeps = {
    userId: 2,
    storage: () => storage,
    send: vi.fn(async () => true),
    refresh: vi.fn(),
    ...overrides,
  };
  const state: DismissState = { hidden: false, checked: false };
  return { storage, deps, state };
};

// Lets the background send and its follow-up settle.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("What's new dismissal", () => {
  it('the dialog closes before the action resolves', async () => {
    const answer = deferred();
    const { deps, state } = setup({ send: vi.fn(() => answer.promise) });
    syncWhatsNew(state, true, deps);
    expect(whatsNewShowing(true, state)).toBe(true);

    closeWhatsNew(state, deps);
    expect(whatsNewShowing(true, state)).toBe(false);
    expect(deps.send).toHaveBeenCalledOnce();
    expect(deps.refresh).not.toHaveBeenCalled();

    answer.resolve(true);
    await settle();
    expect(deps.refresh).toHaveBeenCalledOnce();
  });

  it('stays closed and shows nothing when the background send fails', async () => {
    const { deps, state } = setup({
      send: vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))),
    });
    syncWhatsNew(state, true, deps);
    closeWhatsNew(state, deps);
    await settle();
    expect(whatsNewShowing(true, state)).toBe(false);
    expect(deps.refresh).not.toHaveBeenCalled();

    const refused = setup({ send: vi.fn(async () => false) });
    syncWhatsNew(refused.state, true, refused.deps);
    closeWhatsNew(refused.state, refused.deps);
    await settle();
    expect(whatsNewShowing(true, refused.state)).toBe(false);
    expect(refused.deps.refresh).not.toHaveBeenCalled();
  });

  it("it isn't shown again when localStorage says seen", async () => {
    const first = setup({ send: vi.fn(async () => false) });
    syncWhatsNew(first.state, true, first.deps);
    closeWhatsNew(first.state, first.deps);

    // A later load: the server still sends the copy because the send failed.
    const { deps, state } = setup({ storage: () => first.storage });
    syncWhatsNew(state, true, deps);
    expect(whatsNewShowing(true, state)).toBe(false);
  });

  it('the re-send happens', async () => {
    const first = setup({ send: vi.fn(async () => false) });
    syncWhatsNew(first.state, true, first.deps);
    closeWhatsNew(first.state, first.deps);

    const { deps, state } = setup({ storage: () => first.storage });
    syncWhatsNew(state, true, deps);
    expect(deps.send).toHaveBeenCalledOnce();
    await settle();
    expect(deps.refresh).toHaveBeenCalledOnce();
  });

  it('does not send anything for a player who has not seen it', () => {
    const { deps, state } = setup();
    syncWhatsNew(state, true, deps);
    expect(whatsNewShowing(true, state)).toBe(true);
    expect(deps.send).not.toHaveBeenCalled();
  });

  it('keeps the marker per user', () => {
    const first = setup();
    syncWhatsNew(first.state, true, first.deps);
    closeWhatsNew(first.state, first.deps);

    const other = setup({ userId: 3, storage: () => first.storage });
    syncWhatsNew(other.state, true, other.deps);
    expect(whatsNewShowing(true, other.state)).toBe(true);
    expect(other.deps.send).not.toHaveBeenCalled();
  });

  it('falls back to the server state when storage is unavailable', async () => {
    const blocked = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    const { deps, state } = setup({ storage: blocked });
    syncWhatsNew(state, true, deps);
    expect(whatsNewShowing(true, state)).toBe(true);

    closeWhatsNew(state, deps);
    expect(whatsNewShowing(true, state)).toBe(false);
    expect(deps.send).toHaveBeenCalledOnce();

    // Once the server stops sending it, there is nothing to show.
    syncWhatsNew(state, false, deps);
    expect(whatsNewShowing(false, state)).toBe(false);
  });

  it('is not up before the stored marker has been read', () => {
    const { state } = setup();
    expect(whatsNewShowing(true, state)).toBe(false);
  });
});
