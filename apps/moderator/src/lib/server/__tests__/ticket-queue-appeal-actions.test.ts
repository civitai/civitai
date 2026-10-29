import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));

const { createTicketQueueAppealActions } = await import('../tickets/appeal-queue-write');

const linkedUser = vi.fn();
const accountLinkedUser = vi.fn();
const canAct = vi.fn();
const appealOf = vi.fn();
const parseRemoved = vi.fn();
const resolveRemoved = vi.fn();
const resolveSite = vi.fn();
const note = vi.fn();

const actions = createTicketQueueAppealActions({
  linkedUser: (...a) => linkedUser(...a),
  accountLinkedUser: (...a) => accountLinkedUser(...a),
  canAct: (...a) => canAct(...a),
  appealOf: (...a) => appealOf(...a),
  parseRemoved: (...a) => parseRemoved(...a),
  resolveRemoved: (...a) => resolveRemoved(...a),
  resolveSite: (...a) => resolveSite(...a),
  note: (...a) => note(...a),
});

type Name = keyof typeof actions;

const run = (
  action: Name,
  fields: Record<string, string> = {},
  grants: Record<string, boolean> = {}
) => {
  const form = new FormData();
  for (const [k, v] of Object.entries({
    ticketId: '5',
    userId: '7',
    appealId: '12',
    status: 'Approved',
    resolvedReason: 'misclassified',
    ...fields,
  }))
    form.set(k, v);
  return actions[action]({
    request: new Request('https://x.test/tickets/moderation', { method: 'POST', body: form }),
    locals: { user: { id: 4, username: 'alice' }, grants },
  } as never);
};

const row = (over: Record<string, unknown> = {}) => ({
  userId: 7,
  status: 'Pending',
  entityType: 'Image',
  entityId: 100,
  entityRemovedAt: new Date('2026-10-01T00:00:00Z'),
  category: null,
  ...over,
});
const SITE_ROW = row({
  entityType: 'Article',
  entityId: 55,
  entityRemovedAt: null,
  category: 'Article',
});
const ACCOUNT_ROW = row({
  entityType: 'User',
  entityId: 7,
  entityRemovedAt: null,
  category: 'Account',
});

const writes = () => [resolveRemoved, resolveSite].flatMap((f) => f.mock.calls);

beforeEach(() => {
  linkedUser.mockReset().mockResolvedValue({ status: 'ok', userId: 7 });
  accountLinkedUser.mockReset().mockResolvedValue({ status: 'ok', userId: 7 });
  canAct.mockReset().mockReturnValue(true);
  appealOf.mockReset().mockResolvedValue(row());
  parseRemoved.mockReset().mockReturnValue({
    status: 'Approved',
    resolvedReason: 'misclassified',
    internalNotes: undefined,
    resolvedMessage: 'Sorry',
  });
  resolveRemoved.mockReset().mockResolvedValue({ refunded: true, refundFailed: false });
  resolveSite.mockReset().mockResolvedValue({ ok: true, lifted: [], restored: false });
  note.mockReset().mockResolvedValue({ status: 'ok' });
});

describe('appealResolveRemoved', () => {
  it('decides the appeal under the removed-content grant and notes the moderator', async () => {
    expect(await run('appealResolveRemoved')).toEqual({ success: true });
    expect(canAct).toHaveBeenCalledWith(expect.anything(), '/images/removed-appeals');
    expect(parseRemoved).toHaveBeenCalledWith(expect.any(FormData));
    expect(resolveRemoved).toHaveBeenCalledWith({
      appealId: 12,
      decision: 'Approved',
      resolvedReason: 'misclassified',
      internalNotes: undefined,
      resolvedMessage: 'Sorry',
      moderatorId: 4,
    });
    expect(note.mock.calls[0][0]).toBe('5');
    expect(note.mock.calls[0][1]).toContain('alice');
    expect(note.mock.calls[0][1]).toContain('Approved');
    expect(note.mock.calls[0][1]).toContain('appeal #12');
  });

  it('reports a failed fee refund as a warning, not a failure', async () => {
    resolveRemoved.mockResolvedValue({ refunded: false, refundFailed: true });
    expect(await run('appealResolveRemoved')).toMatchObject({
      success: true,
      warning: expect.stringContaining('refund'),
    });
    expect(note).toHaveBeenCalledTimes(1);
  });

  it('keeps the refund warning when the note also fails', async () => {
    resolveRemoved.mockResolvedValue({ refunded: false, refundFailed: true });
    note.mockRejectedValue(new Error('offline'));
    const res = (await run('appealResolveRemoved')) as { warning: string };
    expect(res.warning).toContain('refund');
    expect(res.warning).toContain('offline');
  });

  const refusals: [string, () => void, number][] = [
    ['a viewer without the removed-appeals grant', () => canAct.mockReturnValue(false), 403],
    ['an appeal that does not exist', () => appealOf.mockResolvedValue(null), 404],
    ['another user’s appeal', () => appealOf.mockResolvedValue(row({ userId: 8 })), 409],
    [
      'an appeal already decided',
      () => appealOf.mockResolvedValue(row({ status: 'Rejected' })),
      409,
    ],
    [
      'an appeal whose content was not removed',
      () => appealOf.mockResolvedValue(row({ entityRemovedAt: null })),
      409,
    ],
    ['a site-form appeal', () => appealOf.mockResolvedValue(SITE_ROW), 409],
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
    [
      'a reason that does not fit the verdict',
      () => parseRemoved.mockReturnValue('Pick a reason.'),
      400,
    ],
  ];
  it.each(refusals)('refuses %s and decides nothing', async (_n, arrange, code) => {
    arrange();
    expect(await run('appealResolveRemoved')).toMatchObject({ status: code });
    expect(writes()).toEqual([]);
    expect(note).not.toHaveBeenCalled();
  });

  it('answers "already decided" when the service finds nothing pending, with no note', async () => {
    resolveRemoved.mockResolvedValue(null);
    expect(await run('appealResolveRemoved')).toMatchObject({ status: 409 });
    expect(note).not.toHaveBeenCalled();
  });

  it('refuses a malformed appeal id before reading the ticket', async () => {
    expect(await run('appealResolveRemoved', { appealId: 'x' })).toMatchObject({ status: 400 });
    expect(linkedUser).not.toHaveBeenCalled();
  });
});

describe('appealCloseRemoved', () => {
  it('closes a removed appeal as deleted by its owner without reading a reason', async () => {
    expect(await run('appealCloseRemoved', { status: '' })).toEqual({ success: true });
    expect(parseRemoved).not.toHaveBeenCalled();
    expect(resolveRemoved).toHaveBeenCalledWith({
      appealId: 12,
      decision: 'OwnerDeleted',
      moderatorId: 4,
    });
    expect(note.mock.calls[0][1]).toContain('deleted by owner');
  });

  it('refuses without the grant, for another user’s appeal and for a non-removed one', async () => {
    canAct.mockReturnValue(false);
    expect(await run('appealCloseRemoved')).toMatchObject({ status: 403 });
    canAct.mockReturnValue(true);
    appealOf.mockResolvedValue(row({ userId: 8 }));
    expect(await run('appealCloseRemoved')).toMatchObject({ status: 409 });
    appealOf.mockResolvedValue(SITE_ROW);
    expect(await run('appealCloseRemoved')).toMatchObject({ status: 409 });
    expect(resolveRemoved).not.toHaveBeenCalled();
  });
});

describe('appealResolveSite', () => {
  beforeEach(() => appealOf.mockResolvedValue(SITE_ROW));

  it('decides with the ROW’s category under that category’s queue grant, with the Ban permission from the session', async () => {
    const res = await run(
      'appealResolveSite',
      { resolvedMessage: ' We restored it ', category: 'Model' },
      { 'user.ban': true }
    );
    expect(res).toEqual({ success: true });
    expect(canAct).toHaveBeenCalledWith(expect.anything(), '/appeals/articles');
    expect(resolveSite).toHaveBeenCalledWith({
      appealId: 12,
      category: 'Article',
      decision: 'Approved',
      resolvedReason: 'misclassified',
      internalNotes: undefined,
      resolvedMessage: 'We restored it',
      moderatorId: 4,
      canBan: true,
    });
    expect(note.mock.calls[0][1]).toContain('Article appeal #12');
  });

  it('passes canBan false without the Ban permission', async () => {
    await run('appealResolveSite');
    expect(resolveSite).toHaveBeenCalledWith(expect.objectContaining({ canBan: false }));
  });

  it('leaves a message empty as undefined', async () => {
    await run('appealResolveSite', { resolvedMessage: '  ' });
    expect(resolveSite.mock.calls[0][0].resolvedMessage).toBeUndefined();
  });

  it('notes what an approval lifted', async () => {
    resolveSite.mockResolvedValue({ ok: true, lifted: ['article'], restored: true });
    await run('appealResolveSite');
    expect(note.mock.calls[0][1]).toContain('article');
  });

  const refusals: [string, () => void, number][] = [
    ['a viewer holding no site-appeal grant', () => canAct.mockReturnValue(false), 403],
    [
      'a viewer lacking this category’s grant',
      () => canAct.mockImplementation((_u, p: string) => p !== '/appeals/articles'),
      403,
    ],
    ['an appeal that does not exist', () => appealOf.mockResolvedValue(null), 404],
    ['another user’s appeal', () => appealOf.mockResolvedValue({ ...SITE_ROW, userId: 8 }), 409],
    [
      'an appeal already decided',
      () => appealOf.mockResolvedValue({ ...SITE_ROW, status: 'Approved' }),
      409,
    ],
    ['an image appeal', () => appealOf.mockResolvedValue(row({ entityRemovedAt: null })), 409],
    [
      'a removed-content appeal',
      () => appealOf.mockResolvedValue({ ...SITE_ROW, entityRemovedAt: new Date() }),
      409,
    ],
    [
      'an Account appeal, which the Account card decides',
      () => appealOf.mockResolvedValue(ACCOUNT_ROW),
      409,
    ],
    [
      'a ticket that no longer qualifies',
      () => linkedUser.mockResolvedValue({ status: 'refused', code: 409, message: 'moved' }),
      409,
    ],
    ['a reason that does not fit the verdict', () => void 0, 400],
  ];
  it.each(refusals)('refuses %s and decides nothing', async (name, arrange, code) => {
    arrange();
    const res = await run(
      'appealResolveSite',
      name.startsWith('a reason') ? { resolvedReason: '' } : {}
    );
    expect(res).toMatchObject({ status: code });
    expect(writes()).toEqual([]);
    expect(note).not.toHaveBeenCalled();
  });

  it('turns the service’s conflict into 409 and its other refusals into 400, with no note', async () => {
    resolveSite.mockResolvedValue({ ok: false, error: 'Decided.', conflict: true });
    expect(await run('appealResolveSite')).toMatchObject({
      status: 409,
      data: { error: 'Decided.' },
    });
    resolveSite.mockResolvedValue({ ok: false, error: 'Needs ban.' });
    expect(await run('appealResolveSite')).toMatchObject({
      status: 400,
      data: { error: 'Needs ban.' },
    });
    expect(note).not.toHaveBeenCalled();
  });

  it('warns, without failing, when the note could not be left', async () => {
    note.mockResolvedValue({ status: 'error', httpStatus: 500, certain: true, message: 'boom' });
    expect(await run('appealResolveSite')).toMatchObject({
      success: true,
      warning: expect.stringContaining('boom'),
    });
  });
});

describe('appealResolveAccount', () => {
  beforeEach(() => appealOf.mockResolvedValue(ACCOUNT_ROW));

  it('decides the Account appeal under /appeals/account, checking the ticket as an account ticket', async () => {
    expect(await run('appealResolveAccount', {}, { 'user.ban': true })).toEqual({ success: true });
    expect(accountLinkedUser).toHaveBeenCalledWith('5');
    expect(linkedUser).not.toHaveBeenCalled();
    expect(canAct).toHaveBeenCalledWith(expect.anything(), '/appeals/account');
    expect(resolveSite).toHaveBeenCalledWith(
      expect.objectContaining({
        appealId: 12,
        category: 'Account',
        decision: 'Approved',
        canBan: true,
      })
    );
    expect(note.mock.calls[0][1]).toContain('Account appeal #12');
  });

  it('leaves the lift to the service: a refusal for a missing Ban permission is a 400 and writes no note', async () => {
    resolveSite.mockResolvedValue({ ok: false, error: 'Needs the Ban permission.' });
    expect(await run('appealResolveAccount')).toMatchObject({ status: 400 });
    expect(note).not.toHaveBeenCalled();
  });

  const refusals: [string, () => void, number][] = [
    ['a viewer without /appeals/account', () => canAct.mockReturnValue(false), 403],
    ['an Article appeal', () => appealOf.mockResolvedValue(SITE_ROW), 409],
    ['another user’s appeal', () => appealOf.mockResolvedValue({ ...ACCOUNT_ROW, userId: 8 }), 409],
    [
      'an appeal already decided',
      () => appealOf.mockResolvedValue({ ...ACCOUNT_ROW, status: 'Rejected' }),
      409,
    ],
    [
      'a ticket that is not an account ticket',
      () => accountLinkedUser.mockResolvedValue({ status: 'refused', code: 409, message: 'no' }),
      409,
    ],
  ];
  it.each(refusals)('refuses %s and decides nothing', async (_n, arrange, code) => {
    arrange();
    expect(await run('appealResolveAccount')).toMatchObject({ status: code });
    expect(writes()).toEqual([]);
    expect(note).not.toHaveBeenCalled();
  });
});
