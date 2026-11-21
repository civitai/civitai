import { describe, expect, it, vi, beforeEach } from 'vitest';

const { upsertBlocklist, getBlocklistDTO } = vi.hoisted(() => ({
  upsertBlocklist: vi.fn(),
  getBlocklistDTO: vi.fn(),
}));
const { BlocklistNotSeededError } = vi.hoisted(() => ({
  BlocklistNotSeededError: class extends Error {},
}));
vi.mock('../../../lib/server/blocklist.service', () => ({
  BlocklistRowMismatchError: class extends Error {},
  BlocklistNotSeededError,
  getBlocklistDTO,
  upsertBlocklist,
  removeBlocklistItems: vi.fn(),
}));

vi.mock('../../../lib/server/user-actions.service', () => ({ callModEndpoint: vi.fn() }));
// The load's query parser reaches the database client, which throws at import without an env.
vi.mock('../../../lib/server/query', () => ({ parseQuery: vi.fn() }));

const { actions } = await import('../+page.server');

const add = (type: string, blocklist: string, confirmImpact?: string) => {
  const body = new FormData();
  body.set('type', type);
  body.set('blocklist', blocklist);
  if (confirmImpact !== undefined) body.set('confirmImpact', confirmImpact);
  const request = new Request('http://localhost/blocklists?/add', { method: 'POST', body });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return actions.add({ request, locals: { user: { id: 1 } } } as any);
};

describe('blocklists add action', () => {
  beforeEach(() => {
    upsertBlocklist.mockReset();
    upsertBlocklist.mockResolvedValue({ count: 1, cacheStale: false });
    // No moderator allow row: the shipped allow list, which holds none of these synthetic words.
    getBlocklistDTO.mockReset();
    getBlocklistDTO.mockResolvedValue({ type: 'ProfanityBenignWord', data: [] });
  });

  describe('a Profanity Word entry that matches allowed words', () => {
    beforeEach(() => {
      getBlocklistDTO.mockResolvedValue({
        id: 3,
        type: 'ProfanityBenignWord',
        data: ['zorbspreadsheet', 'unrelated'],
      });
    });

    it('is not saved until the same text is submitted again', async () => {
      const result = await add('ProfanityWord', 'zorbspread');
      expect(result).toMatchObject({
        status: 409,
        data: {
          error: expect.stringContaining('"zorbspread" matches 1 allowed word (zorbspreadsheet)'),
          confirmImpact: 'zorbspread',
        },
      });
      expect(upsertBlocklist).not.toHaveBeenCalled();

      await add('ProfanityWord', 'zorbspread', 'zorbspread');
      expect(upsertBlocklist).toHaveBeenCalledOnce();
    });

    it('asks again when the text changed since the warning', async () => {
      const result = await add('ProfanityWord', 'zorbspread, zorbextra', 'zorbspread');
      expect(result).toMatchObject({ status: 409 });
      expect(upsertBlocklist).not.toHaveBeenCalled();
    });

    it('does not ask for an entry anchored where no allowed word matches', async () => {
      await add('ProfanityWord', 'zorbspread|');
      expect(upsertBlocklist).toHaveBeenCalledOnce();
    });
  });

  it('answers 409, not 500, when the Profanity Word list has not been seeded', async () => {
    upsertBlocklist.mockRejectedValue(new BlocklistNotSeededError());
    const result = await add('ProfanityWord', 'zorblat');
    expect(result).toMatchObject({
      status: 409,
      data: { error: expect.stringContaining('not been set up') },
    });
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

  it('refuses a POI search rule that matching would strip to nothing', async () => {
    const result = await add('SemanticSearchPoiRefuse', 'zqvoxpoitoken, 日本語');
    expect(result).toMatchObject({
      status: 400,
      data: { error: expect.stringContaining('"日本語"') },
    });
    expect(upsertBlocklist).not.toHaveBeenCalled();
  });

  it('saves a punctuated POI search rule', async () => {
    await add('SemanticSearchPoiRefuse', "zq-vox o'poi");
    expect(upsertBlocklist).toHaveBeenCalledOnce();
  });
});
