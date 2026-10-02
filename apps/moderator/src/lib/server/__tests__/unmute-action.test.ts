import { beforeEach, describe, expect, it, vi } from 'vitest';

const recordModActivity = vi.hoisted(() => vi.fn(async () => undefined));
const recordUserActivity = vi.hoisted(() => vi.fn(async () => undefined));
const timedMuteRow = vi.hoisted(() => ({ value: [] as unknown[] }));
const captured = vi.hoisted(() => [] as string[]);

vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  return {
    dbRead: capturingDb(captured, timedMuteRow.value),
    dbWrite: capturingDb(captured, []),
  };
});
vi.mock('../mod-activity', () => ({ recordModActivity, recordModActivityBatch: vi.fn() }));
vi.mock('../user-activity', () => ({ recordUserActivity }));
vi.mock('$env/dynamic/private', () => ({
  env: { CIVITAI_APP_URL: 'https://civitai.com', WEBHOOK_TOKEN: 'shared-secret' },
}));
vi.mock('$app/server', () => ({
  getRequestEvent: () => ({
    locals: {},
    request: { headers: new Headers({ cookie: 'civ-token=the-moderators-session' }) },
  }),
}));

const { revokeTimedMute, setMuted } = await import('../user-actions.service');

type Call = { url: string; body: unknown };
let calls: Call[];
let status = 200;

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  calls = [];
  status = 200;
  captured.length = 0;
  timedMuteRow.value.length = 0;
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return Promise.resolve(
      new Response(JSON.stringify(status === 200 ? { muted: false } : { message: 'refused' }), {
        status,
      })
    );
  });
});

describe('moderator-app unmutes go through the main app', () => {
  it('setMuted(false) posts to /api/mod/user/unmute and writes nothing itself', async () => {
    expect(await setMuted({ userId: 42, muted: false, moderatorId: 7 })).toEqual({ ok: true });

    expect(calls).toEqual([
      { url: 'https://civitai.com/api/mod/user/unmute', body: { userId: 42, activity: 'unmute' } },
    ]);
    expect(captured.filter((sql) => /^update/i.test(sql))).toEqual([]);
    expect(recordModActivity).not.toHaveBeenCalled();
    expect(recordUserActivity).toHaveBeenCalledWith('Unmuted', 42, 7);
  });

  it('revokeTimedMute asks the main app to lift only a timed mute', async () => {
    timedMuteRow.value.push({ mutedAt: new Date(), muteExpiresAt: new Date(), meta: {} });
    expect(await revokeTimedMute({ userId: 42, moderatorId: 7 })).toEqual({ ok: true });

    expect(calls).toEqual([
      {
        url: 'https://civitai.com/api/mod/user/unmute',
        body: { userId: 42, activity: 'revokeTimedMute' },
      },
    ]);
    expect(recordModActivity).not.toHaveBeenCalled();
  });

  it('reports a refusal and records nothing', async () => {
    status = 400;
    const result = await setMuted({ userId: 42, muted: false, moderatorId: 7 });
    expect(result.ok).toBe(false);
    expect(recordUserActivity).not.toHaveBeenCalled();
  });

  it('a mute is still written here', async () => {
    await setMuted({ userId: 42, muted: true, moderatorId: 7 });
    expect(calls).toEqual([]);
    expect(captured.some((sql) => /^update "User"/i.test(sql))).toBe(true);
  });
});
