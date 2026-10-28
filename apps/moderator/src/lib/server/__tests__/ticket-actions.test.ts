import { beforeEach, describe, expect, it, vi } from 'vitest';

const replyToTicket = vi.fn();
const addPrivateNote = vi.fn();
const setTicketStatus = vi.fn();
const updateTicket = vi.fn();
const getTicketDetail = vi.fn();
const resolveTicketView = vi.fn();
const patch = vi.fn();

vi.mock('$lib/server/access', () => ({
  requiresGrant: (_id: string, handler: unknown) => handler,
}));
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
  action: 'reply' | 'status' | 'escalate',
  fields: Record<string, string>
) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const event = {
    request: new Request('https://x.test/tickets', { method: 'POST', body: form }),
    locals: { user: { id: 4, username: 'alice' }, grants: {} },
  };
  const handler = ticketActions(view)[action] as unknown as (e: typeof event) => Promise<unknown>;
  return handler(event);
};

const writes = () =>
  [replyToTicket, addPrivateNote, setTicketStatus, updateTicket].flatMap((f) => f.mock.calls);

beforeEach(() => {
  for (const f of [replyToTicket, addPrivateNote, setTicketStatus, updateTicket])
    f.mockReset().mockResolvedValue({ status: 'ok' });
  getTicketDetail.mockReset().mockResolvedValue({ status: 'found', ticket });
  resolveTicketView.mockReset().mockResolvedValue({ routesTo: 'moderation', routed: undefined });
  patch.mockReset().mockResolvedValue(undefined);
});

const BODY = { body: 'hello' };
const CASES = [
  ['reply', BODY],
  ['status', { status: '3' }],
  ['escalate', {}],
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
    expect(writes().every(([id]) => id === '5')).toBe(true);
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
