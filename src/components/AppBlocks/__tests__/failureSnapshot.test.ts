import { describe, expect, it } from 'vitest';

import { failureSnapshot } from '../failureSnapshot';

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
