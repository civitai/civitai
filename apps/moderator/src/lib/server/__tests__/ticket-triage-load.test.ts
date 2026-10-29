import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadTicketPage = vi.fn();

const canAccess = vi.fn();
vi.mock('$lib/server/access', () => ({
  requireAccess: () => {},
  canAccess: (...a: unknown[]) => canAccess(...a),
}));
vi.mock('../freshdesk.service', () => ({ isFreshdeskId: (v: string) => /^\d+$/.test(v) }));
vi.mock('../tickets/list', () => ({
  loadTicketPage: (...a: unknown[]) => loadTicketPage(...a),
  parseTicketQuery: () => ({ q: '' }),
}));

const { ticketTriageLoad } = await import('../tickets/triage');

const page = (over: Record<string, unknown> = {}) => ({
  status: 'ok',
  items: [{ id: '1' }],
  pinned: null,
  ...over,
});
const load = (
  search: string,
  grants: Record<string, boolean> = {},
  view: 'moderation' | 'support' = 'moderation'
) =>
  ticketTriageLoad(view, {
    url: new URL(`https://x.test/tickets/${view}${search}`),
    locals: { user: {}, grants } as unknown as App.Locals,
  });

beforeEach(() => {
  loadTicketPage.mockReset().mockResolvedValue(page());
  canAccess.mockReset().mockReturnValue(false);
});

describe('ticketTriageLoad', () => {
  it('asks for the ticket in the URL to be pinned, and only a valid id', async () => {
    await load('?ticket=77');
    expect(loadTicketPage).toHaveBeenLastCalledWith('moderation', expect.anything(), {
      pinnedId: '77',
    });
    await load('?ticket=abc');
    expect(loadTicketPage).toHaveBeenLastCalledWith('moderation', expect.anything(), {
      pinnedId: undefined,
    });
  });

  it('reports a ticket that is neither on the page nor pinned as missing', async () => {
    expect((await load('?ticket=77')).selectedMissing).toBe('77');
    expect((await load('?ticket=1')).selectedMissing).toBeNull();
    loadTicketPage.mockResolvedValue(page({ pinned: { id: '77' } }));
    expect((await load('?ticket=77')).selectedMissing).toBeNull();
    loadTicketPage.mockResolvedValue({ status: 'unavailable', reason: 'x' });
    expect((await load('?ticket=77')).selectedMissing).toBeNull();
  });

  it('derives the viewer grants; escalation exists on the moderation view only', async () => {
    const grants = { 'tickets.reply': true, 'tickets.escalate': true };
    expect(await load('', grants)).toMatchObject({
      canReply: true,
      canEscalate: true,
      fullBleed: true,
      headerInline: true,
    });
    expect((await load('', grants, 'support')).canEscalate).toBe(false);
    expect(await load('')).toMatchObject({ canReply: false, canEscalate: false });
  });

  it('keeps the account actions on the grants User Lookup asks for, moderation view only', async () => {
    canAccess.mockImplementation((_u: unknown, path: string) => path === '/users');
    expect(await load('', { 'user.ban': true })).toMatchObject({
      canAccountAct: true,
      canUnban: true,
    });
    expect(await load('')).toMatchObject({ canAccountAct: true, canUnban: false });
    canAccess.mockReturnValue(false);
    expect(await load('', { 'user.ban': true })).toMatchObject({
      canAccountAct: false,
      canUnban: true,
    });
    canAccess.mockReturnValue(true);
    expect(await load('', { 'user.ban': true }, 'support')).toMatchObject({
      canAccountAct: false,
      canUnban: false,
    });
  });
});
