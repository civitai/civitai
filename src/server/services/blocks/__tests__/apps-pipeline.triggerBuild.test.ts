import { createHmac } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F5 — trigger leg. triggerBuild() must stamp an integer unix-epoch-SECONDS
 * `ts` INSIDE the JSON body BEFORE the HMAC, so the already-live (currently
 * inert) app-blocks-trigger.py receiver's enforce-if-present ts skew check
 * activates. Contract that MUST match the talos receiver exactly:
 *   - field name `ts`
 *   - integer seconds (not millis)
 *   - covered by the X-AppBlocks-Trigger-Sig HMAC (signed body, not a header)
 */

const { TRIGGER_SECRET, mockEnv } = vi.hoisted(() => {
  const TRIGGER_SECRET = 'trigger-secret';
  return {
    TRIGGER_SECRET,
    mockEnv: {
      APPS_TEKTON_TRIGGER_URL: 'http://trigger.example/trigger-build',
      APPS_TEKTON_TRIGGER_SECRET: TRIGGER_SECRET,
    } as Record<string, unknown>,
  };
});
vi.mock('~/env/server', () => ({ env: mockEnv }));

import { triggerBuild } from '~/server/services/blocks/apps-pipeline.service';

describe('triggerBuild ts replay leg (F5)', () => {
  let captured: { url: string; body: string; sig: string } | null = null;

  beforeEach(() => {
    captured = null;
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
          text: async () => JSON.stringify({ pipelineRun: 'pr-abc' }),
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
    appBlockId: 'apb_0123456789ABCDEFGHJKMNPQRS',
    callbackUrl: 'https://civitai.com/api/internal/blocks/build-callback',
  };

  it('includes a finite integer ts (unix SECONDS) in the signed body', async () => {
    const before = Math.floor(Date.now() / 1000);
    await triggerBuild(baseArgs);
    const after = Math.floor(Date.now() / 1000);

    expect(captured).not.toBeNull();
    const parsed = JSON.parse(captured!.body) as { ts?: unknown };
    expect(typeof parsed.ts).toBe('number');
    expect(Number.isInteger(parsed.ts)).toBe(true);
    // seconds (not millis): must be near "now in seconds", well below ms scale.
    expect(parsed.ts as number).toBeGreaterThanOrEqual(before);
    expect(parsed.ts as number).toBeLessThanOrEqual(after);
  });

  it('signs the EXACT body that carries ts (ts is covered by the HMAC)', async () => {
    await triggerBuild(baseArgs);
    const expectedSig = createHmac('sha256', TRIGGER_SECRET).update(captured!.body).digest('hex');
    expect(captured!.sig).toBe(expectedSig);
    // And the signed body really contains ts — re-deriving the sig over a
    // ts-stripped body must NOT match, proving ts is inside the signed bytes.
    const stripped = JSON.stringify({ ...JSON.parse(captured!.body), ts: undefined });
    const strippedSig = createHmac('sha256', TRIGGER_SECRET).update(stripped).digest('hex');
    expect(captured!.sig).not.toBe(strippedSig);
  });

  it('still sends the original fields alongside ts', async () => {
    await triggerBuild(baseArgs);
    const parsed = JSON.parse(captured!.body);
    expect(parsed).toMatchObject({
      slug: baseArgs.slug,
      sha: baseArgs.sha,
      appBlockId: baseArgs.appBlockId,
      callbackUrl: baseArgs.callbackUrl,
    });
  });
});
