import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The ticket page decides the PII flag from the grant, before the read — never fetch-and-hide. */

const { getSupportTicket } = vi.hoisted(() => ({ getSupportTicket: vi.fn() }));
vi.mock('$lib/server/decision-sources/support', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/decision-sources/support')>()),
  getSupportTicket,
  supportVersion: vi.fn(async () => ({ version: 'v', overridden: false })),
}));

const { load } = await import('../support/ticket/[ticketId]/+page.server');
const run = (grants: Record<string, true>) =>
  (load as unknown as (e: unknown) => Promise<{ canSeeEmail: boolean }>)({
    params: { ticketId: '18266' },
    url: new URL('https://moderator.example/decisions/support/ticket/18266'),
    locals: { grants },
  });

beforeEach(() => {
  getSupportTicket.mockReset();
  getSupportTicket.mockResolvedValue({ ticketId: '18266' });
});

describe('ticket page PII gate', () => {
  it('reads WITHOUT the email when the grant is absent', async () => {
    const out = await run({ 'decisions.rule': true });
    expect(getSupportTicket).toHaveBeenCalledWith({
      version: 'v',
      ticketId: '18266',
      includeEmail: false,
    });
    expect(out.canSeeEmail).toBe(false);
  });

  it('reads with it when decisions.support.pii is held', async () => {
    const out = await run({ 'decisions.support.pii': true });
    expect(getSupportTicket).toHaveBeenCalledWith({
      version: 'v',
      ticketId: '18266',
      includeEmail: true,
    });
    expect(out.canSeeEmail).toBe(true);
  });

  it('404s a malformed id without reading', async () => {
    await expect(
      (load as unknown as (e: unknown) => Promise<unknown>)({
        params: { ticketId: "1' OR 1=1" },
        url: new URL('https://moderator.example/x'),
        locals: { grants: {} },
      })
    ).rejects.toMatchObject({ status: 404 });
    expect(getSupportTicket).not.toHaveBeenCalled();
  });
});
