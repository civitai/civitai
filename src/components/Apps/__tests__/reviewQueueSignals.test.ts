import { describe, expect, it } from 'vitest';
import {
  previewChipState,
  PREVIEW_CHIP_LABELS,
  sensitiveChipLabel,
  sensitiveScopeCount,
} from '~/components/Apps/reviewQueueSignals';
import { nextPendingRequestId, REJECT_REASON_CHIPS } from '~/components/Apps/reviewDecisionFlow';
import {
  AGENT_REVIEW_LANE_BADGES,
  agentReviewDisplay,
  agentReviewLane,
  agentReviewSummaryFromQueueRow,
  isImpersonationCheckStale,
  listingEditCheckBadge,
  type AgentReviewSummary,
} from '~/shared/utils/agent-review-findings';
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

describe('agentReviewDisplay — finding COUNTS, never a verdict', () => {
  const s = (over: Partial<AgentReviewSummary>): AgentReviewSummary => ({
    status: 'complete',
    severities: [],
    overBroad: 0,
    underDeclared: 0,
    inaccurate: 0,
    ...over,
  });

  it('🔴 1 high + 2 medium reads "1 high · 2 medium", worst first, and is RED', () => {
    const d = agentReviewDisplay(s({ severities: ['medium', 'high', 'Medium'] }));
    expect(d.label).toBe('AI: 1 high · 2 medium');
    expect(d.shortLabel).toBe('1 high · 2 medium');
    expect(d.color).toBe('red');
    expect(d.worst).toBe('high');
    expect(d.state).toBe('reported');
  });

  it('🔴 zero findings reads "no findings" — never "pass" — and is not green', () => {
    const d = agentReviewDisplay(s({}));
    expect(d.label).toBe('AI: no findings');
    expect(d.color).toBe('gray');
    expect(d.label).not.toMatch(/pass/i);
  });

  it.each([
    [null, 'not-run', 'AI: not run', 'gray'],
    [s({ status: 'torn-down' }), 'not-run', 'AI: not run', 'gray'],
    [s({ status: 'running', severities: ['critical'] }), 'running', 'AI: running', 'blue'],
    [s({ status: 'failed' }), 'failed', 'AI: run failed', 'orange'],
    [s({ severities: ['low', 'info'] }), 'reported', 'AI: 1 low · 1 info', 'yellow'],
    [s({ severities: ['info'] }), 'reported', 'AI: 1 info', 'gray'],
    [s({ severities: ['moderate'] }), 'reported', 'AI: 1 medium', 'orange'],
    [s({ severities: ['weird'] }), 'reported', 'AI: 1 unrated', 'gray'],
    [s({ overBroad: 1, inaccurate: 1 }), 'reported', 'AI: 2 scope flags', 'orange'],
    [
      s({ severities: ['low'], underDeclared: 1 }),
      'reported',
      'AI: 1 low · 1 scope flag',
      'orange',
    ],
    [
      s({ status: 'cost-capped', severities: ['critical', 'low'] }),
      'reported',
      'AI: 1 critical · 1 low',
      'red',
    ],
  ] as const)('%o → %s "%s" (%s)', (summary, state, label, color) => {
    const d = agentReviewDisplay(summary);
    expect(d.state).toBe(state);
    expect(d.label).toBe(label);
    expect(d.color).toBe(color);
  });

  it('no input ever produces the word "pass"', () => {
    const inputs = [
      null,
      s({}),
      s({ status: 'cost-capped' }),
      s({ severities: ['low'] }),
      s({ status: 'running' }),
      s({ status: 'failed' }),
    ];
    for (const i of inputs) expect(agentReviewDisplay(i).label).not.toMatch(/pass/i);
  });
});

describe('agentReviewLane — the fast lane is positive evidence only', () => {
  const clean: AgentReviewSummary = {
    status: 'complete',
    severities: [],
    overBroad: 0,
    underDeclared: 0,
    inaccurate: 0,
    sectionsOk: true,
    impersonationCheck: 'complete',
    impersonationStale: false,
  };
  const s = (over: Partial<AgentReviewSummary>): AgentReviewSummary => ({ ...clean, ...over });

  it('🔴 a finished review, every analysis and the impersonation check complete, nothing found → agent-clean', () => {
    expect(agentReviewLane(clean)).toEqual({ lane: 'agent-clean', reasons: [] });
  });

  it('low and info findings alone stay agent-clean (they are notes, not flags)', () => {
    expect(agentReviewLane(s({ severities: ['low', 'info', 'INFO'] })).lane).toBe('agent-clean');
  });

  it.each([
    [s({ severities: ['medium'] }), '1 finding to check'],
    [s({ severities: ['high', 'critical'] }), '2 findings to check'],
    [s({ severities: ['weird'] }), '1 finding to check'],
    [s({ overBroad: 1 }), '1 scope flag'],
    [s({ sectionsOk: false }), 'an analysis did not complete'],
    [s({ sectionsOk: undefined }), 'an analysis did not complete'],
    [s({ impersonationCheck: 'failed' }), 'the impersonation check did not complete'],
    [s({ impersonationCheck: null }), 'the impersonation check has not run'],
    [s({ impersonationCheck: undefined }), 'the impersonation check has not run'],
    [s({ status: 'cost-capped' }), 'the agent review stopped at its cost cap'],
    [s({ status: 'failed' }), 'the agent review failed'],
  ] as const)('%o → flagged (%s)', (summary, reason) => {
    const r = agentReviewLane(summary);
    expect(r.lane).toBe('flagged');
    expect(r.reasons).toContain(reason);
  });

  it.each([null, undefined, s({ status: 'running' }), s({ status: 'torn-down' })])(
    '%o → waiting (no review result yet)',
    (summary) => {
      expect(agentReviewLane(summary)).toEqual({ lane: 'waiting', reasons: [] });
    }
  );

  it('🔴 a listing changed after the check (stale fingerprint) is flagged, telling the moderator to re-run', () => {
    expect(agentReviewLane(s({ impersonationStale: true }))).toEqual({
      lane: 'flagged',
      reasons: ['the listing changed after the impersonation check: re-run the review'],
    });
    expect(agentReviewLane(s({ impersonationStale: false })).lane).toBe('agent-clean');
    // Not known to be fresh (an older payload) is not fresh.
    expect(agentReviewLane(s({ impersonationStale: undefined })).lane).toBe('flagged');
  });

  it('isImpersonationCheckStale: only an equal, present fingerprint is fresh', () => {
    expect(isImpersonationCheckStale('abc', 'abc')).toBe(false);
    expect(isImpersonationCheckStale('abc', 'abd')).toBe(true);
    expect(isImpersonationCheckStale(null, 'abc')).toBe(true);
    expect(isImpersonationCheckStale('abc', null)).toBe(true);
  });

  it('🔴 a finding with NO severity counts as unrated, so the row is not agent-clean', () => {
    const summary = agentReviewSummaryFromQueueRow({
      status: 'complete',
      severities: [null, 'low'],
      overBroad: 0,
      underDeclared: 0,
      inaccurate: 0,
      sectionsOk: true,
      impersonationCheck: 'complete',
      impersonationFingerprint: 'fp',
    });
    expect(summary.severities).toEqual(['unrated', 'low']);
    expect(agentReviewLane({ ...summary, impersonationStale: false }).lane).toBe('flagged');
  });

  it('the badges say what to do next — never that the submission passed or is safe', () => {
    // Both lanes that show a badge are covered, so the loop cannot pass by having nothing in it.
    expect(Object.keys(AGENT_REVIEW_LANE_BADGES).sort()).toEqual(['agent-clean', 'flagged']);
    for (const b of Object.values(AGENT_REVIEW_LANE_BADGES)) {
      expect(b.label).not.toMatch(/pass|safe|approved|verified|clean/i);
      expect(b.color).not.toBe('green');
    }
  });
});

describe("listingEditCheckBadge — an approved app's listing edit", () => {
  it('no check (nothing identity-related changed) → no badge: today’s behaviour', () => {
    expect(listingEditCheckBadge(null)).toBeNull();
    expect(listingEditCheckBadge(undefined)).toBeNull();
  });

  it('a complete check with nothing to flag → no badge', () => {
    expect(listingEditCheckBadge({ status: 'complete', flagging: 0, titles: [] })).toBeNull();
  });

  it('🔴 a hit → a badge telling the moderator what to do, with the findings in its tooltip', () => {
    expect(listingEditCheckBadge({ status: 'complete', flagging: 2, titles: ['a', 'b'] })).toEqual({
      label: 'Impersonation: read the findings before approving',
      color: 'orange',
      title: 'a; b',
    });
  });

  it.each([
    ['pending', 'Impersonation not checked yet: check the listing by hand'],
    ['missing', 'Impersonation check incomplete: check the listing by hand'],
    ['skipped', 'Impersonation check skipped (daily budget spent): check the listing by hand'],
    ['stale', 'Impersonation check out of date (listing changed): check the listing by hand'],
  ] as const)('🔴 a %s check → %s', (status, label) => {
    expect(listingEditCheckBadge({ status, flagging: 0, titles: [] })?.label).toBe(label);
  });

  it('🔴 an incomplete check → check it by hand', () => {
    expect(listingEditCheckBadge({ status: 'failed', flagging: 0, titles: [] })).toEqual({
      label: 'Impersonation check incomplete: check the listing by hand',
      color: 'orange',
      title: undefined,
    });
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
