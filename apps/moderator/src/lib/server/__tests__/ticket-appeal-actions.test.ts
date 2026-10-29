import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));

const { createTicketAppealActions } = await import('../tickets/appeal-write');

const linkedUser = vi.fn();
const canAct = vi.fn();
const appealOf = vi.fn();
const parseReason = vi.fn();
const needsReviewOf = vi.fn();
const resolve = vi.fn();
const note = vi.fn();

const actions = createTicketAppealActions({
  linkedUser: (...a) => linkedUser(...a),
  canAct: (...a) => canAct(...a),
  appealOf: (...a) => appealOf(...a),
  needsReviewOf: (...a) => needsReviewOf(...a),
  parseReason: (...a) => parseReason(...a),
  resolve: (...a) => resolve(...a),
  note: (...a) => note(...a),
});

const FORM = {
  ticketId: '5',
  userId: '7',
  appealId: '12',
  status: 'Approved',
  resolvedReason: 'not-violation',
};

const run = (fields: Record<string, string> = {}, drop: string[] = []) => {
  const form = new FormData();
  for (const [k, v] of Object.entries({ ...FORM, ...fields }))
    if (!drop.includes(k)) form.set(k, v);
  return actions.appealResolveImage({
    request: new Request('https://x.test/tickets/moderation', { method: 'POST', body: form }),
    locals: { user: { id: 4, username: 'alice' }, grants: {} },
  } as never);
};

const PENDING_IMAGE = {
  userId: 7,
  status: 'Pending',
  entityType: 'Image',
  entityId: 100,
  entityRemovedAt: null,
  category: null,
};

beforeEach(() => {
  linkedUser.mockReset().mockResolvedValue({ status: 'ok', userId: 7 });
  canAct.mockReset().mockReturnValue(true);
  appealOf.mockReset().mockResolvedValue(PENDING_IMAGE);
  needsReviewOf.mockReset().mockResolvedValue('appeal');
  parseReason
    .mockReset()
    .mockReturnValue({ resolvedReason: 'not-violation', internalNotes: undefined });
  resolve.mockReset().mockResolvedValue({ id: 12 });
  note.mockReset().mockResolvedValue({ status: 'ok' });
});

describe('appealResolveImage', () => {
  it('resolves the appeal image for the linked user and leaves a note naming the moderator', async () => {
    expect(await run()).toEqual({ success: true });
    expect(resolve).toHaveBeenCalledWith({
      imageId: 100,
      status: 'Approved',
      resolvedReason: 'not-violation',
      internalNotes: undefined,
      userId: 4,
    });
    expect(parseReason).toHaveBeenCalledWith(expect.any(FormData), 'Approved');
    const text = note.mock.calls[0][1] as string;
    expect(note.mock.calls[0][0]).toBe('5');
    expect(text).toContain('alice');
    expect(text).toContain('Approved');
    expect(text).toContain('image 100');
  });

  it('takes the image from the appeal row, never from the form', async () => {
    await run({ imageId: '999', entityId: '999' });
    expect(resolve.mock.calls[0][0]).toMatchObject({ imageId: 100 });
  });

  it('warns, without failing, when the note could not be left', async () => {
    note.mockResolvedValue({ status: 'error', httpStatus: 500, certain: true, message: 'boom' });
    expect(await run()).toMatchObject({ success: true, warning: expect.stringContaining('boom') });
    note.mockRejectedValue(new Error('offline'));
    expect(await run()).toMatchObject({
      success: true,
      warning: expect.stringContaining('offline'),
    });
  });

  const refusals: [string, () => Promise<unknown> | unknown, number][] = [
    ['a viewer without the image appeals grant', () => canAct.mockReturnValue(false), 403],
    [
      'an appeal of another user',
      () => appealOf.mockResolvedValue({ ...PENDING_IMAGE, userId: 8 }),
      409,
    ],
    ['an appeal that does not exist', () => appealOf.mockResolvedValue(null), 404],
    [
      'an appeal already decided',
      () => appealOf.mockResolvedValue({ ...PENDING_IMAGE, status: 'Rejected' }),
      409,
    ],
    [
      'an appeal about a model',
      () => appealOf.mockResolvedValue({ ...PENDING_IMAGE, entityType: 'Model' }),
      409,
    ],
    [
      'a removed-content appeal',
      () => appealOf.mockResolvedValue({ ...PENDING_IMAGE, entityRemovedAt: new Date() }),
      409,
    ],
    [
      'a site-form appeal',
      () => appealOf.mockResolvedValue({ ...PENDING_IMAGE, category: 'Account' }),
      409,
    ],
    [
      'an image no longer flagged for appeal review',
      () => needsReviewOf.mockResolvedValue(null),
      409,
    ],
    ['an image flagged for some other review', () => needsReviewOf.mockResolvedValue('minor'), 409],
    [
      'a ticket that is no longer a moderation ticket',
      () => linkedUser.mockResolvedValue({ status: 'refused', code: 409, message: 'moved' }),
      409,
    ],
    [
      'a ticket with no linked user',
      () => linkedUser.mockResolvedValue({ status: 'ok', userId: null }),
      409,
    ],
    [
      'a form userId other than the ticket-linked one',
      () => linkedUser.mockResolvedValue({ status: 'ok', userId: 99 }),
      409,
    ],
    [
      'a reason that does not fit the verdict',
      () => parseReason.mockReturnValue('Pick a reason.'),
      400,
    ],
  ];

  it.each(refusals)('refuses %s and decides nothing', async (_name, arrange, code) => {
    await arrange();
    expect(await run()).toMatchObject({ status: code });
    expect(resolve).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
  });

  it('refuses malformed ids and verdicts before reading the ticket', async () => {
    expect(await run({}, ['appealId'])).toMatchObject({ status: 400 });
    expect(await run({ appealId: 'x' })).toMatchObject({ status: 400 });
    expect(await run({ status: 'Void' })).toMatchObject({ status: 400 });
    expect(linkedUser).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('reports success with a warning, and notes the appeal actually closed, when it is not the one posted', async () => {
    resolve.mockResolvedValue({ id: 13 });
    const res = await run();
    expect(res).toMatchObject({ success: true, warning: expect.stringContaining('#13') });
    expect(note).toHaveBeenCalledTimes(1);
    expect(note).toHaveBeenCalledWith('5', expect.stringContaining('appeal #13'));
    expect(note).toHaveBeenCalledWith('5', expect.stringContaining('by '));
  });

  it('reads the image flag from the appeal row image, before resolving', async () => {
    await run({ imageId: '999' });
    expect(needsReviewOf).toHaveBeenCalledWith(100);
  });

  it('answers "already decided" when the resolve finds no pending appeal, and leaves no note', async () => {
    resolve.mockResolvedValue(undefined);
    expect(await run()).toMatchObject({ status: 409 });
    expect(note).not.toHaveBeenCalled();
  });
});
