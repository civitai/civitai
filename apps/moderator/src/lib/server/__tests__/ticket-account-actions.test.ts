import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));

const { createTicketAccountActions } = await import('../tickets/account-write');

const linkedUser = vi.fn();
const setBanned = vi.fn();
const setMuted = vi.fn();
const revokeTimedMute = vi.fn();
const resolveRestriction = vi.fn();
const restrictionOf = vi.fn();
const note = vi.fn();
const canAct = vi.fn();

const actions = createTicketAccountActions({
  linkedUser: (...a) => linkedUser(...a),
  inner: { setBanned: (...a) => setBanned(...a), setMuted: (...a) => setMuted(...a) },
  canAct: (...a) => canAct(...a),
  revokeTimedMute: (...a) => revokeTimedMute(...a),
  resolveRestriction: (...a) => resolveRestriction(...a),
  restrictionOf: (...a) => restrictionOf(...a),
  note: (...a) => note(...a),
});

const run = async (action: keyof typeof actions, fields: Record<string, string>) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return actions[action]({
    request: new Request('https://x.test/tickets/moderation', { method: 'POST', body: form }),
    locals: { user: { id: 4, username: 'alice' }, grants: {} },
  } as never);
};

const innerForm = async (call: unknown[]) =>
  Object.fromEntries(await (call[0] as { request: Request }).request.formData());

const writes = () =>
  [setBanned, setMuted, revokeTimedMute, resolveRestriction].flatMap((f) => f.mock.calls);

beforeEach(() => {
  linkedUser.mockReset().mockResolvedValue({ status: 'ok', userId: 7 });
  setBanned.mockReset().mockResolvedValue({ success: true });
  setMuted.mockReset().mockResolvedValue({ success: true });
  revokeTimedMute.mockReset().mockResolvedValue({ ok: true });
  resolveRestriction.mockReset().mockResolvedValue({ ok: true });
  restrictionOf.mockReset().mockResolvedValue({ userId: 7, type: 'generation', status: 'Pending' });
  note.mockReset().mockResolvedValue({ status: 'ok' });
  canAct.mockReset().mockReturnValue(true);
});

const CASES = [
  ['accountUnban', {}],
  ['accountUnmute', {}],
  ['accountLiftTimedMute', {}],
  [
    'accountResolveRestriction',
    { userRestrictionId: '3', status: 'Overturned', resolvedReason: 'remix-source' },
  ],
] as const;

describe.each(CASES)('%s', (action, extra) => {
  it('refuses a userId other than the ticket-linked one and acts on nobody', async () => {
    const res = await run(action, { ticketId: '5', userId: '99', ...extra });
    expect(res).toMatchObject({ status: 409 });
    expect(writes()).toEqual([]);
    expect(note).not.toHaveBeenCalled();
  });

  it('refuses a ticket with no linked user', async () => {
    linkedUser.mockResolvedValue({ status: 'ok', userId: null });
    expect(await run(action, { ticketId: '5', userId: '7', ...extra })).toMatchObject({
      status: 409,
    });
    expect(writes()).toEqual([]);
  });

  it('passes on the refusal of a ticket that cannot be acted on', async () => {
    linkedUser.mockResolvedValue({
      status: 'refused',
      code: 503,
      message: 'Could not check the ticket.',
    });
    expect(await run(action, { ticketId: '5', userId: '7', ...extra })).toMatchObject({
      status: 503,
    });
    expect(writes()).toEqual([]);
  });

  it('refuses a missing or malformed id before reading the ticket', async () => {
    expect(await run(action, { ticketId: '5', userId: 'abc', ...extra })).toMatchObject({
      status: 400,
    });
    expect(await run(action, { userId: '7', ...extra })).toMatchObject({ status: 400 });
    expect(linkedUser).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });
});

describe('the account the action reaches', () => {
  it('unban posts ban=false for the linked user, whatever else the form says', async () => {
    const res = await run('accountUnban', { ticketId: '5', userId: '7', ban: 'true' });
    expect(res).toMatchObject({ success: true });
    expect(await innerForm(setBanned.mock.calls[0])).toEqual({ userId: '7', ban: 'false' });
  });

  it('unmute posts muted=false for the linked user', async () => {
    await run('accountUnmute', { ticketId: '5', userId: '7', muted: 'true' });
    expect(await innerForm(setMuted.mock.calls[0])).toEqual({ userId: '7', muted: 'false' });
  });

  it('refuses a restriction that belongs to another account', async () => {
    restrictionOf.mockResolvedValue({ userId: 8, type: 'generation', status: 'Pending' });
    const res = await run('accountResolveRestriction', {
      ticketId: '5',
      userId: '7',
      userRestrictionId: '3',
      status: 'Overturned',
      resolvedReason: 'remix-source',
    });
    expect(res).toMatchObject({ status: 409 });
    expect(resolveRestriction).not.toHaveBeenCalled();
  });

  it('refuses a resolved restriction, an unknown one and a type with no rulings', async () => {
    const fields = {
      ticketId: '5',
      userId: '7',
      userRestrictionId: '3',
      status: 'Overturned',
      resolvedReason: 'remix-source',
    };
    restrictionOf.mockResolvedValueOnce({ userId: 7, type: 'generation', status: 'Upheld' });
    expect(await run('accountResolveRestriction', fields)).toMatchObject({ status: 409 });
    restrictionOf.mockResolvedValueOnce(null);
    expect(await run('accountResolveRestriction', fields)).toMatchObject({ status: 404 });
    restrictionOf.mockResolvedValueOnce({ userId: 7, type: 'bot-account', status: 'Pending' });
    expect(await run('accountResolveRestriction', fields)).toMatchObject({ status: 400 });
    expect(resolveRestriction).not.toHaveBeenCalled();
  });

  it('rules with the reason checked, attributed to the signed-in moderator', async () => {
    await run('accountResolveRestriction', {
      ticketId: '5',
      userId: '7',
      userRestrictionId: '3',
      status: 'Overturned',
      resolvedReason: 'remix-source',
    });
    expect(resolveRestriction).toHaveBeenCalledWith(
      expect.objectContaining({
        userRestrictionId: 3,
        status: 'Overturned',
        resolvedReason: 'remix-source',
        userId: 7,
        moderatorId: 4,
      })
    );
    const bad = await run('accountResolveRestriction', {
      ticketId: '5',
      userId: '7',
      userRestrictionId: '3',
      status: 'Overturned',
      resolvedReason: 'not-a-reason',
    });
    expect(bad).toMatchObject({ status: 400 });
    expect(resolveRestriction).toHaveBeenCalledTimes(1);
  });

  it('keeps the page grant for lifting a timed mute and ruling', async () => {
    canAct.mockReturnValue(false);
    expect(await run('accountLiftTimedMute', { ticketId: '5', userId: '7' })).toMatchObject({
      status: 403,
    });
    expect(
      await run('accountResolveRestriction', {
        ticketId: '5',
        userId: '7',
        userRestrictionId: '3',
        status: 'Upheld',
        resolvedReason: 'x',
      })
    ).toMatchObject({ status: 403 });
    expect(linkedUser).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });
});

describe('the note on the ticket', () => {
  it('follows a successful change and names the moderator and the account', async () => {
    await run('accountUnban', { ticketId: '5', userId: '7' });
    expect(note).toHaveBeenCalledTimes(1);
    expect(note.mock.calls[0][0]).toBe('5');
    expect(note.mock.calls[0][1]).toContain('Unbanned user 7');
    expect(note.mock.calls[0][1]).toContain('alice (user 4)');
    expect(setBanned.mock.invocationCallOrder[0]).toBeLessThan(note.mock.invocationCallOrder[0]);
  });

  it('turns a failed note into a warning on a success', async () => {
    note.mockResolvedValue({ status: 'error', certain: true, message: 'Freshdesk said no' });
    const res = await run('accountLiftTimedMute', { ticketId: '5', userId: '7' });
    expect(res).toMatchObject({ success: true });
    expect((res as { warning?: string }).warning).toContain('Freshdesk said no');
  });

  it('warns when the write key is not configured', async () => {
    note.mockResolvedValue({ status: 'not_configured' });
    const res = await run('accountUnmute', { ticketId: '5', userId: '7' });
    expect(res).toMatchObject({ success: true });
    expect((res as { warning?: string }).warning).toBeTruthy();
  });

  it('is not written when the account change failed, and the failure is returned', async () => {
    revokeTimedMute.mockResolvedValue({ ok: false, error: 'No timed mute is in force.' });
    const res = await run('accountLiftTimedMute', { ticketId: '5', userId: '7' });
    expect(res).toMatchObject({ status: 400, data: { error: 'No timed mute is in force.' } });
    setBanned.mockResolvedValue({ status: 400, data: { error: 'Not permitted.' } });
    expect(await run('accountUnban', { ticketId: '5', userId: '7' })).toMatchObject({
      status: 400,
    });
    expect(note).not.toHaveBeenCalled();
  });
});
