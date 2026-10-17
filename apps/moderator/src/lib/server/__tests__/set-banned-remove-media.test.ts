import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Minor-safety bans always remove media. The main app's `toggleBan` enforces that whatever is sent;
 * `setBanned` sends `removeMedia=true` for those reasons too, so the rule holds whichever app deploys
 * first and whatever a locked checkbox posts (a disabled input posts nothing).
 */

const captured = vi.hoisted(() => [] as string[]);

vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  // Not banned yet, so every call below takes the ban path.
  return {
    dbRead: capturingDb(captured, [{ bannedAt: null }]),
    dbWrite: capturingDb(captured, [{ bannedAt: null }]),
  };
});
vi.mock('../mod-activity', () => ({
  recordModActivity: vi.fn(async () => undefined),
  recordModActivityBatch: vi.fn(),
}));
vi.mock('$env/dynamic/private', () => ({
  env: { CIVITAI_APP_URL: 'https://civitai.com', WEBHOOK_TOKEN: 'shared-secret' },
}));
vi.mock('$app/server', () => ({ getRequestEvent: () => ({ locals: {} }) }));

const { setBanned } = await import('../user-actions.service');

let urls: string[];

beforeEach(() => {
  vi.unstubAllGlobals();
  urls = [];
  captured.length = 0;
  vi.stubGlobal('fetch', (url: string) => {
    urls.push(String(url));
    return Promise.resolve(new Response('{}', { status: 200 }));
  });
});

const sentRemoveMedia = async (reasonCode: string, removeMedia?: boolean) => {
  expect(
    await setBanned({ userId: 42, ban: true, reasonCode, removeMedia, moderatorId: 7 })
  ).toEqual({ ok: true });
  expect(urls).toHaveLength(1);
  return new URL(urls[0]).searchParams.get('removeMedia');
};

describe('setBanned removeMedia', () => {
  it.each(['SexualMinor', 'SexualMinorGenerator', 'SexualMinorTraining'])(
    'sends removeMedia=true for a %s ban the moderator left unticked',
    async (reasonCode) => {
      expect(await sentRemoveMedia(reasonCode, false)).toBe('true');
    }
  );

  it.each([
    [false, null],
    [true, 'true'],
  ] as const)('leaves a Harassment ban opt-in (ticked=%s)', async (ticked, sent) => {
    expect(await sentRemoveMedia('Harassment', ticked)).toBe(sent);
  });
});
