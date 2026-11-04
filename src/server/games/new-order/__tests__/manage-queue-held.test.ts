import { describe, it, expect, vi, beforeEach } from 'vitest';

// The mod queue-insert endpoint says why images it was given were not inserted.

const { mockAddImageToQueue } = vi.hoisted(() => ({ mockAddImageToQueue: vi.fn() }));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => handler,
}));
vi.mock('~/server/services/games/new-order.service', () => ({
  addImageToQueue: mockAddImageToQueue,
}));
vi.mock('~/server/games/new-order/utils', () => ({ poolCounters: {}, getActiveSlot: vi.fn() }));

import handler from '~/pages/api/mod/new-order/manage-queue';

async function insert(imageIds: string) {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  await (handler as any)(
    { query: { action: 'insert-in-queue', imageIds, rankType: 'Knight' } },
    res
  );
  return { status: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0] };
}

beforeEach(() => vi.clearAllMocks());

describe('manage-queue insert-in-queue', () => {
  it('(d) says nothing was inserted because the images are held for review', async () => {
    mockAddImageToQueue.mockResolvedValue({ added: false, heldIds: [2] });

    expect(await insert('2')).toEqual({
      status: 200,
      body: { message: 'Not inserted: held for review', heldImageIds: [2] },
    });
  });

  it('(d) a mixed insert succeeds and lists the held images it skipped', async () => {
    mockAddImageToQueue.mockResolvedValue({ added: true, heldIds: [2] });

    expect(await insert('1,2')).toEqual({
      status: 200,
      body: { message: 'Image inserted into queue successfully', heldImageIds: [2] },
    });
  });

  it('(d) control: nothing inserted and nothing held keeps the old answer', async () => {
    mockAddImageToQueue.mockResolvedValue({ added: false, heldIds: [] });

    expect(await insert('9')).toEqual({ status: 200, body: { message: 'bonk', heldImageIds: [] } });
  });
});
