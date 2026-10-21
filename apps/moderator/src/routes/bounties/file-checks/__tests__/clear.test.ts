import { beforeEach, describe, expect, it, vi } from 'vitest';

const { clearEntryFileCheck } = vi.hoisted(() => ({ clearEntryFileCheck: vi.fn() }));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/bounty-file-check.service', () => ({
  getBlockedEntryFiles: vi.fn(),
  getStuckEntryFiles: vi.fn(),
  getClearedEntryFiles: vi.fn(),
  clearEntryFileCheck,
}));

const { actions } = await import('../+page.server');

const post = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return { request: new Request('http://x/bounties/file-checks', { method: 'POST', body }) };
};
type ActionEvent = Parameters<(typeof actions)['clear']>[0];
type Refusal = { status: number; data: { error: string; fileId?: number } };
const clear = (fields: Record<string, string>) =>
  actions.clear(post(fields) as unknown as ActionEvent) as Promise<Record<string, unknown>>;

beforeEach(() => {
  vi.clearAllMocks();
  clearEntryFileCheck.mockResolvedValue({ ok: true, body: {} });
});

describe('clearing a bounty entry file check', () => {
  it('sends the file and the trimmed reason to the main app', async () => {
    expect(await clear({ fileId: '31', reason: ' their own alt account ' })).toEqual({
      success: true,
      fileId: 31,
    });
    expect(clearEntryFileCheck).toHaveBeenCalledExactlyOnceWith(31, 'their own alt account');
  });

  it.each([
    ['no reason', { fileId: '31' }],
    ['a whitespace-only reason', { fileId: '31', reason: '  \n ' }],
  ])('refuses %s before calling the main app', async (_, fields) => {
    const result = (await clear(fields)) as unknown as Refusal;
    expect(result.status).toBe(400);
    expect(result.data.error).toBe('A reason is required.');
    expect(clearEntryFileCheck).not.toHaveBeenCalled();
  });

  it("shows the main app's refusal against the file", async () => {
    clearEntryFileCheck.mockResolvedValue({ ok: false, error: 'This file is not blocked.' });
    const result = (await clear({ fileId: '31', reason: 'fine' })) as unknown as Refusal;
    expect(result).toMatchObject({
      status: 400,
      data: { error: 'This file is not blocked.', fileId: 31 },
    });
  });
});
