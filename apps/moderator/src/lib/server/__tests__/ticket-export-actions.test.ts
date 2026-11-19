import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));

const { createTicketExportActions, ALREADY_QUEUED } = await import('../tickets/export-write');

const linkedUser = vi.fn();
const queue = vi.fn();
const note = vi.fn();

const actions = createTicketExportActions({
  linkedUser: (...a) => linkedUser(...a),
  queue: (...a) => queue(...a),
  note: (...a) => note(...a),
});

const run = (
  fields: Record<string, string> = {},
  grants: Record<string, true> = { 'user.personalDataExport.queue': true }
) => {
  const form = new FormData();
  for (const [k, v] of Object.entries({ ticketId: '5', userId: '7', ...fields })) form.set(k, v);
  return actions.accountQueueDataExport({
    request: new Request('https://x.test/tickets/support', { method: 'POST', body: form }),
    locals: { user: { id: 4, username: 'alice' }, grants },
  } as never);
};

// Weeks before the test runs: a queue that stamped today would not match it.
const TICKET_DATE = '2026-09-14T22:10:00Z';

beforeEach(() => {
  linkedUser
    .mockReset()
    .mockResolvedValue({ status: 'ok', userId: 7, ticketCreatedAt: TICKET_DATE });
  queue.mockReset().mockResolvedValue({ status: 'queued', id: 31 });
  note.mockReset().mockResolvedValue({ status: 'ok' });
});

describe('accountQueueDataExport', () => {
  it('queues for the ticket-linked account, as the acting moderator, and notes the ticket', async () => {
    expect(await run()).toMatchObject({ success: true });
    expect(queue).toHaveBeenCalledWith({
      userId: 7,
      requestedById: 4,
      ticketId: 5,
      // The ticket's own date, read from the help desk: when the user asked, not when it was queued.
      requestedAt: new Date(TICKET_DATE),
    });
    expect(note).toHaveBeenCalledWith('5', expect.stringContaining('#31'));
  });

  it("queues nothing when the ticket's date cannot be read, rather than guess one", async () => {
    for (const ticketCreatedAt of [null, 'not a date']) {
      linkedUser.mockResolvedValue({ status: 'ok', userId: 7, ticketCreatedAt });
      expect(await run()).toMatchObject({ status: 503 });
    }
    expect(queue).not.toHaveBeenCalled();
  });

  it('ignores a request date sent with the form', async () => {
    await run({ requestedAt: '2026-11-01', ticketCreatedAt: '2026-11-01' });
    expect(queue.mock.calls[0][0].requestedAt).toEqual(new Date(TICKET_DATE));
  });

  it('is refused without the queue permission, before anything is read', async () => {
    expect(await run({}, {})).toMatchObject({ status: 403 });
    expect(linkedUser).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
  });

  it('refuses a userId other than the ticket-linked one', async () => {
    expect(await run({ userId: '99' })).toMatchObject({ status: 409 });
    expect(queue).not.toHaveBeenCalled();
  });

  it('answers "already queued" when one is queued or building, and leaves no note', async () => {
    queue.mockResolvedValue({ status: 'already-queued' });
    expect(await run()).toMatchObject({ status: 409, data: { error: ALREADY_QUEUED } });
    expect(note).not.toHaveBeenCalled();
  });
});
