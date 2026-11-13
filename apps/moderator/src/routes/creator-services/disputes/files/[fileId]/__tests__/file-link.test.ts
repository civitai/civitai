import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyGrants, canAccess } from '$lib/server/access';

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

const getDealFileUrl = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/creator-services-disputes.service', () => ({ getDealFileUrl }));

const { GET } = await import('../+server');

const call = (fileId: string) =>
  GET({ params: { fileId } } as unknown as Parameters<typeof GET>[0]);

const outcome = async (fileId: string) => {
  try {
    await call(fileId);
    return { kind: 'returned' as const };
  } catch (e) {
    return { kind: 'thrown' as const, e: e as { status: number; location?: string } };
  }
};

beforeEach(() => vi.clearAllMocks());

describe('moderator file link', () => {
  it('redirects the browser to the signed URL the main app issued', async () => {
    getDealFileUrl.mockResolvedValue({ ok: true, url: 'https://files.example/signed?sig=1' });
    const result = await outcome('41');
    expect(getDealFileUrl).toHaveBeenCalledWith(41);
    expect(result).toMatchObject({
      kind: 'thrown',
      e: { status: 302, location: 'https://files.example/signed?sig=1' },
    });
  });

  it('refuses a non-numeric id before asking the main app', async () => {
    const result = await outcome('41; drop');
    expect(result).toMatchObject({ kind: 'thrown', e: { status: 400 } });
    expect(getDealFileUrl).not.toHaveBeenCalled();
  });

  it('passes an unknown file through as 404 and a relay failure as 502', async () => {
    getDealFileUrl.mockResolvedValue({ ok: false, status: 404, error: 'Not found' });
    expect(await outcome('9')).toMatchObject({ kind: 'thrown', e: { status: 404 } });
    getDealFileUrl.mockResolvedValue({ ok: false, status: 502, error: 'File link failed.' });
    expect(await outcome('9')).toMatchObject({ kind: 'thrown', e: { status: 502 } });
  });
});

describe('the file route sits behind the page grant', () => {
  it('is reachable only by a role granted the disputes page', () => {
    const reviewer = { roles: ['moderator:reviewer'] };
    applyGrants({});
    expect(canAccess(reviewer, '/creator-services/disputes/files/41')).toBe(false);
    applyGrants({ '/creator-services/disputes': ['moderator:reviewer'] });
    expect(canAccess(reviewer, '/creator-services/disputes/files/41')).toBe(true);
    expect(canAccess({ roles: ['moderator:other'] }, '/creator-services/disputes/files/41')).toBe(
      false
    );
  });
});
