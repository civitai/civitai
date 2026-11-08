import { describe, expect, it } from 'vitest';
import {
  previewChipState,
  PREVIEW_CHIP_LABELS,
  sensitiveChipLabel,
  sensitiveScopeCount,
} from '~/components/Apps/reviewQueueSignals';
import { nextPendingRequestId, REJECT_REASON_CHIPS } from '~/components/Apps/reviewDecisionFlow';
import { agentReviewVerdict, type AgentReviewSummary } from '~/shared/utils/agent-review-verdict';
import { OFFSITE_MOD_REASON_MIN } from '~/server/schema/blocks/offsite-moderation.schema';

describe('previewChipState — every lifecycle value, including the two not written yet', () => {
  it.each([
    [null, 'none'],
    [undefined, 'none'],
    ['preview-queued', 'queued'],
    ['preview-building', 'building'],
    ['preview-deploying', 'building'],
    ['preview-live', 'live'],
    ['preview-failed', 'failed'],
    ['preview-expired', 'expired'],
    // A production deploy state never reads as a preview.
    ['live', 'none'],
  ] as const)('%s → %s', (state, chip) => {
    expect(previewChipState(state)).toBe(chip);
  });

  it('has a label for every chip state', () => {
    expect(PREVIEW_CHIP_LABELS).toEqual({
      none: 'Preview: not started',
      queued: 'Preview: queued',
      building: 'Preview: building',
      live: 'Preview: live',
      failed: 'Preview: failed',
      expired: 'Preview: expired',
    });
  });
});

describe('sensitiveScopeCount', () => {
  it('counts only sensitive scopes, tolerating a malformed manifest', () => {
    expect(sensitiveScopeCount({ scopes: ['user:read:self', 'ai:write:budgeted', 7, null] })).toBe(
      1
    );
    expect(sensitiveScopeCount({ scopes: 'ai:write:budgeted' })).toBe(0);
    expect(sensitiveScopeCount(null)).toBe(0);
    expect(sensitiveScopeCount({ scopes: ['user:read:self'] })).toBe(0);
  });
  it('labels', () => {
    expect(sensitiveChipLabel(0)).toBe('No sensitive perms');
    expect(sensitiveChipLabel(1)).toBe('1 sensitive perm');
    expect(sensitiveChipLabel(3)).toBe('3 sensitive perms');
  });
});

describe('agentReviewVerdict', () => {
  const s = (over: Partial<AgentReviewSummary>): AgentReviewSummary => ({
    status: 'complete',
    severities: [],
    overBroad: 0,
    underDeclared: 0,
    inaccurate: 0,
    ...over,
  });
  it.each([
    [null, 'not-run'],
    [s({ status: 'torn-down' }), 'not-run'],
    [s({ status: 'running', severities: ['critical'] }), 'running'],
    [s({ status: 'failed' }), 'error'],
    [s({}), 'pass'],
    [s({ severities: ['low', 'info'] }), 'pass'],
    [s({ severities: ['low', 'Medium'] }), 'concerns'],
    [s({ severities: ['moderate'] }), 'concerns'],
    [s({ overBroad: 1 }), 'concerns'],
    [s({ underDeclared: 2 }), 'concerns'],
    [s({ inaccurate: 1 }), 'concerns'],
    [s({ severities: ['low', 'HIGH'], overBroad: 1 }), 'fail'],
    [s({ status: 'cost-capped', severities: ['critical'] }), 'fail'],
  ] as const)('%o → %s', (summary, verdict) => {
    expect(agentReviewVerdict(summary)).toBe(verdict);
  });
});

describe('nextPendingRequestId', () => {
  const rows = [
    { id: 'c', submittedAt: '2026-01-03T00:00:00Z' },
    { id: 'a', submittedAt: '2026-01-01T00:00:00Z' },
    { id: 'b', submittedAt: new Date('2026-01-02T00:00:00Z') },
  ];
  it('picks the OLDEST that is not excluded, whatever the input order', () => {
    expect(nextPendingRequestId(rows, ['a'])).toBe('b');
    expect(nextPendingRequestId(rows, new Set(['a', 'b']))).toBe('c');
    expect(nextPendingRequestId(rows, [])).toBe('a');
  });
  it('returns null when everything is excluded (all caught up)', () => {
    expect(nextPendingRequestId(rows, ['a', 'b', 'c'])).toBeNull();
    expect(nextPendingRequestId([], [])).toBeNull();
  });
});

describe('REJECT_REASON_CHIPS', () => {
  it('every prefilled sentence clears the reason floor on its own (the 3-click reject)', () => {
    for (const chip of REJECT_REASON_CHIPS)
      expect(chip.text.trim().length).toBeGreaterThanOrEqual(OFFSITE_MOD_REASON_MIN);
  });
  it('covers the six common reasons, in order', () => {
    expect(REJECT_REASON_CHIPS.map((c) => c.key)).toEqual([
      'broken',
      'policy',
      'misleading',
      'media',
      'permissions',
      'duplicate',
    ]);
  });
});
