import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getModelFlagDetail } = vi.hoisted(() => ({ getModelFlagDetail: vi.fn() }));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/minor-hash.service', () => ({ getModelFlagDetail }));
vi.mock('$lib/server/minor-flag.service', () => ({}));

const { GET } = await import('../detail/[modelId]/+server');

type Event = Parameters<typeof GET>[0];
const get = (modelId: string, query = '') =>
  GET({
    params: { modelId },
    url: new URL(`http://x/models/flags/auto/detail/${modelId}${query}`),
  } as unknown as Event);

beforeEach(() => getModelFlagDetail.mockReset());

describe('GET /models/flags/auto/detail/[modelId]', () => {
  it('returns the detail for the model, with the asked-for prompt ids', async () => {
    getModelFlagDetail.mockResolvedValue({ openReports: 3 });
    const res = await get('42', '?prompts=7,x,8,7,-1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ openReports: 3 });
    expect(getModelFlagDetail).toHaveBeenCalledWith({ modelId: 42, promptIds: [7, 8] });
  });

  it('refuses an id that is not a model id, without querying', async () => {
    for (const bad of ['0', 'abc', '99999999999']) expect((await get(bad)).status).toBe(400);
    expect(getModelFlagDetail).not.toHaveBeenCalled();
  });

  it('says not found for a model that does not exist', async () => {
    getModelFlagDetail.mockResolvedValue(null);
    expect((await get('42')).status).toBe(404);
  });
});
