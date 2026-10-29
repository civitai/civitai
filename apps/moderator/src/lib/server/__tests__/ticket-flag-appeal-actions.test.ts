import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));

const { createTicketFlagAppealActions } = await import('../tickets/appeal-flag-write');

const linkedUser = vi.fn();
const canAct = vi.fn();
const appealOf = vi.fn();
const ruleAppeal = vi.fn();
const note = vi.fn();

const actions = createTicketFlagAppealActions({
  linkedUser: (...a) => linkedUser(...a),
  canAct: (...a) => canAct(...a),
  appealOf: (...a) => appealOf(...a),
  ruleAppeal: (...a) => ruleAppeal(...a),
  note: (...a) => note(...a),
});

const run = (fields: Record<string, string> = {}) => {
  const form = new FormData();
  for (const [k, v] of Object.entries({
    ticketId: '5',
    userId: '7',
    appealId: '12',
    status: 'Rejected',
    resolvedReason: 'flag-confirmed',
    ...fields,
  }))
    form.set(k, v);
  return actions.appealResolveModelFlag({
    request: new Request('https://x.test/tickets/moderation', { method: 'POST', body: form }),
    locals: { user: { id: 4, username: 'alice' }, grants: {} },
  } as never);
};

const row = (over: Record<string, unknown> = {}) => ({
  userId: 7,
  status: 'Pending',
  entityType: 'Model',
  entityId: 300,
  entityRemovedAt: null,
  category: null,
  ...over,
});

beforeEach(() => {
  linkedUser.mockReset().mockResolvedValue({ status: 'ok', userId: 7 });
  canAct.mockReset().mockReturnValue(true);
  // Pending when the action loads it, decided once the ruling has been made.
  let reads = 0;
  appealOf
    .mockReset()
    .mockImplementation(async () => row(reads++ === 0 ? {} : { status: 'Rejected' }));
  ruleAppeal.mockReset().mockResolvedValue({ ok: true, rescanQueued: false });
  note.mockReset().mockResolvedValue({ status: 'ok' });
});

describe('appealResolveModelFlag', () => {
  it('upholds under the flag-appeals grant with the row’s model, and notes the moderator', async () => {
    expect(await run()).toEqual({ success: true, rescanQueued: false });
    expect(canAct).toHaveBeenCalledWith(expect.anything(), '/models/flags/appeals');
    expect(ruleAppeal).toHaveBeenCalledExactlyOnceWith({
      modelId: 300,
      decision: 'uphold',
      reason: { resolvedReason: 'flag-confirmed', internalNotes: undefined },
    });
    expect(note.mock.calls[0][0]).toBe('5');
    expect(note.mock.calls[0][1]).toContain('alice');
    expect(note.mock.calls[0][1]).toContain('appeal #12');
    expect(note.mock.calls[0][1]).toContain('model 300');
  });

  it('overturns an Approved ruling', async () => {
    await run({ status: 'Approved', resolvedReason: 'not-a-minor', internalNotes: 'why' });
    expect(ruleAppeal).toHaveBeenCalledWith({
      modelId: 300,
      decision: 'overturn',
      reason: { resolvedReason: 'not-a-minor', internalNotes: 'why' },
    });
  });

  it.each([
    ['liftPoi', { minor: 'uphold', poi: 'overturn' }],
    ['liftMinor', { minor: 'overturn', poi: 'uphold' }],
  ])('rules the labels of a %s split', async (ruling, decision) => {
    await run({ status: 'Approved', ruling, resolvedReason: 'not-a-real-person' });
    expect(ruleAppeal).toHaveBeenCalledWith(expect.objectContaining({ modelId: 300, decision }));
  });

  it('treats an empty ruling field as no split', async () => {
    expect(await run({ status: 'Rejected', ruling: '' })).toEqual({
      success: true,
      rescanQueued: false,
    });
    expect(ruleAppeal).toHaveBeenCalledWith(expect.objectContaining({ decision: 'uphold' }));
  });

  it('warns, and never names the posted appeal as decided, when it is still pending afterwards', async () => {
    appealOf.mockResolvedValue(row());
    const res = (await run()) as { success: boolean; warning: string };
    expect(res.success).toBe(true);
    expect(res.warning).toContain('#12 is still pending');
    expect(res.warning).toContain('another appeal');
    const text = note.mock.calls[0][1] as string;
    expect(text).toContain('another appeal on model 300');
    expect(text).toContain('appeal #12 of user 7 is still pending');
    expect(text).not.toMatch(/Rejected model flag appeal #12/);
  });

  it('refuses a split that is not an Approved ruling', async () => {
    expect(await run({ status: 'Rejected', ruling: 'liftPoi' })).toMatchObject({ status: 400 });
    expect(ruleAppeal).not.toHaveBeenCalled();
  });

  it('uses the row’s model, never a posted modelId', async () => {
    await run({ modelId: '999', entityId: '999' });
    expect(ruleAppeal).toHaveBeenCalledWith(expect.objectContaining({ modelId: 300 }));
  });

  it('reports a rescan, and a made ruling is not failed by a failed note', async () => {
    ruleAppeal.mockResolvedValue({ ok: true, rescanQueued: true });
    note.mockRejectedValue(new Error('offline'));
    const res = (await run()) as { success: boolean; rescanQueued: boolean; warning: string };
    expect(res.success).toBe(true);
    expect(res.rescanQueued).toBe(true);
    expect(res.warning).toContain('scanned again');
    expect(res.warning).toContain('offline');
  });

  it('surfaces the ruling’s own refusal and leaves no note', async () => {
    ruleAppeal.mockResolvedValue({ ok: false, error: 'Pick a reason.' });
    expect(await run()).toMatchObject({ status: 400, data: { error: 'Pick a reason.' } });
    expect(note).not.toHaveBeenCalled();
  });

  const refusals: [string, () => void, number][] = [
    ['a viewer without the flag-appeals grant', () => canAct.mockReturnValue(false), 403],
    ['an appeal that does not exist', () => appealOf.mockResolvedValue(null), 404],
    ['another user’s appeal', () => appealOf.mockResolvedValue(row({ userId: 8 })), 409],
    [
      'an appeal already decided',
      () => appealOf.mockResolvedValue(row({ status: 'Approved' })),
      409,
    ],
    ['an image appeal', () => appealOf.mockResolvedValue(row({ entityType: 'Image' })), 409],
    ['a site-form model appeal', () => appealOf.mockResolvedValue(row({ category: 'Model' })), 409],
    [
      'a removed-content appeal',
      () => appealOf.mockResolvedValue(row({ entityRemovedAt: new Date() })),
      409,
    ],
    [
      'a ticket that no longer qualifies',
      () => linkedUser.mockResolvedValue({ status: 'refused', code: 409, message: 'moved' }),
      409,
    ],
    [
      'a form user other than the ticket-linked one',
      () => linkedUser.mockResolvedValue({ status: 'ok', userId: 99 }),
      409,
    ],
  ];
  it.each(refusals)('refuses %s and changes nothing', async (_n, arrange, status) => {
    arrange();
    expect(await run()).toMatchObject({ status });
    expect(ruleAppeal).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
  });

  it('checks the grant before reading anything', async () => {
    canAct.mockReturnValue(false);
    await run();
    expect(linkedUser).not.toHaveBeenCalled();
    expect(appealOf).not.toHaveBeenCalled();
  });
});
