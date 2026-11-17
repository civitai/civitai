import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ClientEnv from '~/env/client';
import type * as VideoEnhancement from '~/server/services/orchestrator/videoEnhancement';

// 🔴 Do NOT mock `~/env/server` here — see `deprecated-rewards.gate.test.ts` for why importing
// `orchestrator.router` relies on the canonical env mock.

const h = vi.hoisted(() => ({ getVideoMetadata: vi.fn() }));

// The video-metadata step runs on the system orchestrator token, so the router decides which
// urls reach it. Faked at the service, so the assertion is on what the router lets through.
vi.mock('~/server/services/orchestrator/videoEnhancement', async (importOriginal) => ({
  ...(await importOriginal<typeof VideoEnhancement>()),
  getVideoMetadata: h.getVideoMetadata,
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: vi.fn(async () => 'token'),
}));
// Pinned rather than left to the schema default, so the public-host case does not depend on
// whatever the CI environment sets.
vi.mock('~/env/client', async (importOriginal) => {
  const actual = await importOriginal<typeof ClientEnv>();
  return {
    ...actual,
    env: { ...actual.env, NEXT_PUBLIC_ORCHESTRATOR_ENDPOINT: 'https://orchestration.civitai.com' },
  };
});

import { setEnv } from '~/__tests__/mocks/env.mock';
import { OnboardingSteps } from '~/server/common/enums';
import { orchestratorRouter } from '~/server/routers/orchestrator.router';
import { KNOWN_ORCHESTRATOR_HOSTS } from '~/server/services/orchestrator/trusted-blob-url';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const caller = () =>
  orchestratorRouter.createCaller({
    user: {
      id: 7,
      onboarding: OnboardingSteps.Buzz,
      emailVerified: new Date('2020-01-01'),
      muted: false,
      bannedAt: null,
      showNsfw: false,
    },
    ip: '1.2.3.4',
    features: {},
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
  } as never);

// The shape VideoInput holds after an upload: a presigned consumer blob on the orchestrator.
const BLOB = '/v2/consumer/blobs/ABC123.mp4?sig=x&exp=2099-01-01T00:00:00Z';
const METADATA = { width: 640, height: 360, fps: 24, duration: '00:00:05' };

describe('orchestrator.getVideoMetadata — which video urls reach the system-token step', () => {
  beforeEach(() => {
    h.getVideoMetadata.mockReset().mockResolvedValue(METADATA);
    // An internal address, as in production: it must not be what makes a public url trusted.
    setEnv({ ORCHESTRATOR_ENDPOINT: 'http://orchestrator.internal:8080' });
  });

  it.each([
    ['a third-party https host', 'https://example.com/video.mp4'],
    ['a lookalike suffix', `https://orchestration.civitai.com.example.net${BLOB}`],
    ['a non-orchestrator Civitai host', `https://civitai.com${BLOB}`],
    ['plain http', `http://orchestration.civitai.com${BLOB}`],
    ['userinfo', `https://user:pass@orchestration.civitai.com${BLOB}`],
    ['a non-default port', `https://orchestration.civitai.com:8443${BLOB}`],
    ['a fragment', `https://orchestration.civitai.com${BLOB}#x`],
    ['a malformed url', 'not a url'],
    ['an empty string', ''],
  ])('refuses %s without running the step', async (_label, videoUrl) => {
    await expect(caller().getVideoMetadata({ videoUrl })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(h.getVideoMetadata).not.toHaveBeenCalled();
  });

  it('accepts a just-uploaded blob on the public orchestrator host', async () => {
    const videoUrl = `https://orchestration.civitai.com${BLOB}`;
    await expect(caller().getVideoMetadata({ videoUrl })).resolves.toEqual(METADATA);
    expect(h.getVideoMetadata).toHaveBeenCalledWith({ videoUrl });
  });

  it('accepts a blob on every known orchestrator host', async () => {
    for (const host of KNOWN_ORCHESTRATOR_HOSTS) {
      const videoUrl = `https://${host}${BLOB}`;
      await expect(caller().getVideoMetadata({ videoUrl }), host).resolves.toEqual(METADATA);
      expect(h.getVideoMetadata, host).toHaveBeenLastCalledWith({ videoUrl });
    }
  });

  // A proxied region's Queue hands the browser region-proxy urls, and VideoInput asks for their
  // metadata. The proxy fronts the same orchestrator, so the step reads the same blob from the
  // orchestrator host rather than being refused.
  it('reads a region-proxy blob from the public orchestrator host', async () => {
    await expect(
      caller().getVideoMetadata({ videoUrl: `https://orchestration-proxy.civitai.com${BLOB}` })
    ).resolves.toEqual(METADATA);
    expect(h.getVideoMetadata).toHaveBeenCalledWith({
      videoUrl: `https://orchestration.civitai.com${BLOB}`,
    });
  });

  it('still applies the orchestrator-url rule to a region-proxy url (an @ in the query)', async () => {
    await expect(
      caller().getVideoMetadata({
        videoUrl: `https://orchestration-proxy.civitai.com${BLOB}&next=@example.com`,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(h.getVideoMetadata).not.toHaveBeenCalled();
  });
});
