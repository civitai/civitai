import { describe, expect, it } from 'vitest';
import {
  DEPLOY_PENDING_GRACE_MS,
  DEPLOY_STALE_AFTER_MS,
  canRetriggerBuild,
  deployRefetchInterval,
  isAwaitingDeployState,
  isInFlightDeploy,
  isStaleDeploy,
  isStrandedDeploy,
  type DeployLifecycleRow,
} from '../deploy-status';

const NOW = 1_700_000_000_000;
const fresh = new Date(NOW - 60_000); // 1 min ago
const stale = new Date(NOW - DEPLOY_STALE_AFTER_MS - 60_000); // > 45 min ago

const row = (over: Partial<DeployLifecycleRow> = {}): DeployLifecycleRow => ({
  status: 'approved',
  deployState: 'building',
  deployUpdatedAt: fresh,
  ...over,
});

/** A row in the STRANDED shape: approved, no deploy state, no transition ever. */
const strandedRow = (over: Partial<DeployLifecycleRow> = {}): DeployLifecycleRow => ({
  status: 'approved',
  deployState: null,
  deployUpdatedAt: null,
  reviewedAt: stale,
  ...over,
});

describe('isInFlightDeploy', () => {
  it('true only for approved + building/deploying', () => {
    expect(isInFlightDeploy(row({ deployState: 'building' }))).toBe(true);
    expect(isInFlightDeploy(row({ deployState: 'deploying' }))).toBe(true);
    expect(isInFlightDeploy(row({ deployState: 'live' }))).toBe(false);
    expect(isInFlightDeploy(row({ deployState: 'failed' }))).toBe(false);
    expect(isInFlightDeploy(row({ deployState: null }))).toBe(false);
  });
  it('false for non-approved rows regardless of deployState', () => {
    expect(isInFlightDeploy(row({ status: 'pending', deployState: 'building' }))).toBe(false);
    expect(isInFlightDeploy(row({ status: 'rejected', deployState: 'building' }))).toBe(false);
    expect(isInFlightDeploy(row({ status: 'withdrawn', deployState: 'building' }))).toBe(false);
  });
});

describe('isStaleDeploy', () => {
  it('true for an in-flight row not updated within the threshold', () => {
    expect(isStaleDeploy(row({ deployUpdatedAt: stale }), NOW)).toBe(true);
  });
  it('false for a recently-updated in-flight row', () => {
    expect(isStaleDeploy(row({ deployUpdatedAt: fresh }), NOW)).toBe(false);
  });
  it('false when deployUpdatedAt is null (no transition recorded yet)', () => {
    expect(isStaleDeploy(row({ deployUpdatedAt: null }), NOW)).toBe(false);
  });
  it('false for a terminal row even if the timestamp is old', () => {
    expect(isStaleDeploy(row({ deployState: 'live', deployUpdatedAt: stale }), NOW)).toBe(false);
    expect(isStaleDeploy(row({ deployState: 'failed', deployUpdatedAt: stale }), NOW)).toBe(false);
  });
  it('parses an ISO string deployUpdatedAt (defensive non-superjson path)', () => {
    expect(isStaleDeploy(row({ deployUpdatedAt: new Date(stale).toISOString() }), NOW)).toBe(true);
    expect(isStaleDeploy(row({ deployUpdatedAt: new Date(fresh).toISOString() }), NOW)).toBe(false);
  });
});

describe('deployRefetchInterval', () => {
  it('stops (false) when nothing is in flight', () => {
    expect(deployRefetchInterval([], NOW)).toBe(false);
    expect(
      deployRefetchInterval([row({ deployState: 'live' }), row({ deployState: 'failed' })], NOW)
    ).toBe(false);
  });
  it('polls fast (5s) while any in-flight row is fresh', () => {
    expect(deployRefetchInterval([row({ deployUpdatedAt: fresh })], NOW)).toBe(5000);
  });
  it('backs off (30s) once every in-flight row is stalled — but never stops', () => {
    expect(deployRefetchInterval([row({ deployUpdatedAt: stale })], NOW)).toBe(30000);
  });
  it('a single fresh in-flight row keeps the fast cadence even alongside a stalled one', () => {
    expect(
      deployRefetchInterval(
        [row({ deployUpdatedAt: stale }), row({ deployUpdatedAt: fresh })],
        NOW
      )
    ).toBe(5000);
  });
  it('ignores terminal rows when choosing cadence', () => {
    expect(
      deployRefetchInterval(
        [row({ deployState: 'live' }), row({ deployState: 'building', deployUpdatedAt: stale })],
        NOW
      )
    ).toBe(30000);
  });

  it('polls a just-approved row awaiting its first deploy-state write', () => {
    const justApproved = strandedRow({ reviewedAt: new Date(NOW - 5_000) });
    expect(deployRefetchInterval([justApproved], NOW)).toBe(5000);
  });

  it('does NOT poll a STRANDED row forever — nothing will ever change it', () => {
    expect(deployRefetchInterval([strandedRow()], NOW)).toBe(false);
  });

  it('does NOT poll a null-state row past the grace window but before stranding', () => {
    const between = strandedRow({ reviewedAt: new Date(NOW - DEPLOY_PENDING_GRACE_MS - 1_000) });
    expect(deployRefetchInterval([between], NOW)).toBe(false);
  });
});

/**
 * STRANDED — the defect-B signature: `approveRequest` made the approval durable
 * (status='approved' + forgejo_commit_sha) and then threw inside `triggerBuild`,
 * so `markRequestDeployState` was never reached and `deploy_state` stayed NULL.
 * Before this predicate, the badge's `default` branch rendered these as a healthy
 * green "approved" forever.
 *
 * The boundaries below are the DARK-SAFETY contract: a freshly approved row and a
 * legacy row that ever transitioned must NOT be flagged.
 */
describe('isStrandedDeploy', () => {
  it('true for an approved row with no state and no transition, past the threshold', () => {
    expect(isStrandedDeploy(strandedRow(), NOW)).toBe(true);
  });

  it('false immediately after approval (the real approve → mark race window)', () => {
    expect(isStrandedDeploy(strandedRow({ reviewedAt: new Date(NOW) }), NOW)).toBe(false);
    expect(isStrandedDeploy(strandedRow({ reviewedAt: new Date(NOW - 1_000) }), NOW)).toBe(false);
  });

  it('is EXCLUSIVE at exactly the threshold, and true one ms past it', () => {
    const atThreshold = new Date(NOW - DEPLOY_STALE_AFTER_MS);
    const pastThreshold = new Date(NOW - DEPLOY_STALE_AFTER_MS - 1);
    expect(isStrandedDeploy(strandedRow({ reviewedAt: atThreshold }), NOW)).toBe(false);
    expect(isStrandedDeploy(strandedRow({ reviewedAt: pastThreshold }), NOW)).toBe(true);
  });

  it('false when ANY deploy state is set, however old', () => {
    for (const s of ['building', 'deploying', 'live', 'failed'] as const) {
      expect(isStrandedDeploy(strandedRow({ deployState: s }), NOW)).toBe(false);
    }
  });

  it('false for a LEGACY row that ever transitioned (deployUpdatedAt present)', () => {
    // A pre-feature approved row could have a null state; if it also carries a
    // transition timestamp, the lifecycle DID run and it is not stranded.
    expect(isStrandedDeploy(strandedRow({ deployUpdatedAt: stale }), NOW)).toBe(false);
  });

  it('false when there is no reviewedAt anchor to measure from', () => {
    expect(isStrandedDeploy(strandedRow({ reviewedAt: null }), NOW)).toBe(false);
    expect(isStrandedDeploy(strandedRow({ reviewedAt: undefined }), NOW)).toBe(false);
  });

  it('false for non-approved rows regardless of age', () => {
    for (const st of ['pending', 'rejected', 'withdrawn']) {
      expect(isStrandedDeploy(strandedRow({ status: st }), NOW)).toBe(false);
    }
  });

  it('parses an ISO-string reviewedAt (defensive non-superjson path)', () => {
    expect(isStrandedDeploy(strandedRow({ reviewedAt: stale.toISOString() }), NOW)).toBe(true);
    expect(isStrandedDeploy(strandedRow({ reviewedAt: new Date(NOW).toISOString() }), NOW)).toBe(
      false
    );
  });

  it('is never simultaneously true with isStaleDeploy (disjoint states)', () => {
    const s = strandedRow();
    expect(isStrandedDeploy(s, NOW) && isStaleDeploy(s, NOW)).toBe(false);
  });
});

describe('isAwaitingDeployState', () => {
  it('true only inside the post-approval grace window', () => {
    expect(isAwaitingDeployState(strandedRow({ reviewedAt: new Date(NOW - 1_000) }), NOW)).toBe(true);
    expect(
      isAwaitingDeployState(strandedRow({ reviewedAt: new Date(NOW - DEPLOY_PENDING_GRACE_MS) }), NOW)
    ).toBe(true);
    expect(
      isAwaitingDeployState(
        strandedRow({ reviewedAt: new Date(NOW - DEPLOY_PENDING_GRACE_MS - 1) }),
        NOW
      )
    ).toBe(false);
  });

  it('false once a deploy state exists', () => {
    expect(
      isAwaitingDeployState(
        strandedRow({ deployState: 'building', reviewedAt: new Date(NOW) }),
        NOW
      )
    ).toBe(false);
  });
});

/**
 * The CLIENT MIRROR of the server's retrigger gate. Not a security boundary — the
 * server re-checks everything — but it must not offer a button the server will
 * refuse, so its truth table is pinned against the same shared threshold.
 */
describe('canRetriggerBuild', () => {
  it('allows the STRANDED case (null state)', () => {
    expect(canRetriggerBuild({ state: null, updatedAt: null }, NOW)).toBe(true);
  });

  it('allows a failed build/deploy', () => {
    expect(canRetriggerBuild({ state: 'failed', updatedAt: fresh }, NOW)).toBe(true);
  });

  it('refuses a live deploy', () => {
    expect(canRetriggerBuild({ state: 'live', updatedAt: fresh }, NOW)).toBe(false);
  });

  it('refuses every review-preview state', () => {
    for (const s of ['preview-building', 'preview-deploying', 'preview-live', 'preview-failed']) {
      expect(canRetriggerBuild({ state: s, updatedAt: stale }, NOW)).toBe(false);
    }
  });

  it('refuses a FRESH in-flight build (never race two PipelineRuns)', () => {
    expect(canRetriggerBuild({ state: 'building', updatedAt: fresh }, NOW)).toBe(false);
    expect(canRetriggerBuild({ state: 'deploying', updatedAt: fresh }, NOW)).toBe(false);
  });

  it('allows an in-flight build only once STALLED past the shared threshold', () => {
    expect(canRetriggerBuild({ state: 'building', updatedAt: stale }, NOW)).toBe(true);
    expect(canRetriggerBuild({ state: 'deploying', updatedAt: stale }, NOW)).toBe(true);
    // Exactly at the threshold is still "not stalled" — matches the server.
    expect(
      canRetriggerBuild({ state: 'building', updatedAt: new Date(NOW - DEPLOY_STALE_AFTER_MS) }, NOW)
    ).toBe(false);
  });

  it('refuses an in-flight build with no timestamp to judge staleness by', () => {
    expect(canRetriggerBuild({ state: 'building', updatedAt: null }, NOW)).toBe(false);
  });

  it('refuses an unrecognized state rather than guessing', () => {
    expect(canRetriggerBuild({ state: 'something-new', updatedAt: stale }, NOW)).toBe(false);
  });
});
