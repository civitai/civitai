import { beforeEach, describe, expect, it, vi } from 'vitest';

/** A vote runs the majority-block sweep with the real block path, and a refused vote does not. */

const { castVote, applyMajorityBlocks, blockImage } = vi.hoisted(() => ({
  castVote: vi.fn(),
  applyMajorityBlocks: vi.fn(),
  blockImage: vi.fn(),
}));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/image-moderation.service', () => ({ blockImage }));
vi.mock('$lib/server/scan-label.service', () => ({
  castVote,
  applyMajorityBlocks,
  claimNext: vi.fn(),
  getCounters: vi.fn(),
  getOpenFlaggerVersions: vi.fn(),
}));

const { actions } = await import('../scan-labels/+page.server');

const event = (fields: Record<string, string>) =>
  ({
    request: {
      formData: async () => {
        const form = new FormData();
        for (const [k, v] of Object.entries(fields)) form.set(k, v);
        return form;
      },
      headers: new Headers({ 'user-agent': 'ua' }),
    },
    getClientAddress: () => '1.2.3.4',
    locals: { user: { id: 7 } },
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  applyMajorityBlocks.mockResolvedValue({ blocked: [], failed: [] });
});

describe('vote action', () => {
  it('runs the sweep with blockImage after a recorded vote', async () => {
    castVote.mockResolvedValue({
      ok: true,
      votes: 2,
      blockVotes: 2,
      reachedBlockMajority: true,
      decided: false,
    });
    expect(await actions.vote(event({ itemId: '5', block: '1', ms: '900' }))).toEqual({
      voted: true,
    });
    expect(castVote).toHaveBeenCalledWith({ itemId: 5, userId: 7, block: true, msOnItem: 900 });
    expect(applyMajorityBlocks).toHaveBeenCalledExactlyOnceWith(
      { requester: 7, ip: '1.2.3.4', userAgent: 'ua' },
      blockImage
    );
  });

  it('still reports the vote when the sweep throws', async () => {
    castVote.mockResolvedValue({
      ok: true,
      votes: 1,
      blockVotes: 0,
      reachedBlockMajority: false,
      decided: false,
    });
    applyMajorityBlocks.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await actions.vote(event({ itemId: '5', block: '0' }))).toEqual({ voted: true });
  });

  it('refuses without sweeping when the vote was refused', async () => {
    castVote.mockResolvedValue({ ok: false, reason: 'full' });
    const result = (await actions.vote(event({ itemId: '5', block: '1' }))) as { status: number };
    expect(result.status).toBe(409);
    expect(applyMajorityBlocks).not.toHaveBeenCalled();
  });
});
