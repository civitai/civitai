import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));

const { createTicketLoraActions } = await import('../tickets/lora-write');

const linkedUser = vi.fn();
const canAct = vi.fn();
const modelOf = vi.fn();
const setBlock = vi.fn();
const note = vi.fn();

const actions = createTicketLoraActions({
  linkedUser: (...a) => linkedUser(...a),
  canAct: (...a) => canAct(...a),
  modelOf: (...a) => modelOf(...a),
  setCannotPublish: (...a) => setBlock(...a),
  note: (...a) => note(...a),
});

const FIELDS = { ticketId: '5', userId: '7', modelId: '30', cannotPublish: 'true' };

const run = (fields: Record<string, string> = {}) => {
  const form = new FormData();
  for (const [k, v] of Object.entries({ ...FIELDS, ...fields })) form.set(k, v);
  return actions.loraSetPublishBlock({
    request: new Request('https://x.test/tickets/support', { method: 'POST', body: form }),
    locals: { user: { id: 4, username: 'alice' }, grants: {} },
  } as never);
};

beforeEach(() => {
  linkedUser.mockReset().mockResolvedValue({ status: 'ok', userId: 7 });
  canAct.mockReset().mockReturnValue(true);
  modelOf.mockReset().mockResolvedValue({ userId: 7 });
  setBlock.mockReset().mockResolvedValue(true);
  note.mockReset().mockResolvedValue({ status: 'ok' });
});

describe('loraSetPublishBlock', () => {
  it('is gated on the training models page grant, before anything is read', async () => {
    canAct.mockReturnValue(false);
    expect(await run()).toMatchObject({ status: 403 });
    expect(canAct).toHaveBeenCalledWith(expect.anything(), '/audit/training-models');
    expect(linkedUser).not.toHaveBeenCalled();
    expect(setBlock).not.toHaveBeenCalled();
  });

  it('refuses a malformed form with 400 and a ticket that moved views with its refusal', async () => {
    expect(await run({ cannotPublish: 'maybe' })).toMatchObject({ status: 400 });
    expect(await run({ modelId: 'x' })).toMatchObject({ status: 400 });
    linkedUser.mockResolvedValue({ status: 'refused', code: 409, message: 'moved' });
    expect(await run()).toMatchObject({ status: 409 });
    expect(setBlock).not.toHaveBeenCalled();
  });

  it('refuses a userId other than the ticket-linked one', async () => {
    expect(await run({ userId: '99' })).toMatchObject({ status: 409 });
    expect(setBlock).not.toHaveBeenCalled();
  });

  it('refuses a model owned by someone else and one that does not exist', async () => {
    modelOf.mockResolvedValueOnce({ userId: 8 });
    expect(await run()).toMatchObject({ status: 409 });
    modelOf.mockResolvedValueOnce(null);
    expect(await run()).toMatchObject({ status: 404 });
    expect(setBlock).not.toHaveBeenCalled();
  });

  it('refuses, without a note, when the write changed nothing because the model is already in that state', async () => {
    setBlock.mockResolvedValue(false);
    expect(await run({ cannotPublish: 'true' })).toMatchObject({
      status: 409,
      data: { error: expect.stringContaining('already blocked') },
    });
    expect(await run({ cannotPublish: 'false' })).toMatchObject({
      status: 409,
      data: { error: expect.stringContaining('already allowed') },
    });
    expect(note).not.toHaveBeenCalled();
  });

  it('blocks publishing once, attributed in a note on the ticket', async () => {
    expect(await run()).toEqual({ success: true });
    expect(setBlock).toHaveBeenCalledExactlyOnceWith(30, true);
    expect(note.mock.calls[0][0]).toBe('5');
    expect(note.mock.calls[0][1]).toContain('Blocked publishing of model 30');
  });

  it('allows publishing again', async () => {
    expect(await run({ cannotPublish: 'false' })).toEqual({ success: true });
    expect(setBlock).toHaveBeenCalledExactlyOnceWith(30, false);
    expect(note.mock.calls[0][1]).toContain('Allowed publishing of model 30');
  });

  it('keeps a failed note as a warning on a success', async () => {
    note.mockResolvedValue({ status: 'error', httpStatus: 500, certain: true, message: 'boom' });
    expect(await run()).toMatchObject({ success: true, warning: expect.stringContaining('boom') });
  });
});
