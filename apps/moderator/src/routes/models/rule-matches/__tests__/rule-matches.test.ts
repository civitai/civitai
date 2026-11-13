import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  listModelRuleHolds,
  countPendingModelRuleHolds,
  countModelRuleHoldsByRule,
  decideModelRuleHold,
  decideOwnerHolds,
  getHoldModelFacts,
  getHoldCoverImages,
} = vi.hoisted(() => ({
  listModelRuleHolds: vi.fn(),
  countPendingModelRuleHolds: vi.fn(),
  countModelRuleHoldsByRule: vi.fn(),
  decideModelRuleHold: vi.fn(),
  decideOwnerHolds: vi.fn(),
  getHoldModelFacts: vi.fn(),
  getHoldCoverImages: vi.fn(),
}));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/csam-holds.queries', () => ({ getHoldCoverImages }));
vi.mock('$lib/server/model-rule-holds.service', async () => ({
  // The real search parser: what a `q` becomes is part of what the load hands the query.
  modelRuleHoldSearch: (
    await vi.importActual<typeof import('$lib/server/model-rule-holds.queries')>(
      '$lib/server/model-rule-holds.queries'
    )
  ).modelRuleHoldSearch,
  listModelRuleHolds,
  countPendingModelRuleHolds,
  countModelRuleHoldsByRule,
  decideModelRuleHold,
  decideOwnerHolds,
  getHoldModelFacts,
}));

const { actions, load } = await import('../+page.server');

type LoadEvent = Parameters<typeof load>[0];
type ActionEvent = Parameters<NonNullable<typeof actions>[string]>[0];

const loadAt = (query: string) =>
  load({
    url: new URL(`http://x/models/rule-matches${query}`),
    locals: { grants: {} },
  } as unknown as LoadEvent) as Promise<Record<string, unknown>>;

const decide = (fields: Record<string, string>, grants: Record<string, boolean> = {}) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  const event = {
    request: new Request('http://x/models/rule-matches', { method: 'POST', body }),
    locals: { grants },
  };
  return actions!.decide(event as unknown as ActionEvent) as Promise<Record<string, unknown>>;
};

const base = { holdId: '12', textHash: 'abc', decision: 'dismiss_allowed' };

beforeEach(() => {
  vi.clearAllMocks();
  listModelRuleHolds.mockResolvedValue({ items: [{ id: 12, modelId: 3 }], hasMore: false });
  countPendingModelRuleHolds.mockResolvedValue(4);
  countModelRuleHoldsByRule.mockResolvedValue([]);
  decideModelRuleHold.mockResolvedValue({ ok: true });
  decideOwnerHolds.mockResolvedValue([{ holdId: 13, ok: true }]);
  getHoldModelFacts.mockResolvedValue(new Map());
  getHoldCoverImages.mockResolvedValue(new Map());
});

describe('model rule matches load', () => {
  it('lists the pending queue, oldest first, in both modes by default', async () => {
    await loadAt('');
    expect(listModelRuleHolds).toHaveBeenCalledWith({
      status: 'pending',
      mode: 'all',
      sort: 'oldest',
      rule: null,
      limit: 50,
      offset: 0,
      search: undefined,
      owner: undefined,
    });
  });

  it('passes the filters, the search and the page through', async () => {
    await loadAt(
      '?status=confirmed&mode=auto&sort=newest&rule=7&q=somebody&owner=9&page=2&limit=10'
    );
    expect(listModelRuleHolds).toHaveBeenCalledWith({
      status: 'confirmed',
      mode: 'auto',
      sort: 'newest',
      rule: 7,
      limit: 10,
      offset: 10,
      search: { username: 'somebody' },
      owner: 9,
    });
  });

  it('still lists when the counts, images or facts fail', async () => {
    countPendingModelRuleHolds.mockRejectedValue(new Error('x'));
    countModelRuleHoldsByRule.mockRejectedValue(new Error('x'));
    getHoldCoverImages.mockRejectedValue(new Error('x'));
    getHoldModelFacts.mockRejectedValue(new Error('x'));
    const data = await loadAt('');
    expect(data.pendingCount).toBeNull();
    expect(data.items).toEqual([
      expect.objectContaining({
        id: 12,
        coverImages: [],
        facts: expect.objectContaining({ tags: [] }),
      }),
    ]);
  });
});

describe('model rule matches decide', () => {
  it.each(['confirm', 'dismiss_not_subject', 'dismiss_allowed'])(
    'sends %s to the main app with the hash the moderator saw and the trimmed note',
    async (decision) => {
      const result = await decide({ ...base, decision, note: '  fine  ' });
      expect(result).toEqual({ success: true, key: 12 });
      expect(decideModelRuleHold).toHaveBeenCalledWith({
        holdId: 12,
        textHash: 'abc',
        decision,
        note: 'fine',
      });
    }
  );

  it('refuses a strike without the grant and never calls the main app', async () => {
    const result = await decide({ ...base, decision: 'confirm_strike' }, {});
    expect(result).toMatchObject({ status: 403 });
    expect(decideModelRuleHold).not.toHaveBeenCalled();
  });

  it('lets a holder of user.strike confirm and strike', async () => {
    await decide({ ...base, decision: 'confirm_strike' }, { 'user.strike': true });
    expect(decideModelRuleHold).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'confirm_strike' })
    );
  });

  it('shows the main app’s stale refusal on the hold and decides nothing else', async () => {
    decideModelRuleHold.mockResolvedValue({
      ok: false,
      error: 'The text changed since you opened this hold.',
    });
    const result = await decide({ ...base, also: JSON.stringify([{ holdId: 13, textHash: 'x' }]) });
    expect(result).toMatchObject({
      status: 400,
      data: { error: 'The text changed since you opened this hold.', key: 12 },
    });
    expect(decideOwnerHolds).not.toHaveBeenCalled();
  });

  it('rejects a decision the main app does not know', async () => {
    const result = await decide({ ...base, decision: 'dismiss' });
    expect(result).toMatchObject({ status: 400 });
    expect(decideModelRuleHold).not.toHaveBeenCalled();
  });

  it('applies the decision to the owner’s other holds after the first one lands', async () => {
    const also = [{ holdId: 13, textHash: 'x' }];
    const result = await decide({ ...base, decision: 'confirm', also: JSON.stringify(also) });
    expect(decideOwnerHolds).toHaveBeenCalledWith({
      holdId: 12,
      also,
      decision: 'confirm',
      note: undefined,
    });
    expect(result).toMatchObject({ success: true, others: [{ holdId: 13, ok: true }] });
  });

  it('reports every other hold as failed when the batch call throws', async () => {
    decideOwnerHolds.mockRejectedValue(new Error('boom'));
    const result = await decide({
      ...base,
      also: JSON.stringify([{ holdId: 13, textHash: 'x' }]),
    });
    expect(result).toMatchObject({
      success: true,
      others: [{ holdId: 13, ok: false, error: expect.any(String) }],
    });
  });

  it('lists each other hold once, and never the primary, when the batch call throws', async () => {
    decideOwnerHolds.mockRejectedValue(new Error('boom'));
    const result = await decide({
      ...base,
      also: JSON.stringify([
        { holdId: 12, textHash: 'abc' },
        { holdId: 13, textHash: 'x' },
        { holdId: 13, textHash: 'x' },
      ]),
    });
    expect((result.others as { holdId: number }[]).map((o) => o.holdId)).toEqual([13]);
  });
});
