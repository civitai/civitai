import { describe, expect, it } from 'vitest';
// Setup-order: the middleware statically imports block-token.service which reads
// the RSA env at module load — put the test keys in place first (mirrors
// block-scope.middleware.test.ts).
import '~/__tests__/setup';
import type { NextApiResponse } from 'next';
import {
  readBlockActionDetail,
  stashBlockActionDetail,
} from '../block-scope.middleware';
import type { BlockActionDetail } from '~/shared/constants/block-action-detail';

function fakeRes(): NextApiResponse {
  return {} as NextApiResponse;
}

describe('stash/read BlockActionDetail', () => {
  it('round-trips a valid detail through the response object', () => {
    const res = fakeRes();
    const detail: BlockActionDetail = { action: 'tip', amount: 5, toUserId: 7, outcome: 'ok' };
    stashBlockActionDetail(res, detail);
    expect(readBlockActionDetail(res)).toEqual(detail);
  });

  it('reads undefined when nothing was stashed', () => {
    expect(readBlockActionDetail(fakeRes())).toBeUndefined();
  });

  it('drops a malformed stash (no valid action) → reads undefined', () => {
    const res = fakeRes();
    // Bypass the guard by writing the key directly, simulating a garbage value.
    (res as unknown as Record<string, unknown>)['__civitaiBlockActionDetail'] = { nope: 1 };
    expect(readBlockActionDetail(res)).toBeUndefined();
  });

  it('stash swallows a malformed detail (guard rejects it, nothing written)', () => {
    const res = fakeRes();
    stashBlockActionDetail(res, { action: '' } as unknown as BlockActionDetail);
    expect(readBlockActionDetail(res)).toBeUndefined();
  });

  it('stash never throws even when the response object rejects writes (best-effort)', () => {
    // A frozen response can't take the property — stash must swallow, not throw
    // into the handler's money path.
    const frozen = Object.freeze({}) as unknown as NextApiResponse;
    expect(() => stashBlockActionDetail(frozen, { action: 'tip' })).not.toThrow();
    expect(readBlockActionDetail(frozen)).toBeUndefined();
  });
});
