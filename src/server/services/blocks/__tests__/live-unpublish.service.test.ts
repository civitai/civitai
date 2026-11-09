import { describe, expect, it, vi } from 'vitest';
import {
  isLiveUnpublishRefused,
  unpublishLiveApp,
  type LiveUnpublishDeps,
} from '~/server/services/blocks/live-unpublish.service';

/**
 * LIVE UNPUBLISH (`app-blocks-live-unpublish`): a delisted on-site app's live pointer is removed
 * from the shared static server by a Job; the server's readiness app is refused, never retried.
 */

function deps(over: Partial<LiveUnpublishDeps> = {}) {
  return {
    flagOn: vi.fn(async () => true),
    readReadinessProbeSlugs: vi.fn(async () => ['readiness-probe-app']),
    triggerLiveUnpublish: vi.fn(async (slug: string) => ({ name: `${slug}-live-unpub` })),
    waitForJob: vi.fn(async (): Promise<'succeeded' | 'failed' | 'timeout'> => 'succeeded'),
    ...over,
  };
}

describe('unpublishLiveApp', () => {
  it('flag ON: runs the live unpublish Job for the slug and waits for it', async () => {
    const d = deps();
    expect(await unpublishLiveApp('cool-app', { deps: d })).toBe('unpublished');
    expect(d.triggerLiveUnpublish).toHaveBeenCalledWith('cool-app');
    expect(d.waitForJob).toHaveBeenCalledWith('cool-app-live-unpub', 180_000);
  });

  it('flag OFF: no Job (the block is only suspended, as before)', async () => {
    const d = deps({ flagOn: vi.fn(async () => false) });
    expect(await unpublishLiveApp('cool-app', { deps: d })).toBe('disabled');
    expect(d.triggerLiveUnpublish).not.toHaveBeenCalled();
  });

  it('the readiness app refused by the script: reported as refused, NOT retried', async () => {
    const d = deps({ waitForJob: vi.fn(async () => 'failed' as const) });
    expect(await unpublishLiveApp('readiness-probe-app', { deps: d })).toBe('refused');
    expect(d.triggerLiveUnpublish).toHaveBeenCalledTimes(1);
  });

  it('any other failure is reported as failed, never thrown, NOT retried', async () => {
    const d = deps({ waitForJob: vi.fn(async () => 'failed' as const) });
    expect(await unpublishLiveApp('cool-app', { deps: d })).toBe('failed');
    expect(d.triggerLiveUnpublish).toHaveBeenCalledTimes(1);
    const boom = deps({
      triggerLiveUnpublish: vi.fn(async () => {
        throw new Error('k8s down');
      }),
    });
    expect(await unpublishLiveApp('cool-app', { deps: boom })).toBe('failed');
  });
});

describe('isLiveUnpublishRefused', () => {
  it('true only for a slug on the ConfigMap readiness list, with the flag on', async () => {
    expect(await isLiveUnpublishRefused('readiness-probe-app', deps())).toBe(true);
    expect(await isLiveUnpublishRefused('cool-app', deps())).toBe(false);
    expect(
      await isLiveUnpublishRefused(
        'readiness-probe-app',
        deps({ flagOn: vi.fn(async () => false) })
      )
    ).toBe(false);
  });

  it('an unreadable list does not refuse (the script stays the backstop)', async () => {
    const d = deps({
      readReadinessProbeSlugs: vi.fn(async () => {
        throw new Error('forbidden');
      }),
    });
    expect(await isLiveUnpublishRefused('readiness-probe-app', d)).toBe(false);
  });
});
