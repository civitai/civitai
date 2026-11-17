import { beforeEach, describe, expect, it, vi } from 'vitest';

const replyToTicket = vi.fn();
const addPrivateNote = vi.fn();
const setTicketStatus = vi.fn();
const updateTicket = vi.fn();
const getTicketDetail = vi.fn();
const resolveTicketView = vi.fn();
const patch = vi.fn();
const callModEndpoint = vi.fn();

// The real rule, minus the denial text: the grant on `locals` decides.
vi.mock('$lib/server/access', () => ({
  requiresGrant:
    (id: string, handler: (e: { locals: { grants: Record<string, boolean> } }) => unknown) =>
    (e: { locals: { grants: Record<string, boolean> } }) =>
      e.locals.grants[id] ? handler(e) : { status: 403, data: { error: `denied ${id}` } },
}));

const ALL_GRANTS = {
  'tickets.reply': true,
  'tickets.escalate': true,
  'tickets.privacy': true,
};
vi.mock('../freshdesk-write.service', () => ({
  replyToTicket: (...a: unknown[]) => replyToTicket(...a),
  addPrivateNote: (...a: unknown[]) => addPrivateNote(...a),
  setTicketStatus: (...a: unknown[]) => setTicketStatus(...a),
  updateTicket: (...a: unknown[]) => updateTicket(...a),
}));
vi.mock('../freshdesk.service', () => ({
  getTicketDetail: (...a: unknown[]) => getTicketDetail(...a),
  isFreshdeskId: (v: string) => /^\d+$/.test(v),
}));
vi.mock('$lib/server/user-actions.service', () => ({
  callModEndpoint: (...a: unknown[]) => callModEndpoint(...a),
}));
vi.mock('../mod-activity', () => ({ recordModActivity: async () => {} }));
vi.mock('../tickets/detail', () => ({
  resolveTicketView: (...a: unknown[]) => resolveTicketView(...a),
}));
vi.mock('../tickets/snapshot', () => ({
  ticketSnapshot: { patch: (...a: unknown[]) => patch(...a) },
  toRecord: (t: unknown) => t,
}));

const { ticketActions } = await import('../tickets/actions');

const ticket = { id: '5', status: 2, cfFeature: 'Moderation Decision', tags: [] as string[] };

const run = async (
  view: 'moderation' | 'support',
  action: 'reply' | 'status' | 'escalate' | 'fileBug' | 'privacy' | 'modLead',
  fields: Record<string, string>,
  grants: Record<string, boolean> = ALL_GRANTS
) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const event = {
    request: new Request('https://x.test/tickets', { method: 'POST', body: form }),
    locals: { user: { id: 4, username: 'alice' }, grants },
    url: new URL('https://mod.test/tickets/moderation'),
  };
  const handler = ticketActions(view)[action] as unknown as (e: typeof event) => Promise<unknown>;
  return handler(event);
};

const writes = () =>
  [replyToTicket, addPrivateNote, setTicketStatus, updateTicket, callModEndpoint].flatMap(
    (f) => f.mock.calls
  );

beforeEach(() => {
  for (const f of [replyToTicket, addPrivateNote, setTicketStatus, updateTicket])
    f.mockReset().mockResolvedValue({ status: 'ok' });
  getTicketDetail.mockReset().mockResolvedValue({ status: 'found', ticket });
  resolveTicketView.mockReset().mockResolvedValue({ routesTo: 'moderation', routed: undefined });
  patch.mockReset().mockResolvedValue(undefined);
  callModEndpoint.mockReset().mockResolvedValue({ ok: true, body: { id: 41, hqUrl: null } });
});

const BODY = { body: 'hello' };
const CASES = [
  ['reply', BODY],
  ['status', { status: '3' }],
  ['escalate', {}],
  ['fileBug', { reason: 'Buttons overlap' }],
  ['privacy', {}],
  ['modLead', {}],
] as const;

describe.each(CASES)('the %s action and its ticketId field', (action, fields) => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not a number', 'abc'],
    ['carrying more than digits', '5; DROP'],
  ])('refuses a %s id with 404 and writes nothing', async (_name, id) => {
    const res = await run(
      'moderation',
      action,
      id === undefined ? fields : { ...fields, ticketId: id }
    );
    expect(res).toMatchObject({ status: 404 });
    expect(getTicketDetail).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  it('refuses a ticket that belongs to the other view with 409 and writes nothing', async () => {
    resolveTicketView.mockResolvedValue({ routesTo: 'support', routed: undefined });
    const res = await run('moderation', action, { ...fields, ticketId: '5' });
    expect(res).toMatchObject({ status: 409 });
    expect(writes()).toEqual([]);
  });

  it('refuses with 503 and writes nothing when the ticket cannot be read', async () => {
    getTicketDetail.mockResolvedValue({ status: 'unavailable', reason: 'rate limited' });
    const res = await run('moderation', action, { ...fields, ticketId: '5' });
    expect(res).toMatchObject({ status: 503 });
    expect(writes()).toEqual([]);
  });

  it('acts on the ticket named in the form when it belongs to the view', async () => {
    const res = await run('moderation', action, { ...fields, ticketId: '5' });
    expect(res).toMatchObject({ success: true });
    expect(getTicketDetail).toHaveBeenCalledWith('5');
    expect(writes().length).toBeGreaterThan(0);
    expect(
      writes().every(([id, body]) => id === '5' || (body as { ticketId?: number })?.ticketId === 5)
    ).toBe(true);
  });
});

describe('the actions of the support view', () => {
  it('has no escalate action', () => {
    expect(ticketActions('support').escalate).toBeUndefined();
  });

  it('refuses a ticket that now routes to the moderation view', async () => {
    resolveTicketView.mockResolvedValue({ routesTo: 'moderation', routed: undefined });
    expect(await run('support', 'reply', { ...BODY, ticketId: '5' })).toMatchObject({
      status: 409,
    });
    expect(writes()).toEqual([]);
  });
});

describe('whether a reply changed the status', () => {
  const reply = (statusAfter: string) =>
    run('moderation', 'reply', { ...BODY, ticketId: '5', statusAfter });

  it('reports a requested status that landed', async () => {
    expect(await reply('4')).toMatchObject({ success: true, statusChanged: true });
  });

  it('reports a requested status that failed, so the page does not claim it', async () => {
    setTicketStatus.mockResolvedValue({ status: 'error', message: 'Freshdesk said no' });
    expect(await reply('4')).toMatchObject({ success: true, statusChanged: false });
  });

  it('reports no change when none was requested', async () => {
    expect(await reply('')).toMatchObject({ statusChanged: false });
  });
});

describe('whether a status-only action changed the status', () => {
  const setStatus = () => run('moderation', 'status', { ticketId: '5', status: '3' });

  it('reports a status that landed', async () => {
    expect(await setStatus()).toMatchObject({ success: true, statusChanged: true });
  });

  it('refuses without claiming a change when Freshdesk certainly rejected it', async () => {
    setTicketStatus.mockResolvedValue({ status: 'error', certain: true, message: 'no' });
    const res = await setStatus();
    expect(res).toMatchObject({ status: 502 });
    expect(JSON.stringify(res)).not.toContain('statusChanged');
  });

  it('refuses without claiming a change when the outcome is uncertain', async () => {
    setTicketStatus.mockResolvedValue({ status: 'error', certain: false, message: 'timeout' });
    const res = await setStatus();
    expect(res).toMatchObject({ status: 502 });
    expect(JSON.stringify(res)).toContain('may or may not');
    expect(JSON.stringify(res)).not.toContain('statusChanged');
  });
});

describe('the hand-off routes', () => {
  it('refuses Privacy while its grant is off (it ships dark), even with every other ticket grant', async () => {
    const res = await run(
      'moderation',
      'privacy',
      { ticketId: '5' },
      { 'tickets.reply': true, 'tickets.escalate': true }
    );
    expect(res).toMatchObject({ status: 403 });
    expect(getTicketDetail).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  it.each([
    ['the reply permission, because it emails the requester', 'tickets.reply'],
    ['the hand-off permission', 'tickets.escalate'],
  ])('refuses Privacy without %s', async (_why, missing) => {
    const grants = { 'tickets.privacy': true, 'tickets.reply': true, 'tickets.escalate': true };
    const res = await run(
      'moderation',
      'privacy',
      { ticketId: '5' },
      { ...grants, [missing]: false }
    );
    expect(res).toMatchObject({ status: 403 });
    expect(getTicketDetail).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  it("sends Legal's acknowledgment verbatim, signed, and moves the ticket out of both views", async () => {
    const res = await run('moderation', 'privacy', { ticketId: '5' });
    expect(res).toMatchObject({ success: true, moved: 'legal' });
    expect(replyToTicket).toHaveBeenCalledTimes(1);
    const html = replyToTicket.mock.calls[0][1] as string;
    expect(html).toContain(
      'Thanks for your request. We&#39;ve passed it to our privacy team, and we&#39;ll reply to this email.'
    );
    expect(html).toContain('Civitai Support');
  });

  it('refuses a bug report with no note and files nothing', async () => {
    const res = await run('moderation', 'fileBug', { ticketId: '5', reason: '  ' });
    expect(res).toMatchObject({ status: 400 });
    expect(writes()).toEqual([]);
  });

  it('files the bug through the main app as the moderator, naming the ticket', async () => {
    await run('moderation', 'fileBug', { ticketId: '5', reason: 'Buttons overlap' });
    expect(callModEndpoint).toHaveBeenCalledWith(
      'feedback/ticket-bug',
      { ticketId: 5, message: 'Freshdesk ticket #5\n\nButtons overlap' },
      expect.any(String)
    );
    expect(updateTicket).not.toHaveBeenCalled();
    expect(setTicketStatus).not.toHaveBeenCalled();
  });

  it.each([
    ['a refusal (4xx)', { ok: false, status: 400, error: 'bad' }, 'NOT filed'],
    [
      'a request that never left',
      { ok: false, requestNeverSent: true, error: 'down' },
      'NOT filed',
    ],
    ['a 5xx', { ok: false, status: 500, error: 'boom' }, 'may or may not'],
    ['a timeout', { ok: false, error: 'timed out' }, 'may or may not'],
    ['a success with no report id', { ok: true, body: {} }, 'may or may not'],
    ['a success with an invalid report id', { ok: true, body: { id: 'x' } }, 'may or may not'],
  ])('after %s, says whether the bug report was filed', async (_case, answer, says) => {
    callModEndpoint.mockResolvedValue(answer);
    const res = await run('moderation', 'fileBug', { ticketId: '5', reason: 'Buttons overlap' });
    expect((res as { data: { error: string } }).data.error).toContain(says);
    expect(addPrivateNote).not.toHaveBeenCalled();
  });

  it('links the moderator-app ticket in the mod-lead note', async () => {
    await run('moderation', 'modLead', { ticketId: '5' });
    expect(addPrivateNote.mock.calls[0][1]).toContain(
      'https://mod.test/tickets/moderation?ticket=5'
    );
  });

  it.each(['fileBug', 'privacy', 'modLead'] as const)(
    'the support view has no %s action',
    (action) => {
      expect(ticketActions('support')[action]).toBeUndefined();
    }
  );
});
