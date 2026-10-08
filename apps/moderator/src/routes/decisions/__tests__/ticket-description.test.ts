import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The ticket page's formatted body: read from Freshdesk in `load`, streamed rather than awaited, and
 * always settling to something the page can render — the formatted text, or a reason to fall back to
 * the stored excerpt. Stubbed `fetch`; no Freshdesk call is made.
 */

const { getSupportTicket } = vi.hoisted(() => ({ getSupportTicket: vi.fn() }));
vi.mock('$lib/server/decision-sources/support', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/decision-sources/support')>()),
  getSupportTicket,
  supportVersion: vi.fn(async () => ({ version: 'v', overridden: false })),
}));

const { load } = await import('../support/ticket/[ticketId]/+page.server');

type Out = { description: Promise<{ status: string; text?: string; reason?: string }> };
const run = () =>
  (load as unknown as (e: unknown) => Promise<Out>)({
    params: { ticketId: '40017' },
    url: new URL('https://moderator.example/decisions/support/ticket/40017'),
    locals: { grants: {} },
  });

const saved = process.env.FRESHDESK_API_KEY;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.FRESHDESK_API_KEY = 'test-key';
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  getSupportTicket.mockReset();
  getSupportTicket.mockResolvedValue({ ticketId: '40017', bodyExcerpt: 'flat stored text' });
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (saved === undefined) delete process.env.FRESHDESK_API_KEY;
  else process.env.FRESHDESK_API_KEY = saved;
});

describe('ticket page description', () => {
  it('streams the formatted body', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ description: '<p>one</p><p>two</p>' }), { status: 200 })
    );
    const out = await run();
    expect(await out.description).toEqual({
      status: 'found',
      text: 'one\n\ntwo',
      truncated: false,
    });
  });

  it('a rate-limited Freshdesk settles to "unavailable" — the page falls back, it does not fail', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 429 }));
    const out = await run();
    expect((await out.description).status).toBe('unavailable');
  });

  it('does NOT hold the page for Freshdesk: load returns while the read is still pending', async () => {
    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    const out = await run();
    expect(out.description).toBeInstanceOf(Promise);
    const settled = await Promise.race([
      out.description.then(() => 'settled'),
      new Promise((r) => setTimeout(() => r('pending'), 20)),
    ]);
    expect(settled).toBe('pending');
  });

  it('a ticket the router never routed is a 404 before Freshdesk is asked', async () => {
    getSupportTicket.mockResolvedValueOnce(null);
    await expect(run()).rejects.toMatchObject({ status: 404 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
