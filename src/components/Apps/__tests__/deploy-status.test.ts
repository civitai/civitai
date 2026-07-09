import { describe, expect, it } from 'vitest';
import {
  DEPLOY_STALE_AFTER_MS,
  deployRefetchInterval,
  isInFlightDeploy,
  isStaleDeploy,
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
});
