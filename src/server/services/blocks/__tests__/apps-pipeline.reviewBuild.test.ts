import { createHmac } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * MOD REVIEW SANDBOX (#2831) — triggerReviewBuild + the pure review helpers.
 *
 * triggerReviewBuild must mirror triggerBuild's signing contract exactly (same
 * APPS_TEKTON_TRIGGER_SECRET, integer `ts` inside the signed body) but carry
 * `mode:'review'` + publishRequestId + modUserId and POST to the review endpoint.
 */

const { TRIGGER_SECRET, mockEnv } = vi.hoisted(() => {
  const TRIGGER_SECRET = 'trigger-secret';
  return {
    TRIGGER_SECRET,
    mockEnv: {
      APPS_TEKTON_TRIGGER_URL: 'http://trigger.example/trigger-build',
      APPS_TEKTON_TRIGGER_SECRET: TRIGGER_SECRET,
      APPS_TEKTON_REVIEW_TRIGGER_URL: undefined,
      APPS_DOMAIN: 'civit.ai',
      APPS_KUBE_NAMESPACE: 'civitai-apps',
    } as Record<string, unknown>,
  };
});
vi.mock('~/env/server', () => ({ env: mockEnv }));

import {
  triggerReviewBuild,
  reviewHost,
  reviewHostSha,
  reviewImageRef,
  resolveReviewTriggerUrl,
} from '~/server/services/blocks/apps-pipeline.service';

describe('review pure helpers', () => {
  it('reviewHostSha truncates to 16 chars', () => {
    expect(reviewHostSha('a'.repeat(40))).toBe('a'.repeat(16));
  });

  it('reviewHost builds review-<sha16>.<domain>', () => {
    expect(reviewHost('b'.repeat(40), 'civit.ai')).toBe(`review-${'b'.repeat(16)}.civit.ai`);
  });

  it('review host label stays under the 63-char DNS limit', () => {
    const host = reviewHost('f'.repeat(40), 'civit.ai');
    const label = host.split('.')[0];
    expect(label.length).toBeLessThanOrEqual(63);
    expect(label).toMatch(/^review-[0-9a-f]{16}$/);
  });

  it('reviewImageRef is the review-prefixed ghcr image (distinct from production)', () => {
    expect(reviewImageRef('my-app', 'c'.repeat(40))).toBe(
      `ghcr.io/civitai/app-block-review-my-app:${'c'.repeat(40)}`
    );
  });

  it('resolveReviewTriggerUrl prefers the explicit override', () => {
    expect(resolveReviewTriggerUrl('http://x/trigger-review-build', 'http://y/trigger-build')).toBe(
      'http://x/trigger-review-build'
    );
  });

  it('resolveReviewTriggerUrl derives from the build URL when no override', () => {
    expect(resolveReviewTriggerUrl(undefined, 'http://y/trigger-build')).toBe(
      'http://y/trigger-review-build'
    );
  });

  it('resolveReviewTriggerUrl throws when neither configured', () => {
    expect(() => resolveReviewTriggerUrl(undefined, undefined)).toThrow();
  });
});

describe('triggerReviewBuild', () => {
  let captured: { url: string; body: string; sig: string } | null = null;

  beforeEach(() => {
    captured = null;
    mockEnv.APPS_TEKTON_REVIEW_TRIGGER_URL = undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        captured = {
          url,
          body: String(init.body),
          sig: String((init.headers as Record<string, string>)['X-AppBlocks-Trigger-Sig']),
        };
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          text: async () => JSON.stringify({ pipelineRun: 'review-pr-1' }),
        } as unknown as Response;
      })
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const baseArgs = {
    slug: 'generate-from-model',
    sha: 'a'.repeat(40),
    publishRequestId: 'pubreq_0123456789ABCDEFGHJKMNPQRS',
    modUserId: 42,
    callbackUrl: 'https://civitai.com/api/internal/blocks/review-build-callback',
  };

  it('POSTs to the derived review endpoint', async () => {
    await triggerReviewBuild(baseArgs);
    expect(captured!.url).toBe('http://trigger.example/trigger-review-build');
  });

  it('uses the explicit review URL override when set', async () => {
    mockEnv.APPS_TEKTON_REVIEW_TRIGGER_URL = 'http://override.example/trigger-review-build';
    await triggerReviewBuild(baseArgs);
    expect(captured!.url).toBe('http://override.example/trigger-review-build');
  });

  it('includes mode:review + publishRequestId + modUserId + ts in the signed body', async () => {
    const before = Math.floor(Date.now() / 1000);
    await triggerReviewBuild(baseArgs);
    const after = Math.floor(Date.now() / 1000);
    const parsed = JSON.parse(captured!.body);
    expect(parsed).toMatchObject({
      mode: 'review',
      slug: baseArgs.slug,
      sha: baseArgs.sha,
      publishRequestId: baseArgs.publishRequestId,
      modUserId: baseArgs.modUserId,
      callbackUrl: baseArgs.callbackUrl,
    });
    expect(Number.isInteger(parsed.ts)).toBe(true);
    expect(parsed.ts).toBeGreaterThanOrEqual(before);
    expect(parsed.ts).toBeLessThanOrEqual(after);
  });

  it('signs the EXACT body with the SAME trigger secret', async () => {
    await triggerReviewBuild(baseArgs);
    const expectedSig = createHmac('sha256', TRIGGER_SECRET).update(captured!.body).digest('hex');
    expect(captured!.sig).toBe(expectedSig);
    // ts is inside the signed bytes (stripping it changes the sig).
    const stripped = JSON.stringify({ ...JSON.parse(captured!.body), ts: undefined });
    expect(captured!.sig).not.toBe(
      createHmac('sha256', TRIGGER_SECRET).update(stripped).digest('hex')
    );
  });
});
