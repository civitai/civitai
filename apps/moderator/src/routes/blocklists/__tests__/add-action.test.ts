import { describe, expect, it, vi, beforeEach } from 'vitest';

const { upsertBlocklist } = vi.hoisted(() => ({ upsertBlocklist: vi.fn() }));
vi.mock('../../../lib/server/blocklist.service', () => ({
  BlocklistRowMismatchError: class extends Error {},
  getBlocklistDTO: vi.fn(),
  upsertBlocklist,
  removeBlocklistItems: vi.fn(),
}));

// The load's query parser reaches the database client, which throws at import without an env.
vi.mock('../../../lib/server/query', () => ({ parseQuery: vi.fn() }));

const { actions } = await import('../+page.server');

const add = (type: string, blocklist: string) => {
  const body = new FormData();
  body.set('type', type);
  body.set('blocklist', blocklist);
  const request = new Request('http://localhost/blocklists?/add', { method: 'POST', body });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return actions.add({ request, locals: { user: { id: 1 } } } as any);
};

describe('blocklists add action', () => {
  beforeEach(() => {
    upsertBlocklist.mockReset();
    upsertBlocklist.mockResolvedValue({ count: 1, cacheStale: false });
  });

  it('refuses a multi-word Profanity Benign Word entry and saves nothing', async () => {
    const result = await add('ProfanityBenignWord', 'spreadsheet, fu manchu');
    expect(result).toMatchObject({
      status: 400,
      data: { error: expect.stringContaining('"fu manchu"') },
    });
    expect(upsertBlocklist).not.toHaveBeenCalled();
  });

  it('saves a single-word entry', async () => {
    await add('ProfanityBenignWord', 'spreadsheet');
    expect(upsertBlocklist).toHaveBeenCalledOnce();
  });

  it('saves a multi-word entry on a phrase list', async () => {
    await add('PromptBenignPhrase', 'teen titans');
    expect(upsertBlocklist).toHaveBeenCalledOnce();
  });
});
