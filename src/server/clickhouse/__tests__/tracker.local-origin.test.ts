import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({
  CLICKHOUSE_TRACKER_URL: 'http://tracker.test',
  NEXT_PUBLIC_CIVITAI_LINK: undefined as string | undefined,
  NEXT_PUBLIC_LOCAL_TRACKER_ENABLED: undefined as string | undefined,
}));
vi.mock('~/env/server', () => ({ env: mockEnv }));
vi.mock('~/env/other', () => ({ isProd: false, isDev: true }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => null),
}));

import { Tracker } from '../client';

describe('Tracker on a local origin', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  async function emit() {
    const tracker = new Tracker(undefined, undefined, null);
    await tracker.blockRender({
      appBlockId: 'ab_1',
      blockInstanceId: 'inst_1',
      slotId: 'app.page',
      isAnon: true,
    });
    await new Promise((r) => setImmediate(r));
  }

  it('drops events when the origin is unset outside production', async () => {
    mockEnv.NEXT_PUBLIC_CIVITAI_LINK = undefined;
    mockEnv.NEXT_PUBLIC_LOCAL_TRACKER_ENABLED = undefined;
    await emit();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops events when the origin is local, even with a tracker URL configured', async () => {
    mockEnv.NEXT_PUBLIC_CIVITAI_LINK = 'http://localhost:3000';
    mockEnv.NEXT_PUBLIC_LOCAL_TRACKER_ENABLED = undefined;
    await emit();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends again once the local opt-in is set', async () => {
    mockEnv.NEXT_PUBLIC_CIVITAI_LINK = 'http://localhost:3000';
    mockEnv.NEXT_PUBLIC_LOCAL_TRACKER_ENABLED = 'true';
    await emit();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Positive control: a deployed origin keeps sending with no flag.
  it('sends from a deployed origin', async () => {
    mockEnv.NEXT_PUBLIC_CIVITAI_LINK = 'https://civitai.com';
    mockEnv.NEXT_PUBLIC_LOCAL_TRACKER_ENABLED = undefined;
    await emit();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
