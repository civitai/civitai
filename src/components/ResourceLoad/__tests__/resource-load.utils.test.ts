import { describe, expect, it, beforeEach } from 'vitest';
import { Air } from '@civitai/client';
import { toResourceLoadProgress } from '~/components/ResourceLoad/resource-load.utils';

/**
 * The global `@civitai/client` stub has no `Air.parseSafe`, so without a real one every payload here
 * would be dropped and every assertion below would pass for the wrong reason.
 */
beforeEach(() => {
  (Air as unknown as Record<string, unknown>).parseSafe = (identifier: string) => {
    const match = /^urn:air:([^:]+):([^:]+):([^:]+):(\d+)@(\d+)$/.exec(identifier);
    if (!match) return null;
    const [, ecosystem, type, source, id, version] = match;
    return { ecosystem, type, source, id, version };
  };
});

const preparing = (air: string, extra: Record<string, unknown> = {}) => ({
  workflowId: '7-123',
  name: 'prepare-resource',
  status: 'preparing',
  preparation: { resource: air, queuePosition: 0, progress: 0.5, etaSeconds: 120, ...extra },
});

describe('toResourceLoadProgress', () => {
  it('takes the version id from the payload AIR, not from the fact that it arrived', () => {
    // Every load this user has in flight arrives on the same per-user channel, so attributing by
    // delivery would paint one model's progress onto another.
    const update = toResourceLoadProgress(preparing('urn:air:sdxl:checkpoint:civitai:42@999'));

    expect(update?.modelVersionId).toBe(999);
  });

  it('carries queue position, progress and eta through', () => {
    const update = toResourceLoadProgress(preparing('urn:air:sdxl:checkpoint:civitai:42@501'));

    expect(update).toMatchObject({
      modelVersionId: 501,
      queuePosition: 0,
      progress: 0.5,
      etaSeconds: 120,
      workflowId: '7-123',
    });
  });

  it('normalises a still-queued download to null progress rather than zero', () => {
    // Null and 0.0 mean different things: "not started" vs "started, nothing transferred". A bar
    // rendered from 0 looks identical to one rendered from null, so the distinction has to survive.
    const update = toResourceLoadProgress(
      preparing('urn:air:sdxl:checkpoint:civitai:42@501', { progress: null, queuePosition: 3 })
    );

    expect(update?.progress).toBeNull();
    expect(update?.queuePosition).toBe(3);
  });

  it('ignores a step event with no preparation — most statuses have none', () => {
    expect(
      toResourceLoadProgress({ workflowId: '7-123', name: 'prepare-resource', status: 'succeeded' })
    ).toBeNull();
  });

  it('ignores an AIR that does not resolve to a version', () => {
    expect(toResourceLoadProgress(preparing('not-an-air'))).toBeNull();
  });

  it('ignores a payload of an entirely different shape', () => {
    expect(toResourceLoadProgress({ hello: 'world' })).toBeNull();
    expect(toResourceLoadProgress(undefined)).toBeNull();
  });
});
