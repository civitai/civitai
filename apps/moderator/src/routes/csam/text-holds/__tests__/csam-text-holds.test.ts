import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listPendingCsamHolds, countPendingCsamHolds, decideCsamHold } = vi.hoisted(() => ({
  listPendingCsamHolds: vi.fn(),
  countPendingCsamHolds: vi.fn(),
  decideCsamHold: vi.fn(),
}));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/csam-holds.service', () => ({
  listPendingCsamHolds,
  countPendingCsamHolds,
  decideCsamHold,
}));

const { actions, load } = await import('../+page.server');
const { holdPreview, canRemoveHeld } = await import('../hold-entity');

type LoadEvent = Parameters<typeof load>[0];

const csamOnly = { 'csam.report.file': true };
const holder = { ...csamOnly, 'user.strike': true, 'user.ban': true };
type ActionEvent = Parameters<NonNullable<typeof actions>[string]>[0];

const loadAt = (query: string, grants: Record<string, boolean> = holder) =>
  load({
    url: new URL(`http://x/csam/text-holds${query}`),
    locals: { grants },
  } as unknown as LoadEvent) as Promise<Record<string, unknown>>;

const decide = (fields: Record<string, string>, grants: Record<string, boolean>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  const event = {
    request: new Request('http://x/csam/text-holds', { method: 'POST', body }),
    locals: { grants },
  };
  return actions!.decide(event as unknown as ActionEvent) as Promise<Record<string, unknown>>;
};

beforeEach(() => {
  vi.clearAllMocks();
  listPendingCsamHolds.mockResolvedValue({ items: [{ id: 1 }], hasMore: true });
  countPendingCsamHolds.mockResolvedValue(7);
  decideCsamHold.mockResolvedValue({ ok: true });
});

describe('csam text holds load', () => {
  it('pages the queue and narrows it to one entity type', async () => {
    const data = await loadAt('?page=3&limit=20&entityType=ChatMessage');
    expect(listPendingCsamHolds).toHaveBeenCalledWith({
      limit: 20,
      offset: 40,
      entityType: 'ChatMessage',
    });
    expect(countPendingCsamHolds).toHaveBeenCalledWith('ChatMessage');
    expect(data).toMatchObject({
      page: 3,
      offset: 40,
      entityType: 'ChatMessage',
      total: 7,
      items: [{ id: 1 }],
      hasMore: true,
    });
  });

  it('ignores an unknown entity type instead of filtering on it', async () => {
    const data = await loadAt('?entityType=Image');
    expect(listPendingCsamHolds).toHaveBeenCalledWith({
      limit: 50,
      offset: 0,
      entityType: undefined,
    });
    expect(data.entityType).toBeNull();
  });

  it('refuses a moderator without the csam permission before reading any hold', async () => {
    await expect(loadAt('', {})).rejects.toMatchObject({ status: 403 });
    expect(listPendingCsamHolds).not.toHaveBeenCalled();
    expect(countPendingCsamHolds).not.toHaveBeenCalled();
  });

  it('still lists the queue when the total fails', async () => {
    countPendingCsamHolds.mockRejectedValue(new Error('db down'));
    const data = await loadAt('');
    expect(data).toMatchObject({ items: [{ id: 1 }], total: undefined });
  });
});

describe('csam text holds decide', () => {
  it.each(['dismiss', 'remove', 'remove_strike', 'remove_ban', 'remove_ban_report'])(
    'sends %s to the main app with the note',
    async (decision) => {
      expect(await decide({ holdId: '12', decision, note: ' looked fine ' }, holder)).toMatchObject(
        {
          success: true,
          key: 12,
        }
      );
      expect(decideCsamHold).toHaveBeenCalledWith({ holdId: 12, decision, note: 'looked fine' });
    }
  );

  it.each([
    ['remove_strike', 'user.strike'],
    ['remove_ban', 'user.ban'],
    ['remove_ban_report', 'user.ban'],
  ])('refuses %s without the %s grant', async (decision, grant) => {
    const withoutIt = { ...holder, [grant]: false };
    expect(await decide({ holdId: '12', decision }, withoutIt)).toMatchObject({
      status: 403,
      data: { key: 12 },
    });
    expect(decideCsamHold).not.toHaveBeenCalled();
    expect(await decide({ holdId: '12', decision }, { ...holder, [grant]: true })).toMatchObject({
      success: true,
    });
  });

  it('lets a removal or a dismissal through without the strike or ban grant', async () => {
    await decide({ holdId: '12', decision: 'remove' }, csamOnly);
    await decide({ holdId: '12', decision: 'dismiss' }, csamOnly);
    expect(decideCsamHold).toHaveBeenCalledTimes(2);
  });

  it('sends no note when the field is blank', async () => {
    await decide({ holdId: '12', decision: 'remove', note: '   ' }, holder);
    expect(decideCsamHold).toHaveBeenCalledWith({
      holdId: 12,
      decision: 'remove',
      note: undefined,
    });
  });

  it('refuses a moderator without the csam permission', async () => {
    expect(await decide({ holdId: '12', decision: 'remove_ban' }, {})).toMatchObject({
      status: 403,
    });
    expect(decideCsamHold).not.toHaveBeenCalled();
  });

  it.each([
    ['no hold id', { decision: 'remove' }],
    ['no decision', { holdId: '12' }],
    ['a decision that is not offered', { holdId: '12', decision: 'confirm' }],
    ['a hold id past int4', { holdId: '3000000000', decision: 'remove' }],
    ['a note over the limit', { holdId: '12', decision: 'remove', note: 'x'.repeat(501) }],
  ])('refuses %s before calling the main app', async (_, fields) => {
    expect(await decide(fields, holder)).toMatchObject({ status: 400 });
    expect(decideCsamHold).not.toHaveBeenCalled();
  });

  it('reports the main app refusal against the hold', async () => {
    decideCsamHold.mockResolvedValue({ ok: false, error: 'already decided or missing' });
    expect(await decide({ holdId: '12', decision: 'remove' }, holder)).toMatchObject({
      status: 400,
      data: { error: 'already decided or missing', key: 12 },
    });
  });
});

describe('csam hold removal', () => {
  it.each(['ChatMessage', 'Comment', 'CommentV2', 'UserProfile', 'Model'])(
    'offers removal for a %s hold',
    (type) => expect(canRemoveHeld(type)).toBe(true)
  );

  it('offers none for a post, which has no reversible removal', () => {
    expect(canRemoveHeld('Post')).toBe(false);
  });
});

describe('csam hold row preview', () => {
  it('collapses the held text onto one line', () => {
    expect(holdPreview('  first line\n\n\tsecond   line  ')).toBe('first line second line');
  });

  it('cuts long text with an ellipsis, never through a surrogate pair', () => {
    const preview = holdPreview(`${'a'.repeat(89)}😀 and more after the cut`);
    expect(preview).toBe(`${'a'.repeat(89)}😀…`);
  });
});
