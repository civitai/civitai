import type { IncomingMessage } from 'http';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isFlipt: vi.fn(async () => false),
  isFliptSync: vi.fn(
    (_key?: string, _entity?: string, _context?: Record<string, string>): boolean | null => null
  ),
  getFliptClientSync: vi.fn((): unknown => null),
  ensureFliptInitialized: vi.fn(async () => undefined),
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: mocks.isFlipt,
  isFliptSync: mocks.isFliptSync,
  ensureFliptInitialized: mocks.ensureFliptInitialized,
  getFliptClientSync: mocks.getFliptClientSync,
}));

import type * as FliptClient from '~/server/flipt/client';
import type { SessionUser } from '~/types/session';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import { getFeatureFlagsAsync } from '~/server/services/feature-flags.service';
import {
  SIGNED_OUT_ROLLOUT_FLAGS,
  applySignedOutRolloutFlags,
} from '~/server/services/signed-out-rollout';

const SIGNED_OUT_KEYS = [
  'feedGoTransportSignedOut',
  'feedGoTransportSignedOutModelGetAll',
  'feedGoTransportSignedOutInfinite',
  'clientShadowCompareSignedOut',
] as const;

const request = (cookie?: string) =>
  ({ headers: { host: 'civitai.com', ...(cookie ? { cookie } : {}) } } as IncomingMessage);

/** Flipt answering true for every key and entity: whatever stays off, nothing in Flipt turned on. */
const fliptSaysYesToEverything = () => mocks.isFliptSync.mockImplementation(() => true);

afterEach(() => {
  mocks.isFliptSync.mockReset();
  mocks.isFliptSync.mockImplementation(() => null);
});

describe('the signed-out rollout flags', () => {
  it('read exactly these Flipt keys (the rollouts are created under them)', () => {
    expect(SIGNED_OUT_ROLLOUT_FLAGS).toEqual({
      feedGoTransportSignedOut: 'feed-go-transport-signed-out',
      feedGoTransportSignedOutModelGetAll: 'feed-go-transport-signed-out-model-getall',
      feedGoTransportSignedOutInfinite: 'feed-go-transport-signed-out-infinite',
      clientShadowCompareSignedOut: 'client-shadow-compare-signed-out',
    });
  });

  it('are dark in the registry, even with Flipt answering yes to everything', async () => {
    fliptSaysYesToEverything();
    const anon = await getFeatureFlagsAsync({
      host: 'civitai.com',
      req: request('civitai-so-bucket=5'),
    });
    // Control: a Flipt-keyed flag does read the yes.
    expect(anon.feedGoTransport).toBe(true);
    for (const key of SIGNED_OUT_KEYS) expect(anon[key]).toBeUndefined();

    const user = { id: 9431, isModerator: true, tier: 'free' } as SessionUser;
    const signedIn = await getFeatureFlagsAsync({ user, req: request('civitai-so-bucket=5') });
    for (const key of SIGNED_OUT_KEYS) expect(signedIn[key]).toBeUndefined();
  });
});

describe('applySignedOutRolloutFlags', () => {
  // The evaluator reads the Flipt module the registry loads; load it before the first case.
  beforeAll(async () => {
    await getFeatureFlagsAsync({});
  });
  // That load evaluates the registry (entity `anonymous`): only this describe's own calls count.
  beforeEach(() => {
    mocks.isFliptSync.mockClear();
  });

  it("evaluates each key for the visitor's bucket entity, never for `anonymous`", () => {
    mocks.isFliptSync.mockImplementation(
      (key?: string, entity?: string) =>
        (entity === 'signed-out-612' &&
          (key === 'feed-go-transport-signed-out-infinite' ||
            key === 'client-shadow-compare-signed-out')) ||
        null
    );
    const flags = applySignedOutRolloutFlags({} as FeatureAccess, {
      req: request('a=1; civitai-so-bucket=612'),
    });
    expect(flags).toEqual({
      feedGoTransportSignedOutInfinite: true,
      clientShadowCompareSignedOut: true,
    });
    const entities = new Set(mocks.isFliptSync.mock.calls.map((c) => c[1]));
    expect([...entities]).toEqual(['signed-out-612']);
    expect(mocks.isFliptSync.mock.calls.map((c) => c[0]).sort()).toEqual([
      'client-shadow-compare-signed-out',
      'feed-go-transport-signed-out',
      'feed-go-transport-signed-out-infinite',
      'feed-go-transport-signed-out-model-getall',
    ]);
  });

  it('is stable per visitor: the same bucket, the same entity on every request', () => {
    const evaluate = vi.fn((_key: string, entity: string) => entity === 'signed-out-77');
    const first = applySignedOutRolloutFlags(
      {} as FeatureAccess,
      { req: request('civitai-so-bucket=77') },
      evaluate
    );
    const second = applySignedOutRolloutFlags(
      {} as FeatureAccess,
      { req: request('civitai-so-bucket=77') },
      evaluate
    );
    const other = applySignedOutRolloutFlags(
      {} as FeatureAccess,
      { req: request('civitai-so-bucket=78') },
      evaluate
    );
    expect(first.feedGoTransportSignedOut).toBe(true);
    expect(second).toEqual(first);
    expect(other.feedGoTransportSignedOut).toBeUndefined();
  });

  it('a session user gets none of them, whatever Flipt or the cookie say, and keeps every other flag', () => {
    const evaluate = vi.fn(() => true);
    const user = { id: 9432 } as SessionUser;
    const flags = applySignedOutRolloutFlags(
      { feedGoTransport: true, feedGoTransportSignedOut: true } as FeatureAccess,
      { user, req: request('civitai-so-bucket=5') },
      evaluate
    );
    expect(flags).toEqual({ feedGoTransport: true });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('off with no request (a shareable render), no bucket, or an invalid one', () => {
    const evaluate = vi.fn(() => true);
    for (const req of [
      undefined,
      request(),
      request('civitai-so-bucket=1000'),
      request('civitai-so-bucket=x'),
    ]) {
      const flags = applySignedOutRolloutFlags({} as FeatureAccess, { req }, evaluate);
      for (const key of SIGNED_OUT_KEYS) expect(flags[key]).toBeUndefined();
    }
    expect(evaluate).not.toHaveBeenCalled();
    // Positive control: the same evaluator with a valid bucket turns them on.
    const on = applySignedOutRolloutFlags(
      {} as FeatureAccess,
      { req: request('civitai-so-bucket=0') },
      evaluate
    );
    for (const key of SIGNED_OUT_KEYS) expect(on[key]).toBe(true);
  });

  it('off when Flipt has no answer (absent key, down)', () => {
    mocks.isFliptSync.mockImplementation(() => null);
    const flags = applySignedOutRolloutFlags({} as FeatureAccess, {
      req: request('civitai-so-bucket=9'),
    });
    expect(flags).toEqual({});
    expect(mocks.isFliptSync).toHaveBeenCalled();
  });
});
