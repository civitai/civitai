import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  listCsamHolds,
  countCsamHoldsByType,
  countPendingCsamHolds,
  decideCsamHold,
  decideAuthorHolds,
  getHoldCoverImages,
  getHoldContexts,
  getCleanRescans,
} = vi.hoisted(() => ({
  decideAuthorHolds: vi.fn(),
  getHoldCoverImages: vi.fn(),
  getCleanRescans: vi.fn(),
  getHoldContexts: vi.fn(),
  listCsamHolds: vi.fn(),
  countCsamHoldsByType: vi.fn(),
  countPendingCsamHolds: vi.fn(),
  decideCsamHold: vi.fn(),
}));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('../hold-context.server', () => ({ getHoldContexts }));
vi.mock('$lib/server/csam-holds.service', async () => ({
  // The real search parser: what a `q` becomes is part of what the load hands the query.
  csamHoldSearch: (
    await vi.importActual<typeof import('$lib/server/csam-holds.queries')>(
      '$lib/server/csam-holds.queries'
    )
  ).csamHoldSearch,
  listCsamHolds,
  countCsamHoldsByType,
  countPendingCsamHolds,
  decideCsamHold,
  decideAuthorHolds,
  getHoldCoverImages,
  getCleanRescans,
}));

const { actions, load } = await import('../+page.server');
const {
  canRemoveHeld,
  decisionLabel,
  holdDecisionEnabled,
  holdEntityHref,
  holdMeta,
  holdTitle,
  quotedPhrases,
  splitEmptyTypes,
} = await import('../hold-entity');

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
  listCsamHolds.mockResolvedValue({ items: [{ id: 1 }], hasMore: true });
  countCsamHoldsByType.mockResolvedValue({ Post: 5, ChatMessage: 2 });
  countPendingCsamHolds.mockResolvedValue(9);
  decideCsamHold.mockResolvedValue({ ok: true });
  decideAuthorHolds.mockResolvedValue([{ holdId: 13, ok: true }]);
  getHoldCoverImages.mockResolvedValue(new Map());
  getCleanRescans.mockResolvedValue(new Map());
  getHoldContexts.mockResolvedValue(new Map());
});

describe('csam text holds load', () => {
  it('lists the pending queue, oldest first, by default', async () => {
    const data = await loadAt('');
    expect(listCsamHolds).toHaveBeenCalledWith({
      limit: 50,
      offset: 0,
      entityType: undefined,
      status: 'pending',
      sort: 'oldest',
      search: undefined,
    });
    expect(data).toMatchObject({ holdFilters: { status: 'pending', sort: 'oldest' }, q: '' });
  });

  it('pages the queue and narrows it by type, status, sort and search', async () => {
    const data = await loadAt(
      '?page=3&limit=20&entityType=ChatMessage&status=removed&sort=newest&q=42'
    );
    expect(listCsamHolds).toHaveBeenCalledWith({
      limit: 20,
      offset: 40,
      entityType: 'ChatMessage',
      status: 'removed',
      sort: 'newest',
      search: { id: 42 },
    });
    expect(countCsamHoldsByType).toHaveBeenCalledWith({ status: 'removed', search: { id: 42 } });
    expect(data).toMatchObject({
      page: 3,
      offset: 40,
      entityType: 'ChatMessage',
      total: 2,
      typeCounts: { Post: 5, ChatMessage: 2, all: 7 },
      items: [{ id: 1 }],
      hasMore: true,
    });
  });

  it('searches a non-numeric term as a username', async () => {
    await loadAt('?q=%20someone%20');
    expect(listCsamHolds).toHaveBeenCalledWith(
      expect.objectContaining({ search: { username: 'someone' } })
    );
  });

  it('filters on the author apart from the search, which also matches content ids', async () => {
    const data = await loadAt('?author=42');
    expect(listCsamHolds).toHaveBeenCalledWith(
      expect.objectContaining({ author: 42, search: undefined })
    );
    expect(countCsamHoldsByType).toHaveBeenCalledWith(expect.objectContaining({ author: 42 }));
    expect(data.author).toBe(42);
  });

  it('ignores an author that is not an id', async () => {
    const data = await loadAt('?author=abc');
    expect(listCsamHolds).toHaveBeenCalledWith(expect.objectContaining({ author: undefined }));
    expect(data.author).toBeNull();
  });

  it.each(['?entityType=Image', '?entityType=ResourceReview'])(
    'ignores %s instead of filtering on it',
    async (query) => {
      const data = await loadAt(query);
      expect(listCsamHolds).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: undefined })
      );
      expect(data.entityType).toBeNull();
    }
  );

  it('falls back to the defaults for an unknown status or sort', async () => {
    await loadAt('?status=bogus&sort=sideways');
    expect(listCsamHolds).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending', sort: 'oldest' })
    );
  });

  it('refuses a moderator without the csam permission before reading any hold', async () => {
    await expect(loadAt('', {})).rejects.toMatchObject({ status: 403 });
    expect(listCsamHolds).not.toHaveBeenCalled();
    expect(countCsamHoldsByType).not.toHaveBeenCalled();
  });

  it('reports the pending total whatever status and search the list is narrowed to', async () => {
    const data = await loadAt('?status=removed&q=42');
    expect(countPendingCsamHolds).toHaveBeenCalledWith();
    expect(data.pendingCount).toBe(9);
  });

  it('still lists the queue when the pending total fails', async () => {
    countPendingCsamHolds.mockRejectedValue(new Error('db down'));
    const data = await loadAt('');
    expect(data).toMatchObject({ items: [{ id: 1 }], pendingCount: null });
  });

  it('hands each row its preview images from one batched read of the page', async () => {
    listCsamHolds.mockResolvedValue({
      items: [
        { id: 1, entityType: 'Post', entityId: 10 },
        { id: 2, entityType: 'ChatMessage', entityId: 20 },
      ],
      hasMore: false,
    });
    getHoldCoverImages.mockResolvedValue(
      new Map([[1, { images: [{ id: 5, url: 'k-1', nsfwLevel: 1 }], total: 9 }]])
    );
    const data = await loadAt('');
    expect(getHoldCoverImages).toHaveBeenCalledTimes(1);
    expect(getHoldCoverImages).toHaveBeenCalledWith([
      { id: 1, entityType: 'Post', entityId: 10 },
      { id: 2, entityType: 'ChatMessage', entityId: 20 },
    ]);
    expect(data.items).toMatchObject([
      { id: 1, coverImages: [{ id: 5, url: 'k-1', nsfwLevel: 1 }], imageTotal: 9 },
      { id: 2, coverImages: [], imageTotal: 0 },
    ]);
  });

  it('still lists the queue, with icons, when the images fail', async () => {
    getHoldCoverImages.mockRejectedValue(new Error('db down'));
    const data = await loadAt('');
    expect(data.items).toMatchObject([{ id: 1, coverImages: [], imageTotal: 0 }]);
  });

  it('marks a hold whose content was scanned clean since, in one read for the page', async () => {
    const scannedAt = new Date('2026-10-20T10:00:00Z');
    listCsamHolds.mockResolvedValue({ items: [{ id: 1 }, { id: 2 }], hasMore: false });
    getCleanRescans.mockResolvedValue(new Map([[2, scannedAt]]));
    const data = await loadAt('');
    expect(getCleanRescans).toHaveBeenCalledTimes(1);
    expect(data.items).toMatchObject([
      { id: 1, cleanRescanAt: null },
      { id: 2, cleanRescanAt: scannedAt },
    ]);
  });

  it('still lists the queue when the rescans cannot be read', async () => {
    getCleanRescans.mockRejectedValue(new Error('db down'));
    const data = await loadAt('');
    expect(data.items).toMatchObject([{ id: 1, cleanRescanAt: null }]);
  });

  it('hands each row its profile or comment parent from one batched read of the page', async () => {
    listCsamHolds.mockResolvedValue({
      items: [
        { id: 1, entityType: 'UserProfile', entityId: 10 },
        { id: 2, entityType: 'CommentV2', entityId: 20 },
        { id: 3, entityType: 'Post', entityId: 30 },
      ],
      hasMore: false,
    });
    const profile = { bio: 'x', images: [] };
    const parent = { type: 'post', id: 9, title: 't', images: [], imageTotal: 0 };
    getHoldContexts.mockResolvedValue(
      new Map([
        [1, { profile, parent: null }],
        [2, { profile: null, parent }],
      ])
    );
    const data = await loadAt('');
    expect(getHoldContexts).toHaveBeenCalledTimes(1);
    expect(data.items).toMatchObject([
      { id: 1, profile, parent: null },
      { id: 2, profile: null, parent },
      { id: 3, profile: null, parent: null },
    ]);
  });

  it('still lists the queue when the context fails', async () => {
    getHoldContexts.mockRejectedValue(new Error('db down'));
    const data = await loadAt('');
    expect(data.items).toMatchObject([{ id: 1, profile: null, parent: null }]);
  });

  it('still lists the queue when the counts fail', async () => {
    countCsamHoldsByType.mockRejectedValue(new Error('db down'));
    const data = await loadAt('');
    expect(data).toMatchObject({ items: [{ id: 1 }], total: undefined, typeCounts: null });
  });
});

describe('csam text holds decide', () => {
  it.each(['dismiss', 'remove', 'remove_strike', 'remove_ban', 'remove_ban_report'])(
    'sends %s to the main app with the note',
    async (decision) => {
      expect(
        await decide({ holdId: '12', textHash: 'h-12', decision, note: ' looked fine ' }, holder)
      ).toMatchObject({
        success: true,
        key: 12,
      });
      expect(decideCsamHold).toHaveBeenCalledWith({
        holdId: 12,
        textHash: 'h-12',
        decision,
        note: 'looked fine',
      });
    }
  );

  it.each([
    ['remove_strike', 'user.strike'],
    ['remove_ban', 'user.ban'],
    ['remove_ban_report', 'user.ban'],
  ])('refuses %s without the %s grant', async (decision, grant) => {
    const withoutIt = { ...holder, [grant]: false };
    expect(await decide({ holdId: '12', textHash: 'h-12', decision }, withoutIt)).toMatchObject({
      status: 403,
      data: { key: 12 },
    });
    expect(decideCsamHold).not.toHaveBeenCalled();
    expect(
      await decide({ holdId: '12', textHash: 'h-12', decision }, { ...holder, [grant]: true })
    ).toMatchObject({
      success: true,
    });
  });

  it('lets a removal or a dismissal through without the strike or ban grant', async () => {
    await decide({ holdId: '12', textHash: 'h-12', decision: 'remove' }, csamOnly);
    await decide({ holdId: '12', textHash: 'h-12', decision: 'dismiss' }, csamOnly);
    expect(decideCsamHold).toHaveBeenCalledTimes(2);
  });

  it('sends no note when the field is blank', async () => {
    await decide({ holdId: '12', textHash: 'h-12', decision: 'remove', note: '   ' }, holder);
    expect(decideCsamHold).toHaveBeenCalledWith({
      holdId: 12,
      textHash: 'h-12',
      decision: 'remove',
      note: undefined,
    });
  });

  it('refuses a moderator without the csam permission', async () => {
    expect(
      await decide({ holdId: '12', textHash: 'h-12', decision: 'remove_ban' }, {})
    ).toMatchObject({
      status: 403,
    });
    expect(decideCsamHold).not.toHaveBeenCalled();
  });

  it.each([
    ['no hold id', { decision: 'remove' }],
    ['no decision', { holdId: '12', textHash: 'h-12' }],
    ['a decision that is not offered', { holdId: '12', textHash: 'h-12', decision: 'confirm' }],
    ['a hold id past int4', { holdId: '3000000000', decision: 'remove' }],
    [
      'a note over the limit',
      { holdId: '12', textHash: 'h-12', decision: 'remove', note: 'x'.repeat(501) },
    ],
  ])('refuses %s before calling the main app', async (_, fields) => {
    expect(await decide(fields, holder)).toMatchObject({ status: 400 });
    expect(decideCsamHold).not.toHaveBeenCalled();
  });

  it('shows the main app message when the hold changed since it was opened', async () => {
    decideCsamHold.mockResolvedValue({
      ok: false,
      error: 'Decide hold: This hold changed after you opened it. Reload to review the new text.',
    });
    expect(
      await decide({ holdId: '12', textHash: 'h-old', decision: 'remove' }, holder)
    ).toMatchObject({
      status: 400,
      data: { error: expect.stringContaining('Reload'), key: 12 },
    });
    expect(decideCsamHold).toHaveBeenCalledWith(expect.objectContaining({ textHash: 'h-old' }));
  });

  it('reports the main app refusal against the hold', async () => {
    decideCsamHold.mockResolvedValue({ ok: false, error: 'already decided or missing' });
    expect(
      await decide({ holdId: '12', textHash: 'h-12', decision: 'remove' }, holder)
    ).toMatchObject({
      status: 400,
      data: { error: 'already decided or missing', key: 12 },
    });
  });
});

describe('csam text holds decide with the author’s other holds', () => {
  const also = JSON.stringify([{ holdId: 13, textHash: 'h-13' }]);

  it('decides the open hold first, then the others, and reports each', async () => {
    const result = await decide(
      { holdId: '12', textHash: 'h-12', decision: 'remove_ban', also, note: 'x' },
      holder
    );
    expect(decideCsamHold).toHaveBeenCalledWith({
      holdId: 12,
      textHash: 'h-12',
      decision: 'remove_ban',
      note: 'x',
    });
    expect(decideAuthorHolds).toHaveBeenCalledWith({
      holdId: 12,
      also: [{ holdId: 13, textHash: 'h-13' }],
      decision: 'remove_ban',
      note: 'x',
    });
    expect(decideCsamHold.mock.invocationCallOrder[0]).toBeLessThan(
      decideAuthorHolds.mock.invocationCallOrder[0]
    );
    expect(result).toMatchObject({ success: true, key: 12, others: [{ holdId: 13, ok: true }] });
  });

  it('touches no other hold when the open one is refused, so a refused ban removes nothing', async () => {
    decideCsamHold.mockResolvedValue({ ok: false, error: 'already decided' });
    expect(
      await decide({ holdId: '12', textHash: 'h-12', decision: 'remove_ban', also }, holder)
    ).toMatchObject({ status: 400 });
    expect(decideAuthorHolds).not.toHaveBeenCalled();
  });

  it('keeps the open hold’s success when applying to the others throws', async () => {
    decideAuthorHolds.mockRejectedValue(new Error('db down'));
    const result = await decide(
      { holdId: '12', textHash: 'h-12', decision: 'remove', also },
      holder
    );
    expect(result).toMatchObject({
      success: true,
      others: [{ holdId: 13, ok: false, error: expect.any(String) }],
    });
  });

  it('applies to no others when none are sent', async () => {
    const result = await decide({ holdId: '12', textHash: 'h-12', decision: 'remove' }, holder);
    expect(decideAuthorHolds).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('others');
  });

  it.each([
    ['malformed JSON', '{nope'],
    ['a hold without a hash', JSON.stringify([{ holdId: 13 }])],
    [
      'too many holds',
      JSON.stringify(Array.from({ length: 51 }, (_, i) => ({ holdId: i + 1, textHash: 'h' }))),
    ],
  ])('refuses %s before deciding anything', async (_, bad) => {
    expect(
      await decide({ holdId: '12', textHash: 'h-12', decision: 'remove', also: bad }, holder)
    ).toMatchObject({ status: 400 });
    expect(decideCsamHold).not.toHaveBeenCalled();
  });
});

describe('csam hold removal', () => {
  it.each(['ChatMessage', 'Comment', 'CommentV2', 'UserProfile', 'Post', 'Model', 'Article'])(
    'offers removal for a %s hold',
    (type) => expect(canRemoveHeld(type)).toBe(true)
  );

  it('offers none for a type the main app cannot remove', () => {
    expect(canRemoveHeld('Image')).toBe(false);
  });
});

const pendingHold = { entityType: 'Post', status: 'Pending', userId: 7 };
const everyone = { canDecide: true, canStrike: true, canBan: true };

describe('csam hold decision keys', () => {
  it('offers the five decisions in key order to a moderator holding every grant', () => {
    expect(holdDecisionEnabled(pendingHold, everyone)).toEqual([true, true, true, true, true]);
  });

  it('leaves strike and the two ban keys off without their grants', () => {
    expect(holdDecisionEnabled(pendingHold, { ...everyone, canStrike: false })).toEqual([
      true,
      true,
      false,
      true,
      true,
    ]);
    expect(holdDecisionEnabled(pendingHold, { ...everyone, canBan: false })).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  it('leaves the author keys off when the author is unknown', () => {
    expect(holdDecisionEnabled({ ...pendingHold, userId: null }, everyone)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  it('only dismisses a type the main app cannot remove', () => {
    expect(holdDecisionEnabled({ ...pendingHold, entityType: 'Image' }, everyone)).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  it('offers nothing on a decided hold or to a moderator who cannot decide', () => {
    expect(holdDecisionEnabled({ ...pendingHold, status: 'Dismissed' }, everyone)).toEqual([]);
    expect(holdDecisionEnabled(pendingHold, { ...everyone, canDecide: false })).toEqual([]);
  });
});

describe('quotedPhrases', () => {
  it('reads phrases quoted in single, double or curly quotes', () => {
    expect(
      quotedPhrases(
        `Mentions 'first phrase' and "second phrase", then “third phrase” and ‘fourth one’.`
      )
    ).toEqual(['first phrase', 'second phrase', 'third phrase', 'fourth one']);
  });

  it('does not take an apostrophe inside a word for a quote', () => {
    expect(
      quotedPhrases(`The author's text isn't what the 'quoted bit' says, nor the others' words`)
    ).toEqual(['quoted bit']);
  });

  it('finds nothing in a reason that quotes nothing, and drops empty or one-character quotes', () => {
    expect(quotedPhrases('Plain reason with no quotes')).toEqual([]);
    expect(quotedPhrases(`Odd '' and 'x' quotes`)).toEqual([]);
  });

  it('does not let a quote that never closes swallow the text up to the next one', () => {
    const rambling = 'x'.repeat(300);
    expect(quotedPhrases(`He wrote "start of ${rambling} and later "closed" here`)).toEqual([
      'closed',
    ]);
  });

  it('lists a repeated phrase once', () => {
    expect(quotedPhrases(`'same one' then "same one"`)).toEqual(['same one']);
  });
});

describe('decisionLabel', () => {
  it('names a hold the migration superseded rather than calling it dismissed', () => {
    expect(decisionLabel({ status: 'Dismissed', decision: 'superseded' })).toBe(
      'Superseded by a newer scan'
    );
    expect(decisionLabel({ status: 'Dismissed', decision: 'dismiss' })).toBe('Dismissed');
  });
});

describe('csam hold row text', () => {
  const base = { entityId: 5, title: null, username: null, userId: null };

  it('titles a post or model by its title and falls back to the type and id', () => {
    expect(holdTitle({ ...base, entityType: 'Post', title: 'Some title' })).toBe('Some title');
    expect(holdTitle({ ...base, entityType: 'Model' })).toBe('Model #5');
  });

  it('titles chat, comments and profiles by what they are', () => {
    expect(holdTitle({ ...base, entityType: 'ChatMessage' })).toBe('Chat');
    expect(holdTitle({ ...base, entityType: 'CommentV2' })).toBe('Comment');
    expect(holdTitle({ ...base, entityType: 'Comment' })).toBe('Comment');
    expect(holdTitle({ ...base, entityType: 'UserProfile', username: 'someone' })).toBe('someone');
    expect(holdTitle({ ...base, entityType: 'UserProfile', userId: 3 })).toBe('user #3');
  });

  it('says when the text of a pending hold was last updated, once it was', () => {
    const now = Date.parse('2026-10-20T12:00:00Z');
    const createdAt = new Date('2026-10-20T02:00:00Z');
    expect(
      holdMeta(
        { status: 'Pending', createdAt, decidedAt: null, textUpdatedAt: '2026-10-20T11:55:00Z' },
        now
      )
    ).toBe('text updated 5m');
    expect(
      holdMeta({ status: 'Pending', createdAt, decidedAt: null, textUpdatedAt: null }, now)
    ).toBe('held 10h');
  });

  it('says how long ago a pending hold was held, and a decided one was decided', () => {
    const now = Date.parse('2026-10-20T12:00:00Z');
    const createdAt = new Date('2026-10-20T07:00:00Z');
    expect(holdMeta({ status: 'Pending', createdAt, decidedAt: null }, now)).toBe('held 5h');
    expect(
      holdMeta({ status: 'Confirmed', createdAt, decidedAt: new Date('2026-10-20T10:00:00Z') }, now)
    ).toBe('decided 2h');
  });
});

describe('holdEntityHref', () => {
  const ref = { entityId: 5, userId: null, username: null, chatId: null };

  it('opens a legacy comment on its model, highlighting the comment', () => {
    expect(
      holdEntityHref('https://site.test', { ...ref, entityType: 'Comment', commentModelId: 70 })
    ).toBe('https://site.test/models/70?dialog=commentThread&highlight=5');
  });

  it('has no link for a legacy comment whose model is unknown', () => {
    expect(
      holdEntityHref('https://site.test', { ...ref, entityType: 'Comment', commentModelId: null })
    ).toBeNull();
  });
});

describe('splitEmptyTypes', () => {
  it('keeps types with holds as chips and folds the rest, in type order', () => {
    expect(
      splitEmptyTypes(['Model', 'Post', 'ChatMessage'], { Post: 2, ChatMessage: 1 }, null)
    ).toEqual({ shown: ['Post', 'ChatMessage'], empty: ['Model'] });
  });

  it('keeps the selected type as a chip although it is empty', () => {
    expect(splitEmptyTypes(['Model', 'Post'], { Post: 2 }, 'Model')).toEqual({
      shown: ['Model', 'Post'],
      empty: [],
    });
  });

  it('shows every type when the counts could not be read', () => {
    expect(splitEmptyTypes(['Model', 'Post'], null, null)).toEqual({
      shown: ['Model', 'Post'],
      empty: [],
    });
  });
});
