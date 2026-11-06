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

beforeEach(() => {
  linkedUser.mockReset().mockResolvedValue({ status: 'ok', userId: 7 });
  queue.mockReset().mockResolvedValue({ status: 'queued', id: 31 });
  note.mockReset().mockResolvedValue({ status: 'ok' });
});

describe('accountQueueDataExport', () => {
  it('queues for the ticket-linked account, as the acting moderator, and notes the ticket', async () => {
    expect(await run()).toMatchObject({ success: true });
    expect(queue).toHaveBeenCalledWith({ userId: 7, requestedById: 4 });
    expect(note).toHaveBeenCalledWith('5', expect.stringContaining('#31'));
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
