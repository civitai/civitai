import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));

const { createTicketRatingActions } = await import('../tickets/rating-write');

const linkedUser = vi.fn();
const canAct = vi.fn();
const reviewOf = vi.fn();
const resolve = vi.fn();
const note = vi.fn();

const actions = createTicketRatingActions({
  linkedUser: (...a) => linkedUser(...a),
  canAct: (...a) => canAct(...a),
  reviewOf: (...a) => reviewOf(...a),
  resolve: (...a) => resolve(...a),
  note: (...a) => note(...a),
});

const run = (fields: Record<string, string> = {}, drop: string[] = []) => {
  const form = new FormData();
  for (const [k, v] of Object.entries({
    ticketId: '5',
    userId: '7',
    reviewId: '30',
    appliedLevel: '4',
    ...fields,
  }))
    if (!drop.includes(k)) form.set(k, v);
  return actions.ratingDisputeResolve({
    request: new Request('https://x.test/tickets/moderation', { method: 'POST', body: form }),
    locals: { user: { id: 4, username: 'alice' }, grants: {} },
  } as never);
};

const row = (over: Record<string, unknown> = {}) => ({
  id: 30,
  userId: 7,
  status: 'Pending',
  entityType: 'Post',
  entityId: 900,
  ...over,
});

beforeEach(() => {
  linkedUser.mockReset().mockResolvedValue({ status: 'ok', userId: 7 });
  canAct.mockReset().mockReturnValue(true);
  reviewOf.mockReset().mockResolvedValue(row());
  resolve.mockReset().mockResolvedValue({ ok: true, status: 'Actioned' });
  note.mockReset().mockResolvedValue({ status: 'ok' });
});

describe('ratingDisputeResolve', () => {
  it('rules under the /ratings grant with the row’s id and a trimmed note, and notes the moderator', async () => {
    expect(await run({ modComment: ' too strict ' })).toEqual({
      success: true,
      status: 'Actioned',
    });
    expect(canAct).toHaveBeenCalledWith(expect.anything(), '/ratings');
    expect(resolve).toHaveBeenCalledExactlyOnceWith({
      reviewId: 30,
      appliedLevel: 4,
      modComment: 'too strict',
      userId: 4,
    });
    const text = note.mock.calls[0][1] as string;
    expect(note.mock.calls[0][0]).toBe('5');
    expect(text).toContain('alice');
    expect(text).toContain('dispute #30');
    expect(text).toContain('Post 900');
  });

  it('sends no note when the field is empty', async () => {
    await run({ modComment: '   ' });
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ modComment: undefined }));
  });

  it('reports a rejection as such', async () => {
    resolve.mockResolvedValue({ ok: true, status: 'Unactioned' });
    expect(await run()).toMatchObject({ success: true, status: 'Unactioned' });
    expect(note.mock.calls[0][1]).toContain('Rejected');
  });

  it('a made ruling is not failed by a failed note', async () => {
    note.mockRejectedValue(new Error('offline'));
    const res = (await run()) as { success: boolean; warning: string };
    expect(res.success).toBe(true);
    expect(res.warning).toContain('offline');
  });

  it('surfaces the ruling’s own refusal as a 409 and leaves no note', async () => {
    resolve.mockResolvedValue({ ok: false, error: 'Review already resolved' });
    expect(await run()).toMatchObject({ status: 409, data: { error: 'Review already resolved' } });
    expect(note).not.toHaveBeenCalled();
  });

  const refusals: [string, () => void, number][] = [
    ['a viewer without the /ratings grant', () => canAct.mockReturnValue(false), 403],
    ['a dispute that does not exist', () => reviewOf.mockResolvedValue(null), 404],
    ['another user’s dispute', () => reviewOf.mockResolvedValue(row({ userId: 8 })), 409],
    [
      'a dispute already decided',
      () => reviewOf.mockResolvedValue(row({ status: 'Actioned' })),
      409,
    ],
    [
      'a ticket that no longer qualifies',
      () => linkedUser.mockResolvedValue({ status: 'refused', code: 409, message: 'moved' }),
      409,
    ],
    [
      'a form user other than the ticket-linked one',
      () => linkedUser.mockResolvedValue({ status: 'ok', userId: 99 }),
      409,
    ],
  ];
  it.each(refusals)('refuses %s and changes nothing', async (_n, arrange, status) => {
    arrange();
    expect(await run()).toMatchObject({ status });
    expect(resolve).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
  });

  it.each([
    ['no level', {}, ['appliedLevel']],
    ['a level of zero', { appliedLevel: '0' }, []],
    ['a note over 1000 characters', { modComment: 'x'.repeat(1001) }, []],
    ['no dispute id', {}, ['reviewId']],
  ])('refuses %s as a bad request', async (_n, fields, drop) => {
    expect(await run(fields, drop)).toMatchObject({ status: 400 });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('checks the grant before reading anything', async () => {
    canAct.mockReturnValue(false);
    await run();
    expect(linkedUser).not.toHaveBeenCalled();
    expect(reviewOf).not.toHaveBeenCalled();
  });
});
