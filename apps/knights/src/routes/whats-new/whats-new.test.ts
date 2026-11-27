import { beforeEach, describe, expect, it, vi } from 'vitest';
import { memorySeenStore, type SeenStore } from '$lib/server/seen';
import { LATEST_UPDATE_ID } from '$lib/server/whats-new/entries';

const runtime = vi.hoisted(() => ({ store: undefined as unknown as SeenStore }));
vi.mock('$lib/server/seen-runtime', () => ({
  get seenStore() {
    return runtime.store;
  },
}));

const { POST } = await import('./+server');
const post = () => POST({ locals: { user: { id: 7 } } } as never);

beforeEach(() => {
  runtime.store = memorySeenStore();
});

describe('POST /whats-new', () => {
  it("records every entry so far as seen on the signed-in player's record", async () => {
    await runtime.store.set(7, {
      rank: 'Knight',
      level: 2,
      guide: true,
      whatsNew: true,
      consent: true,
    });
    const response = await post();
    expect(response.status).toBe(200);
    expect((await runtime.store.get(7))?.updatesSeen).toBe(LATEST_UPDATE_ID);
  });

  it('answers 500 when the store is down', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    runtime.store = {
      get: async () => {
        throw new Error('down');
      },
      set: async () => undefined,
    };
    expect((await post()).status).toBe(500);
  });
});
