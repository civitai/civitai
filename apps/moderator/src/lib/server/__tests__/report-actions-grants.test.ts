import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The layout queues' content and owner actions (`reportModerationActions`) are action grants, not the
 * page: `image.moderate` for the images, `user.strike` for the owner — and for a removal that strikes
 * the owners as it goes. Ruling stays on the page path, so a Reports-only moderator can still rule.
 */

const issueStrike = vi.fn(async () => ({ ok: true }));
const restoreImages = vi.fn(async () => ({ ok: true, count: 1 }));
const setImageFlag = vi.fn(async () => ({ ok: true }));
vi.mock('../user-actions.service', () => ({ issueStrike, restoreImages, setImageFlag }));
const removeImagesWithFollowUps = vi.fn(async () => ({
  ok: true,
  removed: 1,
  alreadyBlocked: 0,
  held: [],
}));
vi.mock('../bulk-image.service', () => ({
  countBlockedImages: vi.fn(async () => 1),
  removeImagesWithFollowUps,
}));
const sendModNotification = vi.fn(async () => ({ ok: true }));
vi.mock('../moderation-memory.service', () => ({ sendModNotification }));
const sendAsCivitai = vi.fn(async () => ({
  ok: true,
  value: { chatId: 1, messageId: 2, deduped: false },
}));
vi.mock('../message-as-civitai', () => ({ sendAsCivitai }));
const setReportStatus = vi.fn(async () => ({ ok: true, changed: true }));
vi.mock('../reports.service', () => ({ setReportStatus, updateReportNotes: vi.fn() }));
vi.mock('../users.service', () => ({ MAX_INT4: 2_147_483_647 }));
vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));
const canAccess = vi.fn((_user: unknown, _path: string) => true);
vi.mock('../access', () => ({
  canAccess,
  denied: (id: string) => `needs ${id}`,
}));

const { reportModerationActions } = await import('../report-actions');
type Action = (event: unknown) => Promise<unknown>;
const actions = reportModerationActions('/reports/post') as unknown as Record<string, Action>;

const event = (fields: Record<string, string>, grants: Record<string, true> = {}) => {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return {
    locals: { user: { id: 7 }, grants },
    request: new Request('https://mod.example/', { method: 'POST', body }),
    getClientAddress: () => '127.0.0.1',
  };
};
const refusal = (r: unknown) => r as { status: number; data: { scope: string; error: string } };

beforeEach(() => vi.clearAllMocks());

describe('the content and owner actions', () => {
  it.each([
    ['remove', { imageIds: '1' }, 'images', 'image.moderate', removeImagesWithFollowUps],
    ['restore', { imageIds: '1' }, 'images', 'image.moderate', restoreImages],
    ['setFlag', { imageIds: '1', flagValue: 'poi:true' }, 'images', 'image.moderate', setImageFlag],
    ['strike', { userId: '5', reason: 'spam' }, 'strike', 'user.strike', issueStrike],
    ['notify', { userId: '5', message: 'hi' }, 'notify', 'user.strike', sendModNotification],
    [
      'messageAsCivitai',
      { userId: '5', message: 'hi', idempotencyKey: 'compose-key-1' },
      'message',
      'user.message.asCivitai',
      sendAsCivitai,
    ],
  ] as const)('%s needs %s', async (name, fields, scope, id, write) => {
    const r = refusal(await actions[name](event(fields)));
    expect(r.status).toBe(403);
    expect(r.data).toEqual({ scope, error: `needs ${id}` });
    expect(write).not.toHaveBeenCalled();

    await actions[name](event(fields, { [id]: true }));
    expect(write).toHaveBeenCalledTimes(1);
  });

  // The checkbox rides on the removal, so it must not be a way to strike without the strike grant.
  it('refuses a removal that strikes the owners without user.strike', async () => {
    const fields = { imageIds: '1', strikeOwners: '1', reason: 'spam' };
    const r = refusal(await actions.remove(event(fields, { 'image.moderate': true })));
    expect(r.data).toEqual({ scope: 'images', error: 'needs user.strike' });
    expect(removeImagesWithFollowUps).not.toHaveBeenCalled();

    await actions.remove(event(fields, { 'image.moderate': true, 'user.strike': true }));
    expect(removeImagesWithFollowUps).toHaveBeenCalledTimes(1);
  });
});

describe('the ruling', () => {
  it('needs only the page path, no action grant', async () => {
    expect(await actions.actionReport(event({ id: '12', status: 'Actioned' }))).toEqual({
      success: true,
    });
    expect(canAccess).toHaveBeenCalledWith({ id: 7 }, '/reports/post');
  });
});

describe('messageAsCivitai', () => {
  it('carries the report it was sent from', async () => {
    await actions.messageAsCivitai(
      event(
        { userId: '5', message: 'hi', idempotencyKey: 'compose-key-1', reportId: '88' },
        { 'user.message.asCivitai': true }
      )
    );
    expect(sendAsCivitai).toHaveBeenCalledWith({
      userId: 5,
      message: 'hi',
      idempotencyKey: 'compose-key-1',
      context: { reportId: 88 },
    });
  });
});
