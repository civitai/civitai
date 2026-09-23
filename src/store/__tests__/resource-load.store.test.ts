import { describe, expect, it } from 'vitest';
import {
  RESOURCE_LOAD_EXPIRY_MS,
  resourceLoadDrainVerdict,
  type TrackedResourceLoad,
} from '~/store/resource-load.store';

const NOW = 1_800_000_000_000;

const item = (overrides: Partial<TrackedResourceLoad> = {}): TrackedResourceLoad => ({
  modelVersionId: 501,
  modelId: 42,
  name: 'v1',
  modelName: 'Test Model',
  requestedAt: NOW,
  kind: 'requested',
  ...overrides,
});

const state = (status: string, queuePosition?: number | null) => ({
  availability: { status, queuePosition },
});

describe('resourceLoadDrainVerdict', () => {
  it('completes a load that is now available', () => {
    expect(resourceLoadDrainVerdict(item(), state('available'), NOW)).toEqual({
      action: 'complete',
    });
  });

  it('drops an item whose version no longer resolves', () => {
    expect(resourceLoadDrainVerdict(item(), undefined, NOW)).toEqual({
      action: 'drop',
      reason: 'missing',
    });
  });

  it('keeps a download in progress', () => {
    expect(resourceLoadDrainVerdict(item(), state('loading'), NOW)).toEqual({ action: 'keep' });
  });

  it('keeps one that is queued behind others', () => {
    expect(resourceLoadDrainVerdict(item(), state('unavailable', 3), NOW)).toEqual({
      action: 'keep',
    });
  });

  it('drops an unavailable resource with no queue position — nothing is in flight', () => {
    // A load that failed, or finished and was evicted, reads back exactly like this. Treating it as
    // "still queued" is what would keep it in the queue forever.
    expect(resourceLoadDrainVerdict(item(), state('unavailable', null), NOW)).toEqual({
      action: 'drop',
      reason: 'not-loading',
    });
  });

  it.each(['unsupported', 'unknown'])('drops a %s resource', (status) => {
    expect(resourceLoadDrainVerdict(item(), state(status), NOW)).toEqual({
      action: 'drop',
      reason: 'not-loading',
    });
  });

  it('expires an item the orchestrator still claims is queued', () => {
    // The case the ceiling exists for: without it this item is re-subscribed on every page load,
    // forever, and no other rule can remove it.
    const stale = item({ requestedAt: NOW - RESOURCE_LOAD_EXPIRY_MS - 1 });

    expect(resourceLoadDrainVerdict(stale, state('unavailable', 2), NOW)).toEqual({
      action: 'drop',
      reason: 'expired',
    });
    expect(resourceLoadDrainVerdict(stale, state('loading'), NOW)).toEqual({
      action: 'drop',
      reason: 'expired',
    });
  });

  it('still reports a completed load that arrived after the ceiling', () => {
    // Expiry must not swallow good news: the user waited, it finished, they should be told.
    const stale = item({ requestedAt: NOW - RESOURCE_LOAD_EXPIRY_MS - 1 });

    expect(resourceLoadDrainVerdict(stale, state('available'), NOW)).toEqual({
      action: 'complete',
    });
  });

  it('keeps an item right up to the ceiling', () => {
    const edge = item({ requestedAt: NOW - RESOURCE_LOAD_EXPIRY_MS });

    expect(resourceLoadDrainVerdict(edge, state('loading'), NOW)).toEqual({ action: 'keep' });
  });
});
