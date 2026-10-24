import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `saveNotes` on the layout queues (`reportModerationActions`): a report's internal notes, gated on the
 * queue's page path as its ruling is — reaching a layout queue is the shared Reports grant. The same
 * action the tables and the model queue use (`saveNotesAction`), so the cap and the refusals match.
 */

const updateReportNotes = vi.fn(async () => ({ ok: true } as { ok: boolean }));
vi.mock('../reports.service', () => ({ setReportStatus: vi.fn(), updateReportNotes }));
const canAccess = vi.fn((_user: unknown, _path: string) => true);
vi.mock('../access', () => ({ canAccess }));
vi.mock('../user-actions.service', () => ({
  issueStrike: vi.fn(),
  restoreImages: vi.fn(),
  setImageFlag: vi.fn(),
}));
vi.mock('../bulk-image.service', () => ({
  countBlockedImages: vi.fn(),
  removeImagesWithFollowUps: vi.fn(),
}));
vi.mock('../moderation-memory.service', () => ({ sendModNotification: vi.fn() }));
vi.mock('../users.service', () => ({ MAX_INT4: 2_147_483_647 }));
vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));

const { reportModerationActions } = await import('../report-actions');
const { saveNotes } = reportModerationActions('/reports/user') as unknown as {
  saveNotes: (event: unknown) => Promise<unknown>;
};

const event = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return {
    locals: { user: { id: 7 } },
    request: new Request('https://mod.example/', { method: 'POST', body }),
  };
};
const status = (r: unknown) => (r as { status?: number }).status;

beforeEach(() => {
  vi.clearAllMocks();
  canAccess.mockImplementation(() => true);
});

describe('saveNotes', () => {
  it('saves the trimmed note', async () => {
    expect(await saveNotes(event({ id: '12', internalNotes: '  checked the IP  ' }))).toEqual({
      success: true,
    });
    expect(updateReportNotes).toHaveBeenCalledWith({ id: 12, internalNotes: 'checked the IP' });
  });

  it('an empty note clears it', async () => {
    await saveNotes(event({ id: '12', internalNotes: '   ' }));
    expect(updateReportNotes).toHaveBeenCalledWith({ id: 12, internalNotes: null });
  });

  it('needs the page path, as the ruling does', async () => {
    canAccess.mockImplementation((_u, path) => path !== '/reports/user');
    expect(status(await saveNotes(event({ id: '12', internalNotes: 'x' })))).toBe(403);
    expect(canAccess).toHaveBeenCalledWith({ id: 7 }, '/reports/user');
    expect(updateReportNotes).not.toHaveBeenCalled();
  });

  it('refuses a note past the cap', async () => {
    expect(status(await saveNotes(event({ id: '12', internalNotes: 'x'.repeat(5001) })))).toBe(400);
    expect(updateReportNotes).not.toHaveBeenCalled();
  });

  // The page reloads on `gone`, so the deleted report leaves the list instead of claiming a save.
  it('says gone for a report deleted while the note was typed', async () => {
    updateReportNotes.mockResolvedValueOnce({ ok: false });
    expect(await saveNotes(event({ id: '12', internalNotes: 'x' }))).toMatchObject({
      status: 410,
      data: { gone: true },
    });
  });
});
