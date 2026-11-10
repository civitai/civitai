import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));

const { createTicketGeneratorActions } = await import('../tickets/generator-write');

const linkedUser = vi.fn();
const canAct = vi.fn();
const resolveRestriction = vi.fn();
const restrictionOf = vi.fn();
const note = vi.fn();

const actions = createTicketGeneratorActions({
  linkedUser: (...a) => linkedUser(...a),
  canAct: (...a) => canAct(...a),
  resolveRestriction: (...a) => resolveRestriction(...a),
  restrictionOf: (...a) => restrictionOf(...a),
  note: (...a) => note(...a),
});

const FIELDS = {
  ticketId: '5',
  userId: '7',
  userRestrictionId: '3',
  status: 'Overturned',
  resolvedReason: 'remix-source',
};

const run = (fields: Record<string, string> = {}) => {
  const form = new FormData();
  for (const [k, v] of Object.entries({ ...FIELDS, ...fields })) form.set(k, v);
  return actions.generatorResolveRestriction({
    request: new Request('https://x.test/tickets/support', { method: 'POST', body: form }),
    locals: { user: { id: 4, username: 'alice' }, grants: {} },
  } as never);
};

beforeEach(() => {
  linkedUser.mockReset().mockResolvedValue({ status: 'ok', userId: 7 });
  canAct.mockReset().mockReturnValue(true);
  resolveRestriction.mockReset().mockResolvedValue({ ok: true });
  restrictionOf.mockReset().mockResolvedValue({ userId: 7, type: 'generation', status: 'Pending' });
  note.mockReset().mockResolvedValue({ status: 'ok' });
});

describe('generatorResolveRestriction', () => {
  it('is gated on the generator restrictions page grant, before anything is read', async () => {
    canAct.mockReturnValue(false);
    expect(await run()).toMatchObject({ status: 403 });
    expect(canAct).toHaveBeenCalledWith(expect.anything(), '/audit/generator-restrictions');
    expect(linkedUser).not.toHaveBeenCalled();
    expect(resolveRestriction).not.toHaveBeenCalled();
  });

  it('refuses a malformed form with 400 and a ticket that moved views with its refusal', async () => {
    expect(await run({ status: 'Maybe' })).toMatchObject({ status: 400 });
    linkedUser.mockResolvedValue({ status: 'refused', code: 409, message: 'moved' });
    expect(await run()).toMatchObject({ status: 409 });
    expect(resolveRestriction).not.toHaveBeenCalled();
  });

  it('refuses a userId other than the ticket-linked one', async () => {
    expect(await run({ userId: '99' })).toMatchObject({ status: 409 });
    expect(resolveRestriction).not.toHaveBeenCalled();
  });

  it('refuses a restriction of another account, a resolved one and an unknown one', async () => {
    restrictionOf.mockResolvedValueOnce({ userId: 8, type: 'generation', status: 'Pending' });
    expect(await run()).toMatchObject({ status: 409 });
    restrictionOf.mockResolvedValueOnce({ userId: 7, type: 'generation', status: 'Upheld' });
    expect(await run()).toMatchObject({ status: 409 });
    restrictionOf.mockResolvedValueOnce(null);
    expect(await run()).toMatchObject({ status: 404 });
    expect(resolveRestriction).not.toHaveBeenCalled();
  });

  it('does not reach a scam restriction, which belongs to another page', async () => {
    restrictionOf.mockResolvedValue({ userId: 7, type: 'scam', status: 'Pending' });
    expect(await run()).toMatchObject({ status: 404 });
    expect(resolveRestriction).not.toHaveBeenCalled();
  });

  it('refuses a type with no verdict path', async () => {
    restrictionOf.mockResolvedValue({ userId: 7, type: 'bot-account', status: 'Pending' });
    expect(await run()).toMatchObject({ status: 400 });
    expect(resolveRestriction).not.toHaveBeenCalled();
  });

  it('rules with the row’s ids, attributed to the moderator, and notes the ticket', async () => {
    expect(await run({ internalNotes: 'checked' })).toEqual({ success: true });
    expect(resolveRestriction).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        userRestrictionId: 3,
        status: 'Overturned',
        userId: 7,
        moderatorId: 4,
        internalNotes: 'checked',
      })
    );
    expect(note.mock.calls[0][0]).toBe('5');
    expect(note.mock.calls[0][1]).toContain('Overturned restriction #3');
  });

  it('treats a failed ruling as a failure and writes no note', async () => {
    resolveRestriction.mockResolvedValue({ ok: false, error: 'already resolved' });
    expect(await run()).toMatchObject({ status: 400, data: { error: 'already resolved' } });
    expect(note).not.toHaveBeenCalled();
  });

  it('keeps a failed note as a warning on a success', async () => {
    note.mockResolvedValue({ status: 'error', httpStatus: 500, certain: true, message: 'boom' });
    expect(await run()).toMatchObject({ success: true, warning: expect.stringContaining('boom') });
  });
});
