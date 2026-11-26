import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MINOR_SEXUALIZATION_VIOLATION } from '@civitai/shared/post-text-report';

/**
 * The post queue's text actions: which report may refuse and which goes to the CSAM queue, that the
 * text acted on is the one the report names, and the ruling each leaves on the report.
 */

const setReportStatus = vi.fn();
vi.mock('$lib/server/reports.service', () => ({ setReportStatus }));
const getReportPostTextId = vi.fn();
const moderatePostText = vi.fn();
vi.mock('$lib/server/post-text-reports.service', () => ({ getReportPostTextId, moderatePostText }));
vi.mock('$lib/server/moderation-board.service', () => ({ getResolvedPostReportIds: vi.fn() }));
vi.mock('$lib/server/report-actions', () => ({ reportModerationActions: () => ({}) }));
vi.mock('$lib/server/users.service', () => ({ MAX_INT4: 2_147_483_647 }));
const canAccess = vi.fn(() => true);
vi.mock('$lib/server/access', () => ({ canAccess }));

const { postQueueActions } = await import('../actions.server');

const TEXT = 71;
const run = (
  name: 'refuseText' | 'restoreText' | 'holdText',
  fields: Record<string, string> = { id: '200', reason: 'graphic violence on slide two' }
) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return postQueueActions[name]({
    request: new Request('https://x.test/reports/post', { method: 'POST', body: form }),
    locals: { user: { id: 4, username: 'mod' }, grants: {} },
    getClientAddress: () => '127.0.0.1',
  } as never);
};
const tos = { reason: 'TOSViolation', details: { violation: 'Graphic violence' } };
const minors = { reason: 'TOSViolation', details: { violation: MINOR_SEXUALIZATION_VIOLATION } };

beforeEach(() => {
  vi.clearAllMocks();
  canAccess.mockReturnValue(true);
  getReportPostTextId.mockResolvedValue({ postTextId: TEXT, ...tos });
  moderatePostText.mockResolvedValue({ ok: true, changed: true, stillRefused: false });
  setReportStatus.mockResolvedValue({ ok: true, changed: true });
});

describe('refusing a reported text', () => {
  it('refuses the text the report names, with the reason, then actions the report', async () => {
    expect(await run('refuseText', { id: '200', reason: 'graphic', textId: '999' })).toEqual({
      success: true,
      textAction: 'Text refused',
    });
    expect(moderatePostText).toHaveBeenCalledWith({
      textId: TEXT,
      action: 'refuse',
      reason: 'graphic',
      reportId: 200,
    });
    expect(setReportStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: 200, status: 'Actioned', userId: 4 })
    );
  });

  it('is refused for a minor-sexualization or CSAM report, which go to the CSAM queue', async () => {
    for (const report of [minors, { reason: 'CSAM', details: {} }]) {
      getReportPostTextId.mockResolvedValueOnce({ postTextId: TEXT, ...report });
      expect(await run('refuseText')).toMatchObject({ status: 400 });
    }
    expect(moderatePostText).not.toHaveBeenCalled();
    expect(setReportStatus).not.toHaveBeenCalled();
  });

  it('asks why, and leaves the report alone when the main app refuses', async () => {
    expect(await run('refuseText', { id: '200', reason: '  ' })).toMatchObject({ status: 400 });
    moderatePostText.mockResolvedValueOnce({ ok: false, error: 'nope' });
    expect(await run('refuseText')).toMatchObject({ status: 409, data: { error: 'nope' } });
    expect(setReportStatus).not.toHaveBeenCalled();
  });

  it('is refused without the post queue', async () => {
    canAccess.mockReturnValueOnce(false);
    expect(await run('refuseText')).toMatchObject({ status: 403 });
    expect(moderatePostText).not.toHaveBeenCalled();
  });

  it('has nothing to act on for a report that is not on a text, or whose text is gone', async () => {
    getReportPostTextId.mockResolvedValueOnce(null);
    expect(await run('refuseText')).toMatchObject({ status: 410 });
    getReportPostTextId.mockResolvedValueOnce({ postTextId: null, ...tos });
    expect(await run('refuseText')).toMatchObject({ status: 410 });
    expect(moderatePostText).not.toHaveBeenCalled();
  });
});

describe('holding a reported text for CSAM review', () => {
  it('holds a minor-sexualization report and actions it', async () => {
    getReportPostTextId.mockResolvedValueOnce({ postTextId: TEXT, ...minors });
    expect(await run('holdText')).toEqual({ success: true, textAction: 'Held for CSAM review' });
    expect(moderatePostText).toHaveBeenCalledWith(expect.objectContaining({ action: 'hold' }));
    expect(setReportStatus).toHaveBeenCalledWith(expect.objectContaining({ status: 'Actioned' }));
  });

  it('is refused for an ordinary report', async () => {
    expect(await run('holdText')).toMatchObject({ status: 400 });
    expect(moderatePostText).not.toHaveBeenCalled();
  });
});

describe('restoring a refused text', () => {
  it('restores and dismisses the report', async () => {
    expect(await run('restoreText')).toEqual({ success: true, textAction: 'Text restored' });
    expect(setReportStatus).toHaveBeenCalledWith(expect.objectContaining({ status: 'Unactioned' }));
  });

  it("says so when the scan's own refusal still hides the text", async () => {
    moderatePostText.mockResolvedValueOnce({ ok: true, changed: true, stillRefused: true });
    expect(await run('restoreText')).toEqual({
      success: true,
      textAction: 'Restored, but the scan still refuses it',
    });
  });

  it('leaves the report as it is when there was nothing to restore', async () => {
    moderatePostText.mockResolvedValueOnce({ ok: true, changed: false });
    expect(await run('restoreText')).toEqual({
      success: true,
      textAction: 'Not refused by a moderator',
    });
    expect(setReportStatus).not.toHaveBeenCalled();
  });
});
