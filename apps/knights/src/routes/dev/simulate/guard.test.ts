import { beforeEach, describe, expect, it, vi } from 'vitest';

const isDev = vi.hoisted(() => ({ value: false }));
const simulateOtherVoters = vi.hoisted(() => vi.fn());
const listSimulatableItems = vi.hoisted(() => vi.fn());
vi.mock('$app/environment', () => ({
  get dev() {
    return isDev.value;
  },
}));
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/image-url', () => ({ imageUrl: (key: string) => key }));
vi.mock('$lib/server/queue/runtime', () => ({ queueDeps: {} }));
vi.mock('$lib/server/dev/simulate', () => ({ simulateOtherVoters, listSimulatableItems }));

const { load, actions } = await import('./+page.server');

const submit = () => {
  const body = new FormData();
  body.set('itemId', '3');
  body.set('answer', '4');
  return actions.simulate({
    request: new Request('http://knights.test/dev/simulate', { method: 'POST', body }),
    locals: { user: { id: 7 } },
  } as never);
};
const loadPage = () => load({ locals: { user: { id: 7 } } } as never);

beforeEach(() => {
  simulateOtherVoters.mockReset();
  listSimulatableItems.mockReset();
  listSimulatableItems.mockResolvedValue([]);
});

describe('simulate other voters', () => {
  describe('outside dev', () => {
    beforeEach(() => {
      isDev.value = false;
    });

    it('404s the page', async () => {
      await expect(loadPage()).rejects.toMatchObject({ status: 404 });
      expect(listSimulatableItems).not.toHaveBeenCalled();
    });

    it('404s the action and casts nothing', async () => {
      await expect(submit()).rejects.toMatchObject({ status: 404 });
      expect(simulateOtherVoters).not.toHaveBeenCalled();
    });
  });

  describe('in dev', () => {
    beforeEach(() => {
      isDev.value = true;
    });

    it('serves the page and runs the simulation for the caller', async () => {
      simulateOtherVoters.mockResolvedValue({ cast: 5, itemStatus: 'Resolved' });

      await expect(loadPage()).resolves.toMatchObject({ items: [] });
      await expect(submit()).resolves.toMatchObject({ success: true });
      expect(simulateOtherVoters).toHaveBeenCalledWith(
        expect.anything(),
        { callerId: 7, itemId: 3, answer: '4' },
        expect.anything()
      );
    });
  });
});
