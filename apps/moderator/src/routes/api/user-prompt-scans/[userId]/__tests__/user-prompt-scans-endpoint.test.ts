import { beforeEach, describe, expect, it, vi } from 'vitest';

const getPromptScans = vi.fn();
vi.mock('$lib/server/prompt-scans.service', () => ({ getPromptScans }));
const logToAxiom = vi.fn(async (_data: Record<string, unknown>) => undefined);
vi.mock('$lib/server/axiom', () => ({ logToAxiom }));
const canAccess = vi.fn((_user: unknown, _path: string) => true);
vi.mock('$lib/server/access', () => ({ canAccess }));

const { GET } = await import('../+server');

const call = (
  search = '',
  grants: Record<string, boolean> = { 'user.generations.view': true },
  userId = '5'
) =>
  GET({
    params: { userId },
    url: new URL(`http://x/api/user-prompt-scans/${userId}${search}`),
    locals: { user: { id: 1 }, grants },
    request: new Request('http://x'),
  } as never) as Promise<Response>;

beforeEach(() => {
  vi.clearAllMocks();
  canAccess.mockImplementation(() => true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  getPromptScans.mockResolvedValue([
    { id: 'h', createdAt: 't', prompt: 'p', negativePrompt: null, scores: [] },
  ]);
});

describe('/api/user-prompt-scans', () => {
  it('refuses a moderator without user.generations.view, before any query', async () => {
    await expect(call('', {})).rejects.toMatchObject({ status: 403 });
    expect(getPromptScans).not.toHaveBeenCalled();
  });

  it('refuses a moderator who cannot open User Lookup, before any query', async () => {
    canAccess.mockImplementation(() => false);
    await expect(call()).rejects.toMatchObject({ status: 403 });
    expect(canAccess).toHaveBeenCalledWith(expect.anything(), '/retool/user-lookup');
    expect(getPromptScans).not.toHaveBeenCalled();
  });

  it('refuses an id that is not a positive integer', async () => {
    await expect(call('', undefined, '5 OR 1=1')).rejects.toMatchObject({ status: 400 });
    expect(getPromptScans).not.toHaveBeenCalled();
  });

  it('records who read whose prompts, over what window, and how many rows', async () => {
    const res = await call('?days=90&limit=250');
    expect(await res.json()).toMatchObject({ items: [{ id: 'h' }], days: 90, limit: 250 });
    expect(getPromptScans).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ days: 90, limit: 250 })
    );
    expect(logToAxiom).toHaveBeenCalledTimes(1);
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'user-prompt-scans-view',
        moderatorId: 1,
        subjectUserId: 5,
        days: 90,
        limit: 250,
        rows: 1,
      })
    );
  });

  it('falls back to the default window and cap for values it does not offer', async () => {
    await call('?days=36500&limit=1000000');
    expect(getPromptScans).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ days: 7, limit: 100 })
    );
  });

  it('still serves the read when the audit log write fails', async () => {
    logToAxiom.mockRejectedValueOnce(new Error('axiom down'));
    const res = await call();
    expect(res.status).toBe(200);
  });

  it('answers a ClickHouse failure with a status Cloudflare passes through, and logs no view', async () => {
    getPromptScans.mockRejectedValue(new Error('ACCESS_DENIED'));
    const res = await call();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Could not read the prompt scans.' });
    expect(logToAxiom).not.toHaveBeenCalled();
  });
});
