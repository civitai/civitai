import { beforeEach, describe, expect, it, vi } from 'vitest';

const getTicketDetail = vi.fn();
const getTicketConversation = vi.fn();
const routedContext = vi.fn();
const patch = vi.fn();

vi.mock('../freshdesk.service', () => ({
  freshdeskTicketUrl: (id: string) => `https://fd.test/a/tickets/${id}`,
  getTicketDetail: (...a: unknown[]) => getTicketDetail(...a),
  getTicketConversation: (...a: unknown[]) => getTicketConversation(...a),
  isFreshdeskId: (v: string) => /^\d+$/.test(v),
}));
vi.mock('../decision-sources/support', () => ({
  getRoutedTicketContext: (...a: unknown[]) => routedContext(...a),
}));
const sentByTickets = vi.fn();
vi.mock('../tickets/sent-by', () => ({ sentByTickets: (...a: unknown[]) => sentByTickets(...a) }));
vi.mock('../tickets/snapshot', () => ({
  ticketSnapshot: { patch: (...a: unknown[]) => patch(...a) },
  toRecord: (t: unknown) => t,
}));
vi.mock('../user-lookup.service', () => ({ resolveUserId: async () => 99 }));
const accountSectionFor = vi.fn();
vi.mock('../tickets/account', () => ({
  accountSectionFor: (...a: unknown[]) => accountSectionFor(...a),
}));

const none = () => false;
const all = () => true;

const { loadTicketPayload, openTicketInView, resolveTicketView } = await import(
  '../tickets/detail'
);

const ticket = (over: Record<string, unknown> = {}) => ({
  id: '5',
  subject: 'Banned',
  status: 2,
  cfFeature: 'Moderation Decision',
  tags: [],
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-02T00:00:00Z',
  description: { status: 'found', text: 'hi', truncated: false },
  requesterName: 'Ann',
  requesterEmail: 'ann@example.test',
  ...over,
});

beforeEach(() => {
  getTicketDetail.mockReset().mockResolvedValue({ status: 'found', ticket: ticket() });
  getTicketConversation
    .mockReset()
    .mockResolvedValue({ status: 'found', messages: [], truncated: false });
  routedContext.mockReset().mockResolvedValue(new Map());
  patch.mockReset().mockResolvedValue(undefined);
  sentByTickets.mockReset().mockResolvedValue(new Map());
  accountSectionFor.mockReset().mockResolvedValue(undefined);
});

describe('loadTicketPayload', () => {
  it('returns the ticket and its conversation for a ticket of the view', async () => {
    const res = await loadTicketPayload('moderation', '5', {
      canSeeEmail: false,
      canRead: none,
    });
    expect(res).toMatchObject({
      status: 'ok',
      ticket: { id: '5', statusLabel: 'Open', civitaiUserId: 99, requesterName: 'Ann' },
      conversation: { status: 'found' },
    });
  });

  it('adds the account section only for a viewer who may read it, handing the loader the linked user', async () => {
    getTicketDetail.mockResolvedValue({
      status: 'found',
      ticket: ticket({ cfFeature: 'Account Restriction or Banned Account' }),
    });
    accountSectionFor.mockResolvedValue({ status: 'ok', userId: 99 });
    const without = await loadTicketPayload('moderation', '5', {
      canSeeEmail: false,
      canRead: none,
    });
    expect(without).not.toHaveProperty('account');
    const withAccount = await loadTicketPayload('moderation', '5', {
      canSeeEmail: false,
      canRead: all,
    });
    expect(withAccount).toMatchObject({ account: { status: 'ok', userId: 99 } });
    expect(accountSectionFor).toHaveBeenLastCalledWith({
      view: 'moderation',
      cfFeature: 'Account Restriction or Banned Account',
      routerTopic: null,
      civitaiUserId: 99,
      canView: true,
    });
  });

  it('asks the router live when the snapshot holds a router answer with no linked account', async () => {
    patch.mockResolvedValueOnce({
      id: '5',
      routerTopic: 'account-issue',
      civitaiUserId: null,
      enrichedAt: Date.now() - 1,
    });
    routedContext.mockResolvedValueOnce(
      new Map([['5', { topic: 'account-issue', civitaiUserId: 7 }]])
    );
    const res = await loadTicketPayload('moderation', '5', {
      canSeeEmail: false,
      canRead: none,
    });
    expect(routedContext).toHaveBeenCalledTimes(1);
    expect(res.status === 'ok' && res.ticket.civitaiUserId).toBe(7);
  });

  it('still returns the ticket when the sent-by lookup fails', async () => {
    getTicketDetail.mockResolvedValueOnce({
      status: 'found',
      ticket: ticket({ tags: ['sent-to-support'] }),
    });
    sentByTickets.mockRejectedValueOnce(new Error('moderator db down'));
    const res = await loadTicketPayload('support', '5', {
      canSeeEmail: false,
      canRead: none,
    });
    expect(res.status === 'ok' && res.ticket.sentBy).toBeNull();
  });

  it('keeps the requester address behind the PII grant', async () => {
    const without = await loadTicketPayload('moderation', '5', {
      canSeeEmail: false,
      canRead: none,
    });
    expect(JSON.stringify(without)).not.toContain('example.test');
    const withGrant = await loadTicketPayload('moderation', '5', {
      canSeeEmail: true,
      canRead: none,
    });
    expect(withGrant.status === 'ok' && withGrant.ticket).toMatchObject({
      requesterEmail: 'ann@example.test',
    });
  });

  it('refuses a ticket that belongs to the other view, without returning any of it', async () => {
    const res = await loadTicketPayload('support', '5', {
      canSeeEmail: true,
      canRead: none,
    });
    expect(res).toMatchObject({ status: 'refused', code: 404 });
    expect(JSON.stringify(res)).not.toContain('ann@example.test');
  });

  it('refuses a bad id and an unreadable ticket, and degrades a failed conversation', async () => {
    expect(
      await loadTicketPayload('moderation', 'abc', { canSeeEmail: false, canRead: none })
    ).toMatchObject({
      status: 'refused',
      code: 404,
    });
    getTicketDetail.mockResolvedValueOnce({ status: 'unavailable', reason: 'Freshdesk is down.' });
    expect(
      await loadTicketPayload('moderation', '5', { canSeeEmail: false, canRead: none })
    ).toMatchObject({
      status: 'refused',
      code: 503,
    });
    getTicketConversation.mockRejectedValueOnce(new Error('boom'));
    const res = await loadTicketPayload('moderation', '5', {
      canSeeEmail: false,
      canRead: none,
    });
    expect(res.status === 'ok' && res.conversation.status).toBe('unavailable');
  });
});

describe('openTicketInView', () => {
  it('redirects an old deep link to the list with the ticket selected', async () => {
    await expect(openTicketInView('moderation', '5')).rejects.toMatchObject({
      status: 303,
      location: '/tickets/moderation?ticket=5',
    });
  });

  it('keeps the 404 for a ticket of the other view', async () => {
    await expect(openTicketInView('support', '5')).rejects.toMatchObject({ status: 404 });
  });
});

describe('resolveTicketView when the router lookup fails', () => {
  const known = (over: Record<string, unknown> = {}) => ({
    id: '5',
    subject: 'Banned',
    status: 2,
    cfFeature: null,
    tags: [],
    createdAt: null,
    updatedAt: null,
    routerTopic: 'image-moderation-appeal',
    civitaiUserId: null,
    enrichedAt: Date.now(),
    ...over,
  });
  const noFeature = { cfFeature: null, status: 2, tags: [] as string[] };

  it('keeps routing a ticket to the view its stored topic puts it in', async () => {
    routedContext.mockRejectedValue(new Error('router down'));
    const res = await resolveTicketView('5', noFeature, known() as never);
    expect(res.routesTo).toBe('moderation');
    expect(res.routed).toEqual({ topic: 'image-moderation-appeal', civitaiUserId: null });
  });

  it('has no topic to route by without a stored record', async () => {
    routedContext.mockRejectedValue(new Error('router down'));
    const res = await resolveTicketView('5', noFeature);
    expect(res.routed).toBeUndefined();
    expect(res.routesTo).toBe('support');
  });
});
