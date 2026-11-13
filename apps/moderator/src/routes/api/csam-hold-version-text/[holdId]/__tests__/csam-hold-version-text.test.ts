import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/db', () => ({ dbRead: {} }));
const getHoldVersionTexts = vi.fn();
vi.mock('$lib/server/csam-holds.queries', () => ({ getHoldVersionTexts }));
const canAccess = vi.fn((_user: unknown, _path: string) => true);
vi.mock('$lib/server/access', () => ({ canAccess }));

const { GET } = await import('../+server');

const call = (holdId: string, grants: Record<string, boolean> = { 'csam.report.file': true }) =>
  GET({ params: { holdId }, locals: { user: { id: 1 }, grants } } as never);

const status = (response: unknown) =>
  Promise.resolve(response).then(
    (res) => (res as Response).status,
    (err: { status?: number }) => err.status
  );

beforeEach(() => {
  vi.clearAllMocks();
  canAccess.mockImplementation(() => true);
  getHoldVersionTexts.mockResolvedValue({
    hits: [{ versionId: 700, field: 'name', text: 'v one', state: 'unchanged' }],
  });
});

describe('/api/csam-hold-version-text', () => {
  it('serves the flagged strings, uncached', async () => {
    const res = await call('7');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      hits: [{ versionId: 700, field: 'name', text: 'v one', state: 'unchanged' }],
    });
    expect(getHoldVersionTexts).toHaveBeenCalledWith(7);
  });

  it('refuses a moderator without the csam filing grant', async () => {
    expect(await status(call('7', {}))).toBe(403);
    expect(getHoldVersionTexts).not.toHaveBeenCalled();
  });

  it('refuses a moderator without access to the holds page', async () => {
    canAccess.mockImplementation(() => false);
    expect(await status(call('7'))).toBe(403);
    expect(getHoldVersionTexts).not.toHaveBeenCalled();
  });

  it('answers 404 for a hold with no flagged version text', async () => {
    getHoldVersionTexts.mockResolvedValue(null);
    expect(await status(call('7'))).toBe(404);
  });

  it('logs a failed read without its error message', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getHoldVersionTexts.mockRejectedValue(
      Object.assign(new Error('select failed near "v one"'), { name: 'DatabaseError' })
    );
    expect(await status(call('7'))).toBe(500);
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain('DatabaseError');
    expect(logged).not.toContain('v one');
    log.mockRestore();
  });
});
