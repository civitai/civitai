import { beforeEach, describe, expect, it, vi } from 'vitest';

const { callMainApp, flag } = vi.hoisted(() => ({ callMainApp: vi.fn(), flag: { on: true } }));
vi.mock('$lib/server/main-app', () => ({ callMainApp }));
vi.mock('$lib/server/main-app-flags', () => ({ darkFlagEnabled: vi.fn(async () => flag.on) }));
vi.mock('$lib/server/session-cookies', () => ({ sessionCookies: () => 'cookie' }));

const { GET, DELETE } = await import('./+server');

const BATCH = '00000000-0000-4000-8000-000000000001';
const get = (versionId: string, qs: string) => {
  const url = new URL(`https://studio.test/models/gifts/${versionId}/claims?${qs}`);
  return GET({
    params: { versionId },
    url,
    locals: { user: { id: 7 } },
    request: new Request(url),
  } as unknown as Parameters<typeof GET>[0]);
};

beforeEach(() => {
  flag.on = true;
  callMainApp.mockReset();
  callMainApp.mockResolvedValue({ ok: true, data: { claims: [], nextCursor: null } });
});

describe('/models/gifts/[versionId]/claims', () => {
  it('is not found while the gift-links flag is off', async () => {
    flag.on = false;
    await expect(get('5', 'giftId=9')).rejects.toMatchObject({ status: 404 });
    expect(callMainApp).not.toHaveBeenCalled();
  });

  it("asks the main app for a link's or a batch's claimers on this version", async () => {
    await get('5', 'giftId=9&cursor=a%2Bb');
    await get('5', `batchId=${BATCH}`);
    expect(callMainApp.mock.calls.map((c) => c[1])).toEqual(['cookie', 'cookie']);
    expect(callMainApp.mock.calls.map((c) => c[0])).toEqual([
      '/api/v1/model-versions/5/gifts/9/claims?cursor=a%2Bb',
      `/api/v1/model-versions/5/gifts/batch/${BATCH}/claims`,
    ]);
  });

  it('refuses a malformed request without calling the main app', async () => {
    for (const [v, qs] of [
      ['5', ''],
      ['5', 'giftId=x'],
      ['5', 'batchId=nope'],
      ['../x', 'giftId=9'],
    ])
      await expect(get(v, qs)).rejects.toMatchObject({ status: 400 });
    expect(callMainApp).not.toHaveBeenCalled();
  });

  it("passes on the main app's refusal", async () => {
    callMainApp.mockResolvedValueOnce({
      ok: false,
      status: 403,
      error: 'You do not own this model version.',
    });
    await expect(get('5', 'giftId=9')).rejects.toMatchObject({ status: 403 });
  });
});

describe('DELETE /models/gifts/[versionId]/claims', () => {
  const del = (versionId: string, qs: string) => {
    const url = new URL(`https://studio.test/models/gifts/${versionId}/claims?${qs}`);
    return DELETE({
      params: { versionId },
      url,
      locals: { user: { id: 7 } },
      request: new Request(url, { method: 'DELETE' }),
    } as unknown as Parameters<typeof DELETE>[0]);
  };

  it("asks the main app to remove that claimer's gifted access on this version", async () => {
    callMainApp.mockResolvedValueOnce({ ok: true, data: { removed: true } });
    const res = await del('5', 'giftId=9&userId=20');
    expect(await res.json()).toEqual({ removed: true });
    expect(callMainApp).toHaveBeenCalledWith(
      '/api/v1/model-versions/5/gifts/9/claims/20',
      'cookie',
      { method: 'DELETE' }
    );
  });

  it('is not found while the gift-links flag is off', async () => {
    flag.on = false;
    await expect(del('5', 'giftId=9&userId=20')).rejects.toMatchObject({ status: 404 });
    expect(callMainApp).not.toHaveBeenCalled();
  });

  it('refuses a malformed request without calling the main app', async () => {
    for (const [v, qs] of [
      ['5', 'giftId=9'],
      ['5', 'userId=20'],
      ['5', 'giftId=9&userId=x'],
      ['5', 'giftId=0&userId=20'],
      ['5', 'giftId=9&userId=0'],
      ['../x', 'giftId=9&userId=20'],
    ])
      await expect(del(v, qs)).rejects.toMatchObject({ status: 400 });
    expect(callMainApp).not.toHaveBeenCalled();
  });

  it("passes on the main app's refusal", async () => {
    callMainApp.mockResolvedValueOnce({ ok: false, status: 404, error: 'No claim to remove.' });
    await expect(del('5', 'giftId=9&userId=20')).rejects.toMatchObject({ status: 404 });
  });
});
