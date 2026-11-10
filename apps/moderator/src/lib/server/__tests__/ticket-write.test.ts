import { describe, expect, it, vi } from 'vitest';
import { createTicketWriter, type WriteDeps } from '../tickets/write';
import type { WriteResult } from '../freshdesk-write.service';

const FIELDS = { tags: ['a', 'sent-to-support'], group_id: 154000246097 };
const ok: WriteResult = { status: 'ok' };
const boom: WriteResult = { status: 'error', httpStatus: 500, certain: false, message: 'down' };
const refused: WriteResult = {
  status: 'error',
  httpStatus: 400,
  certain: true,
  message: 'Freshdesk refused it (400)',
};
const mod = { id: 7, username: 'alice' };

function setup(
  over: Partial<{
    reply: WriteResult;
    note: WriteResult;
    status: WriteResult;
    escalate: WriteResult;
  }> = {}
) {
  const calls: string[] = [];
  const deps: WriteDeps = {
    reply: vi.fn(async () => (calls.push('reply'), over.reply ?? ok)),
    note: vi.fn(async () => (calls.push('note'), over.note ?? ok)),
    status: vi.fn(async () => (calls.push('status'), over.status ?? ok)),
    escalate: vi.fn(async () => (calls.push('escalate'), over.escalate ?? ok)),
    record: vi.fn(async () => {}),
  };
  return { calls, deps, writer: createTicketWriter(deps) };
}

describe('reply', () => {
  it('replies, then leaves the attribution note, then records the activity', async () => {
    const { calls, deps, writer } = setup();
    const res = await writer.reply('9', '<p>hi</p>', null, mod);
    expect(res).toEqual({ ok: true, statusChanged: false });
    expect(calls).toEqual(['reply', 'note']);
    expect(deps.note).toHaveBeenCalledWith('9', 'Sent by alice (user 7) from the moderator app.');
    expect(deps.record).toHaveBeenCalledWith(7, 9, 'ticketReply');
  });

  it('sends nothing more when the reply itself fails', async () => {
    const { calls, deps, writer } = setup({ reply: boom });
    const res = await writer.reply('9', '<p>hi</p>', 4, mod);
    expect(res).toMatchObject({ ok: false });
    expect(calls).toEqual(['reply']);
    expect(deps.record).not.toHaveBeenCalled();
  });

  it('says the reply was NOT sent only when Freshdesk certainly refused it', async () => {
    const res = await setup({ reply: refused }).writer.reply('9', '<p>hi</p>', null, mod);
    expect(res).toMatchObject({ ok: false });
    expect((res as { message: string }).message).toMatch(/reply was NOT sent/);
  });

  it('says the reply may have been sent when the outcome is uncertain', async () => {
    const res = await setup({ reply: boom }).writer.reply('9', '<p>hi</p>', null, mod);
    const { message } = res as { message: string };
    expect(message).toMatch(/may or may not have been sent/);
    expect(message).toMatch(/check .*before retrying/i);
    expect(message).not.toMatch(/NOT sent/);
  });

  it('reports a sent reply whose attribution note failed, instead of success or failure', async () => {
    const { writer } = setup({ note: boom });
    const res = await writer.reply('9', '<p>hi</p>', null, mod);
    expect(res).toMatchObject({ ok: true });
    expect((res as { warning: string }).warning).toMatch(
      /reply was sent.*attribution note failed/i
    );
  });

  it('sets the requested status after the reply and names both in one note', async () => {
    const { calls, deps, writer } = setup();
    const res = await writer.reply('9', '<p>hi</p>', 4, mod);
    expect(res).toEqual({ ok: true, statusChanged: true });
    expect(calls).toEqual(['reply', 'status', 'note']);
    expect(deps.note).toHaveBeenCalledWith(
      '9',
      'Sent by alice (user 7) from the moderator app.\nStatus set to Resolved by alice (user 7) from the moderator app.'
    );
  });

  it('reports a sent reply whose status change failed, and does not claim the change in the note', async () => {
    const { deps, writer } = setup({ status: boom });
    const res = await writer.reply('9', '<p>hi</p>', 4, mod);
    expect(res).toMatchObject({ ok: true, statusChanged: false });
    expect((res as { warning: string }).warning).toMatch(/reply was sent.*status change failed/i);
    expect(vi.mocked(deps.note).mock.calls[0][1]).not.toContain('Status set');
  });
});

describe('set status', () => {
  it('sets it, notes who did, and records the activity', async () => {
    const { calls, deps, writer } = setup();
    expect(await writer.setStatus('9', 6, mod)).toEqual({ ok: true, statusChanged: true });
    expect(calls).toEqual(['status', 'note']);
    expect(deps.note).toHaveBeenCalledWith(
      '9',
      'Status set to Waiting on Customer by alice (user 7) from the moderator app.'
    );
    expect(deps.record).toHaveBeenCalledWith(7, 9, 'ticketStatus');
  });

  it('fails without a note when the change is refused', async () => {
    const { calls, writer } = setup({ status: boom });
    expect(await writer.setStatus('9', 6, mod)).toMatchObject({ ok: false });
    expect(calls).toEqual(['status']);
  });

  it('reports a note failure after a successful change as a warning', async () => {
    const { writer } = setup({ note: boom });
    const res = await writer.setStatus('9', 6, mod);
    expect(res).toMatchObject({ ok: true, statusChanged: true });
    expect((res as { warning: string }).warning).toMatch(
      /status was changed.*attribution note failed/i
    );
  });
});

describe('escalate', () => {
  it('updates the ticket, records the activity, then leaves a note with the reason', async () => {
    const { calls, deps, writer } = setup();
    const res = await writer.escalate('9', FIELDS, 'Not a moderation matter', mod);
    expect(res).toEqual({ ok: true, statusChanged: true, movedTo: 'support' });
    expect(calls).toEqual(['escalate', 'note']);
    expect(deps.escalate).toHaveBeenCalledWith('9', FIELDS);
    expect(deps.record).toHaveBeenCalledWith(7, 9, 'ticketEscalate');
    expect(deps.note).toHaveBeenCalledWith(
      '9',
      'Sent to support by alice (user 7) from the moderator app.\nReason: Not a moderation matter'
    );
  });

  it('omits the reason line when none was given', async () => {
    const { deps, writer } = setup();
    await writer.escalate('9', FIELDS, null, mod);
    expect(deps.note).toHaveBeenCalledWith(
      '9',
      'Sent to support by alice (user 7) from the moderator app.'
    );
  });

  it('reports a moved ticket whose note failed as a warning, not a failure', async () => {
    const { writer } = setup({ note: boom });
    const res = await writer.escalate('9', FIELDS, null, mod);
    expect(res).toMatchObject({ ok: true, movedTo: 'support' });
    expect((res as { warning: string }).warning).toMatch(/sent to support.*note failed/i);
  });

  it('says NOT sent to support only on a certain refusal, and records nothing', async () => {
    const certain = setup({ escalate: refused });
    const res = await certain.writer.escalate('9', FIELDS, null, mod);
    expect((res as { message: string }).message).toMatch(/NOT sent to support/);
    expect(certain.deps.record).not.toHaveBeenCalled();
    expect(certain.calls).toEqual(['escalate']);

    const unsure = await setup({ escalate: boom }).writer.escalate('9', FIELDS, null, mod);
    expect((unsure as { message: string }).message).toMatch(/may or may not have been sent/);
  });
});
