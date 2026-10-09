import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `GET /api/decisions/support/<groupKey>/replies/<ticketId>` — the pre-fill read. `/api/*` skips the
 * central route gate, so every refusal here is the endpoint's own.
 */

const { getSupportGroup, getPublicAgentReplies, pageGranted } = vi.hoisted(() => ({
  getSupportGroup: vi.fn(),
  getPublicAgentReplies: vi.fn(),
  pageGranted: { value: true },
}));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/access', async () => {
  const { error } = await import('@sveltejs/kit');
  return {
    requireAccess: (_user: unknown, path: string) => {
      if (!pageGranted.value || path !== '/decisions') error(403, 'no access');
    },
  };
});
vi.mock('$lib/server/decision-sources/support', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/decision-sources/support')>()),
  getSupportGroup,
}));
vi.mock('$lib/server/freshdesk.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/freshdesk.service')>()),
  getPublicAgentReplies,
}));

const { GET } = await import('../../api/decisions/support/[groupKey]/replies/[ticketId]/+server');

const GK = 'g_8e21f0c4b7a9';
const BOTH = { 'decisions.rule': true, 'decisions.answer': true } as const;
const FOUND = {
  status: 'found',
  replies: [{ conversationId: '150003911207', createdAt: null, text: 'Try again.' }],
};

const call = async (
  opts: { ticketId?: string; version?: string | null; grants?: Record<string, true> } = {}
): Promise<{ status: number; body: unknown }> => {
  const url = new URL(`https://moderator.example/api/decisions/support/${GK}/replies/x`);
  if (opts.version !== null) url.searchParams.set('version', opts.version ?? 'v-shown');
  try {
    const res = (await (GET as unknown as (e: unknown) => Promise<Response>)({
      params: { groupKey: GK, ticketId: opts.ticketId ?? '2' },
      url,
      locals: { user: { id: 7 }, grants: opts.grants ?? BOTH },
    })) as Response;
    return { status: res.status, body: await res.json() };
  } catch (e) {
    // SvelteKit's `error()` throws an HttpError.
    const err = e as { status?: number; body?: unknown };
    if (typeof err.status !== 'number') throw e;
    return { status: err.status, body: err.body };
  }
};

beforeEach(() => {
  pageGranted.value = true;
  getSupportGroup.mockReset();
  getPublicAgentReplies.mockReset();
  getSupportGroup.mockResolvedValue({
    group: { groupKey: GK },
    decision: { members: [{ ticketId: '1' }, { ticketId: '2' }] },
  });
  getPublicAgentReplies.mockResolvedValue(FOUND);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('the replies endpoint', () => {
  it("returns a current member's public agent replies, read in the version posted", async () => {
    expect(await call()).toEqual({ status: 200, body: FOUND });
    expect(getSupportGroup).toHaveBeenCalledWith({ version: 'v-shown', groupKey: GK });
    expect(getPublicAgentReplies).toHaveBeenCalledWith('2');
  });

  it.each([
    ['without the page grant', false, BOTH],
    ['without decisions.answer', true, { 'decisions.rule': true }],
    ['without decisions.rule', true, { 'decisions.answer': true }],
  ] as const)('403s %s, asking nobody', async (_label, page, grants) => {
    pageGranted.value = page;
    const opts = { grants: { ...grants } as Record<string, true> };
    expect((await call(opts)).status).toBe(403);
    expect(getSupportGroup).not.toHaveBeenCalled();
    expect(getPublicAgentReplies).not.toHaveBeenCalled();
  });

  it('404s a ticket that is not a current member — Freshdesk is never asked', async () => {
    expect((await call({ ticketId: '73618' })).status).toBe(404);
    expect(getPublicAgentReplies).not.toHaveBeenCalled();
  });

  it('404s a group that is gone from the version', async () => {
    getSupportGroup.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
    expect(getPublicAgentReplies).not.toHaveBeenCalled();
  });

  it.each([
    ['a malformed ticket id', { ticketId: '2/../9' }],
    ['no version', { version: null }],
  ] as const)('400s %s', async (_label, opts) => {
    expect((await call(opts)).status).toBe(400);
    expect(getPublicAgentReplies).not.toHaveBeenCalled();
  });

  it("503s naming the router when the router's data cannot be read", async () => {
    getSupportGroup.mockRejectedValue(new Error('socket hang up'));
    expect(await call()).toEqual({
      status: 503,
      body: { error: "Could not read the router's data." },
    });
  });
});
