import { describe, expect, it } from 'vitest';

import { failureSnapshot, isPollUnanswered, pollFailureSnapshot } from '../failureSnapshot';

// Mirror of the block SDK's inbound validator rule (isValidWorkflowSnapshot in
// @civitai/blocks-react): a snapshot is dropped unless workflowId is a
// non-empty string and status is a known workflow status. We re-encode the
// invariant here so a regression on the host side (e.g. reverting workflowId to
// '') fails fast in CI instead of silently re-hanging every host-side
// estimate/submit/poll error to the block's 120s transport timeout.
const WORKFLOW_STATUSES = new Set([
  'pending',
  'processing',
  'succeeded',
  'failed',
  'expired',
  'canceled',
]);
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

describe('failureSnapshot', () => {
  it('produces a snapshot the block SDK validator will DELIVER (non-empty workflowId)', () => {
    const snap = failureSnapshot(new Error('orchestrator unavailable'));
    // The bug this guards: an empty workflowId is dropped by the SDK validator,
    // so the block never sees the error and hangs to the 120s timeout.
    expect(isNonEmptyString(snap.workflowId)).toBe(true);
    expect(WORKFLOW_STATUSES.has(snap.status)).toBe(true);
    expect(snap.status).toBe('failed');
  });

  it('carries the Error message so the block can surface a real reason', () => {
    const snap = failureSnapshot(new Error('orchestrator unavailable'));
    expect(snap.error).toBe('orchestrator unavailable');
  });

  it('falls back to a generic message for non-Error throws (no leak of raw value)', () => {
    const snap = failureSnapshot({ secret: 'do-not-leak' });
    expect(snap.error).toBe('workflow request failed');
    expect(isNonEmptyString(snap.workflowId)).toBe(true);
  });
});

const withCode = (code: string) => Object.assign(new Error(code), { data: { code } });

describe('pollFailureSnapshot', () => {
  it.each([
    ['no data (network failure)', new Error('Failed to fetch')],
    ['data without a code (non-JSON gateway reply)', Object.assign(new Error('x'), { data: null })],
    ['a non-Error throw', 'boom'],
    ['INTERNAL_SERVER_ERROR', withCode('INTERNAL_SERVER_ERROR')],
    ['BAD_GATEWAY', withCode('BAD_GATEWAY')],
    ['SERVICE_UNAVAILABLE', withCode('SERVICE_UNAVAILABLE')],
    ['GATEWAY_TIMEOUT', withCode('GATEWAY_TIMEOUT')],
    ['TIMEOUT', withCode('TIMEOUT')],
    ['TOO_MANY_REQUESTS', withCode('TOO_MANY_REQUESTS')],
    ['CLIENT_CLOSED_REQUEST', withCode('CLIENT_CLOSED_REQUEST')],
  ])('keeps the block polling on %s', (_label, err) => {
    expect(isPollUnanswered(err)).toBe(true);
    // `throttled`: a poll the host could not serve — the block keeps its previous values.
    expect(pollFailureSnapshot(err, 'wf_kept')).toStrictEqual({
      workflowId: 'wf_kept',
      status: 'processing',
      throttled: true,
    });
  });

  it.each([
    'BAD_REQUEST',
    'UNAUTHORIZED',
    'FORBIDDEN',
    'NOT_FOUND',
    'PAYMENT_REQUIRED',
    'CONFLICT',
    'PRECONDITION_FAILED',
    'UNPROCESSABLE_CONTENT',
    'PARSE_ERROR',
    'A_CODE_THIS_FILE_HAS_NEVER_SEEN',
  ])('stays terminal on %s', (code) => {
    expect(isPollUnanswered(withCode(code))).toBe(false);
    expect(pollFailureSnapshot(withCode(code), 'wf_kept')).toStrictEqual({
      workflowId: 'failed',
      status: 'failed',
      error: code,
    });
  });
});

// The retry meta of a refusal under a rate limit (`data.rateLimit` on the tRPC client error), as the
// formatter sends it. Each field's value is distinct, so a copy that swapped or dropped one shows.
const RATE_LIMIT = {
  retryAfterSeconds: 41,
  retryAt: '2026-02-03T04:05:47.000Z',
  id: 'apps.catalog',
  kind: 'abuse' as const,
};
const rateLimited = (code: string, rateLimit: unknown = RATE_LIMIT) =>
  Object.assign(new Error('Rate limit exceeded, please retry shortly.'), {
    data: { code, rateLimit },
  });

describe('a rate-limited refusal keeps its `rateLimit` meta', () => {
  it('failureSnapshot carries it beside the message', () => {
    expect(failureSnapshot(rateLimited('TOO_MANY_REQUESTS'))).toStrictEqual({
      workflowId: 'failed',
      status: 'failed',
      error: 'Rate limit exceeded, please retry shortly.',
      rateLimit: RATE_LIMIT,
    });
  });

  it('pollFailureSnapshot carries it on the keep-polling arm', () => {
    expect(pollFailureSnapshot(rateLimited('TOO_MANY_REQUESTS'), 'wf_kept')).toStrictEqual({
      workflowId: 'wf_kept',
      status: 'processing',
      throttled: true,
      rateLimit: RATE_LIMIT,
    });
  });

  it('pollFailureSnapshot carries it on the terminal arm too', () => {
    expect(pollFailureSnapshot(rateLimited('FORBIDDEN'), 'wf_kept')).toStrictEqual({
      workflowId: 'failed',
      status: 'failed',
      error: 'Rate limit exceeded, please retry shortly.',
      rateLimit: RATE_LIMIT,
    });
  });

  it('a malformed meta is dropped, not forwarded', () => {
    const snap = failureSnapshot(rateLimited('TOO_MANY_REQUESTS', { retryAfterSeconds: 'soon' }));
    expect('rateLimit' in snap).toBe(false);
  });

  it('a failure with no meta carries no `rateLimit` key at all', () => {
    expect('rateLimit' in failureSnapshot(withCode('TOO_MANY_REQUESTS'))).toBe(false);
    expect('rateLimit' in pollFailureSnapshot(withCode('TOO_MANY_REQUESTS'), 'wf_kept')).toBe(
      false
    );
  });
});
