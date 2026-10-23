import { beforeEach, describe, expect, it, vi } from 'vitest';

/** A vote runs the majority-block sweep with the real block path, and a refused vote does not. */

const {
  castVote,
  applyMajorityBlocks,
  blockImage,
  isModerationBlocked,
  getVotedItemOwner,
  claimNext,
  getCounters,
  getOpenFlaggerVersions,
  isControlFlaggerVersion,
} = vi.hoisted(() => ({
  getVotedItemOwner: vi.fn(),
  claimNext: vi.fn(),
  getCounters: vi.fn(),
  getOpenFlaggerVersions: vi.fn(),
  isControlFlaggerVersion: vi.fn(),
  castVote: vi.fn(),
  applyMajorityBlocks: vi.fn(),
  blockImage: vi.fn(),
  isModerationBlocked: vi.fn(),
}));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/image-moderation.service', () => ({ blockImage, isModerationBlocked }));
vi.mock('$lib/server/scan-label.service', () => ({
  castVote,
  applyMajorityBlocks,
  claimNext,
  getCounters,
  getOpenFlaggerVersions,
  getVotedItemOwner,
  isControlFlaggerVersion,
}));

const { actions, load } = await import('../scan-labels/+page.server');

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

const OWNER = { imageId: 3, ownerId: 500, ownerUsername: 'uploader' };

beforeEach(() => {
  vi.clearAllMocks();
  applyMajorityBlocks.mockResolvedValue({ blocked: [], failed: [] });
  getVotedItemOwner.mockResolvedValue(OWNER);
});

describe('vote action', () => {
  const recorded = {
    ok: true,
    votes: 2,
    blockVotes: 2,
    reachedBlockMajority: true,
    decided: false,
  };

  it('records the reason and runs the sweep with the real block path', async () => {
    castVote.mockResolvedValue(recorded);
    expect(
      await actions.vote(event({ itemId: '5', block: '1', reason: 'bestiality', ms: '900' }))
    ).toEqual({ voted: true, owner: OWNER });
    // The owner of the item this vote was recorded on, read as this moderator.
    expect(getVotedItemOwner).toHaveBeenCalledExactlyOnceWith(5, 7);
    expect(castVote).toHaveBeenCalledWith({
      itemId: 5,
      userId: 7,
      choice: { block: true, reason: 'bestiality', reasonComment: null },
      msOnItem: 900,
    });
    expect(applyMajorityBlocks).toHaveBeenCalledExactlyOnceWith(
      { requester: 7, ip: '1.2.3.4', userAgent: 'ua' },
      { block: expect.any(Function), isModerationBlocked }
    );
    // The voting majority is the second opinion, so the sweep's block skips the re-removal hold.
    const { block } = applyMajorityBlocks.mock.calls[0][1];
    blockImage.mockResolvedValue({});
    await block({ imageId: 3, userId: 7 });
    expect(blockImage).toHaveBeenCalledExactlyOnceWith({
      imageId: 3,
      userId: 7,
      skipAppealCheck: true,
    });
  });

  it('keeps the comment for "other"', async () => {
    castVote.mockResolvedValue(recorded);
    await actions.vote(
      event({ itemId: '5', block: '1', reason: 'other', reasonComment: ' self-harm ' })
    );
    expect(castVote).toHaveBeenCalledWith(
      expect.objectContaining({
        choice: { block: true, reason: 'other', reasonComment: 'self-harm' },
      })
    );
  });

  it('drops a comment left over from "other" when another reason is picked', async () => {
    castVote.mockResolvedValue(recorded);
    await actions.vote(
      event({ itemId: '5', block: '1', reason: 'bestiality', reasonComment: 'draft' })
    );
    expect(castVote).toHaveBeenCalledWith(
      expect.objectContaining({
        choice: { block: true, reason: 'bestiality', reasonComment: null },
      })
    );
  });

  it.each([
    ['a block with no reason', { block: '1' }, 'Pick a reason'],
    ['an unknown reason', { block: '1', reason: 'made-up' }, 'Pick a reason'],
    ['"other" with no comment', { block: '1', reason: 'other', reasonComment: ' ' }, 'comment'],
  ])('refuses %s before recording anything', async (_, fields, message) => {
    const result = (await actions.vote(event({ itemId: '5', ...fields }))) as {
      status: number;
      data: { error: string };
    };
    expect(result.status).toBe(400);
    expect(result.data.error).toContain(message);
    expect(castVote).not.toHaveBeenCalled();
  });

  it('records a keep vote with no reason even if one is posted', async () => {
    castVote.mockResolvedValue({ ...recorded, blockVotes: 0, reachedBlockMajority: false });
    await actions.vote(event({ itemId: '5', block: '0', reason: 'bestiality' }));
    expect(castVote).toHaveBeenCalledWith(expect.objectContaining({ choice: { block: false } }));
  });

  it('still reports the vote when the sweep throws', async () => {
    castVote.mockResolvedValue(recorded);
    applyMajorityBlocks.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await actions.vote(event({ itemId: '5', block: '0' }))).toEqual({
      voted: true,
      owner: OWNER,
    });
  });

  it('still reports the vote when the owner read throws', async () => {
    castVote.mockResolvedValue(recorded);
    getVotedItemOwner.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await actions.vote(event({ itemId: '5', block: '0' }))).toEqual({
      voted: true,
      owner: null,
    });
  });

  it('refuses without sweeping when the vote was refused', async () => {
    castVote.mockResolvedValue({ ok: false, reason: 'full' });
    const result = (await actions.vote(event({ itemId: '5', block: '0' }))) as { status: number };
    expect(result.status).toBe(409);
    expect(applyMajorityBlocks).not.toHaveBeenCalled();
    expect(getVotedItemOwner).not.toHaveBeenCalled();
  });
});

describe('load', () => {
  const open = (search: string) =>
    load({
      url: new URL(`https://moderator.test/images/scan-labels${search}`),
      locals: { user: { id: 7 } },
    } as never) as Promise<{ version: string }>;

  beforeEach(() => {
    claimNext.mockResolvedValue(null);
    getCounters.mockResolvedValue({});
    getOpenFlaggerVersions.mockResolvedValue(['scan@1']);
  });

  it('treats the control version in the URL as no version filter', async () => {
    isControlFlaggerVersion.mockResolvedValue(true);

    const data = await open('?version=control-sample%402026-10-17');

    expect(isControlFlaggerVersion).toHaveBeenCalledWith('control-sample@2026-10-17');
    expect(claimNext).toHaveBeenCalledWith(7, { day: undefined, flaggerVersion: undefined });
    expect(getCounters).toHaveBeenCalledWith(7, { day: undefined, flaggerVersion: undefined });
    expect(data.version).toBe('');
  });

  it('keeps any other version as the filter', async () => {
    isControlFlaggerVersion.mockResolvedValue(false);

    const data = await open('?version=scan%401');

    expect(claimNext).toHaveBeenCalledWith(7, { day: undefined, flaggerVersion: 'scan@1' });
    expect(data.version).toBe('scan@1');
  });
});
