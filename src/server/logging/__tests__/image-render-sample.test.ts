import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The sampled log of signed-in `/images/[imageId]` HTML renders. It exists to measure how often
 * the SAME image URL is rendered again within 60 s at the SAME Cloudflare colo (a sliding window
 * over each record's own timestamp). So the line carries exactly imageId and colo — no
 * user, cookie or address — and is dark until the `shell-images-render-sample` Flipt flag is on.
 *
 * Flipt is mocked key-aware (only the real key answers), so a typo in the declared `fliptKey`
 * turns the "logs" cases red. `~/server/logging/client` is the canonical shared mock (registered
 * by the test setup), so nothing reaches stderr.
 */

const mocks = vi.hoisted(() => ({
  isFliptSync: vi.fn((_key: string, _entity?: string, _ctx?: unknown): boolean | null => null),
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(async () => false),
  isFliptSync: mocks.isFliptSync,
  ensureFliptInitialized: vi.fn(async () => undefined),
  getFliptClientSync: vi.fn(() => null),
}));

import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type * as FliptClient from '~/server/flipt/client';
import type { SessionUser } from '~/types/session';
import {
  __resetImageRenderSampleForTest,
  cfRayColo,
  IMAGE_RENDER_SAMPLE_MAX_PER_SEC,
  sampleImageRender,
} from '~/server/logging/image-render-sample';
import { getFeatureFlagsAsync } from '~/server/services/feature-flags.service';

const logToAxiom = loggingMock.logToAxiom;
const FLAG_KEY = 'shell-images-render-sample';
const ROUTE = '/images/[imageId]';
// 2026-10-22T10:15:42.123Z
const NOW = Date.UTC(2026, 9, 22, 10, 15, 42, 123);

const USER_ID = 4242;
const IMAGE_ID = '918273';
const COOKIE = '__Secure-civ-token=tok-zz9q';
const CLIENT_IP = '203.0.113.77';

// A fresh host per call: the flag registry caches its whole result per (user, host) for 10 s, so a
// shared host would serve one test's flag state to the next.
let hostSeq = 0;

type Req = Parameters<typeof sampleImageRender>[2];

function signedInReq(overrides: Partial<Req> = {}): Req {
  return {
    url: `/images/${IMAGE_ID}`,
    headers: {
      host: `h${++hostSeq}.example`,
      'cf-ray': '8f00aa11bb22cc33-SJC',
      cookie: COOKIE,
      'x-forwarded-for': CLIENT_IP,
      'cf-connecting-ip': CLIENT_IP,
    },
    session: { user: { id: USER_ID } },
    ...overrides,
  } as Req;
}

function flagOn() {
  mocks.isFliptSync.mockImplementation((key: string) => (key === FLAG_KEY ? true : null));
}

beforeEach(() => {
  __resetImageRenderSampleForTest();
  logToAxiom.mockClear();
  mocks.isFliptSync.mockReset();
  mocks.isFliptSync.mockImplementation(() => null);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sampleImageRender', () => {
  it('logs exactly imageId and colo for a signed-in render when the flag is on', async () => {
    flagOn();
    await sampleImageRender(ROUTE, { imageId: IMAGE_ID }, signedInReq(), NOW);
    expect(logToAxiom).toHaveBeenCalledTimes(1);
    const [payload, datastream] = logToAxiom.mock.calls[0] as unknown as [
      Record<string, unknown>,
      string | undefined
    ];
    expect(payload).toStrictEqual({
      name: 'shell-images-render-sample',
      type: 'info',
      imageId: 918273,
      colo: 'SJC',
    });
    expect(datastream).toBeUndefined();
    // Nothing identifying leaks in under another name.
    const text = JSON.stringify(payload);
    for (const secret of [String(USER_ID), 'tok-zz9q', CLIENT_IP])
      expect(text).not.toContain(secret);
  });

  it('evaluates the flag user-independently (entity "anonymous"), never per viewer', async () => {
    flagOn();
    await sampleImageRender(ROUTE, { imageId: IMAGE_ID }, signedInReq(), NOW);
    const calls = mocks.isFliptSync.mock.calls.filter(([key]) => key === FLAG_KEY);
    expect(calls.length).toBeGreaterThan(0);
    for (const [, entity] of calls) expect(entity).toBe('anonymous');
  });

  it('logs nothing while the flag is off or Flipt has no answer', async () => {
    await sampleImageRender(ROUTE, { imageId: IMAGE_ID }, signedInReq(), NOW);
    mocks.isFliptSync.mockImplementation((key: string) => (key === FLAG_KEY ? false : null));
    await sampleImageRender(ROUTE, { imageId: IMAGE_ID }, signedInReq(), NOW);
    expect(logToAxiom).not.toHaveBeenCalled();
    // Control: the same request logs once the flag answers true.
    flagOn();
    await sampleImageRender(ROUTE, { imageId: IMAGE_ID }, signedInReq(), NOW);
    expect(logToAxiom).toHaveBeenCalledTimes(1);
  });

  it.each<[string, string, Record<string, unknown>, Partial<Req>]>([
    ['an anonymous render', ROUTE, { imageId: IMAGE_ID }, { session: undefined }],
    [
      'a render whose session did not resolve',
      ROUTE,
      { imageId: IMAGE_ID },
      { session: undefined, sessionUnresolved: true },
    ],
    ['the /images feed', '/images', { imageId: IMAGE_ID }, {}],
    ['a notFound render', '/404', { imageId: IMAGE_ID }, {}],
    [
      'a /_next/data request',
      ROUTE,
      { imageId: IMAGE_ID },
      { url: `/_next/data/b/images/${IMAGE_ID}.json` },
    ],
    ['a non-numeric imageId', ROUTE, { imageId: '12abc' }, {}],
    ['a missing imageId', ROUTE, {}, {}],
  ])('logs nothing for %s', async (_, route, query, overrides) => {
    flagOn();
    await sampleImageRender(route, query, signedInReq(overrides), NOW);
    expect(logToAxiom).not.toHaveBeenCalled();
    // Positive control: the unmodified request does log under the same flag state.
    await sampleImageRender(ROUTE, { imageId: IMAGE_ID }, signedInReq(), NOW);
    expect(logToAxiom).toHaveBeenCalledTimes(1);
  });

  it(`caps output at ${IMAGE_RENDER_SAMPLE_MAX_PER_SEC} lines per second and reports what it dropped`, async () => {
    flagOn();
    expect(IMAGE_RENDER_SAMPLE_MAX_PER_SEC).toBe(20);
    for (let i = 0; i < 27; i++) {
      await sampleImageRender(ROUTE, { imageId: String(1000 + i) }, signedInReq(), NOW + i);
    }
    expect(logToAxiom).toHaveBeenCalledTimes(20);
    expect(logToAxiom.mock.calls.map(([p]) => p.imageId)).toEqual(
      Array.from({ length: 20 }, (_, i) => 1000 + i)
    );
    for (const [p] of logToAxiom.mock.calls) expect(p).not.toHaveProperty('droppedSinceLastLog');

    // The next window logs again and carries the 7 lines the cap suppressed.
    await sampleImageRender(ROUTE, { imageId: '5555' }, signedInReq(), NOW + 1000);
    expect(logToAxiom).toHaveBeenCalledTimes(21);
    expect(logToAxiom.mock.calls[20][0]).toStrictEqual({
      name: 'shell-images-render-sample',
      type: 'info',
      imageId: 5555,
      colo: 'SJC',
      droppedSinceLastLog: 7,
    });
    // ...and only once.
    await sampleImageRender(ROUTE, { imageId: '5556' }, signedInReq(), NOW + 1001);
    expect(logToAxiom.mock.calls[21][0]).not.toHaveProperty('droppedSinceLastLog');
  });

  it('does not spend the cap on renders the flag rejects', async () => {
    for (let i = 0; i < 30; i++) {
      await sampleImageRender(ROUTE, { imageId: IMAGE_ID }, signedInReq(), NOW);
    }
    flagOn();
    await sampleImageRender(ROUTE, { imageId: IMAGE_ID }, signedInReq(), NOW);
    expect(logToAxiom).toHaveBeenCalledTimes(1);
    expect(logToAxiom.mock.calls[0][0]).not.toHaveProperty('droppedSinceLastLog');
  });

  it('never throws, even when the log write rejects', async () => {
    flagOn();
    logToAxiom.mockRejectedValueOnce(new Error('sink down'));
    await expect(
      sampleImageRender(ROUTE, { imageId: IMAGE_ID }, signedInReq(), NOW)
    ).resolves.toBeUndefined();
  });

  it('logs nothing in the browser', async () => {
    flagOn();
    vi.stubGlobal('window', {});
    await sampleImageRender(ROUTE, { imageId: IMAGE_ID }, signedInReq(), NOW);
    expect(logToAxiom).not.toHaveBeenCalled();
  });
});

describe('cfRayColo', () => {
  it.each<[string | string[] | undefined, string]>([
    ['8f00aa11bb22cc33-SJC', 'SJC'],
    ['8f00aa11bb22cc33-FRA', 'FRA'],
    [['8f00aa11bb22cc33-NRT', '1-LHR'], 'NRT'],
    ['8f00aa11bb22cc33-sjc', 'unknown'],
    ['8f00aa11bb22cc33-SJCX', 'unknown'],
    ['8f00aa11bb22cc33-', 'unknown'],
    ['SJC', 'unknown'],
    ['-SJC', 'unknown'],
    ['', 'unknown'],
    [undefined, 'unknown'],
  ])('%j -> %s', (raw, colo) => {
    expect(cfRayColo(raw)).toBe(colo);
  });
});

describe('shellImagesRenderSample flag declaration', () => {
  const mod = { id: 9511, isModerator: true, tier: 'free' } as SessionUser;

  it('is dark for a moderator and an anonymous visitor when Flipt has no answer', async () => {
    const modFlags = await getFeatureFlagsAsync({ user: mod });
    // Control: the same context switches on a mod-available flag.
    expect(modFlags.creatorShop).toBe(true);
    expect(modFlags.shellImagesRenderSample).toBeUndefined();
    const anonFlags = await getFeatureFlagsAsync({ host: 'dark-check.example' });
    expect(anonFlags.canWrite).toBe(true);
    expect(anonFlags.shellImagesRenderSample).toBeUndefined();
  });

  it('is on when its own Flipt key says so', async () => {
    flagOn();
    const flags = await getFeatureFlagsAsync({ host: 'on-check.example' });
    expect(flags.shellImagesRenderSample).toBe(true);
  });
});
