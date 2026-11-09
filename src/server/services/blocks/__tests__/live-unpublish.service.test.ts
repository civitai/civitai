import { describe, expect, it, vi } from 'vitest';
import {
  isReadinessProbeApp,
  readinessAppNote,
  restoreLiveApp,
  takeDownLiveApp,
  unpublishLiveApp,
  type LiveUnpublishDeps,
} from '~/server/services/blocks/live-unpublish.service';

/**
 * LIVE UNPUBLISH (`app-blocks-live-unpublish`): a delisted on-site app's live pointer is removed
 * from the shared static server by a Job, and a relist re-runs the live publish Job for the app's
 * approved build. The server's readiness app is never taken down or re-published from here, and
 * its store takedown is never refused.
 */

const SHA = 'a'.repeat(39) + 'b';
const BLOCK = 'apb_01TESTBLOCK0000000000000000';

function deps(over: Partial<LiveUnpublishDeps> = {}) {
  return {
    flagOn: vi.fn(async () => true),
    readReadinessProbeSlugs: vi.fn(async () => ['readiness-probe-app']),
    triggerLiveUnpublish: vi.fn(async (slug: string) => ({ name: `${slug}-live-unpub` })),
    waitForJob: vi.fn(async (): Promise<'succeeded' | 'failed' | 'timeout'> => 'succeeded'),
    readLiveBuild: vi.fn(async () => ({ sha: SHA as string | null, deployedAt: new Date(0) })),
    perAppObjectsOn: vi.fn(async () => false),
    triggerLivePublish: vi.fn(async (a: { slug: string; sha: string }) => ({
      name: `${a.slug}-apply-${a.sha.slice(0, 8)}`,
    })),
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

describe('takeDownLiveApp (after a takedown commits)', () => {
  it('an ordinary app: starts the live unpublish Job, no note', async () => {
    const d = deps();
    expect(await takeDownLiveApp('cool-app', { deps: d })).toEqual({});
    await vi.waitFor(() => expect(d.triggerLiveUnpublish).toHaveBeenCalledWith('cool-app'));
  });

  it('the readiness app: no Job, and the note says it keeps serving', async () => {
    const d = deps();
    expect(await takeDownLiveApp('readiness-probe-app', { deps: d })).toEqual({
      liveNote: "readiness-probe-app keeps serving: it is the static server's readiness app",
    });
    expect(d.triggerLiveUnpublish).not.toHaveBeenCalled();
  });

  it('an unreadable readiness list: the Job still runs (its script refuses the readiness app)', async () => {
    const d = deps({
      readReadinessProbeSlugs: vi.fn(async () => {
        throw new Error('forbidden');
      }),
    });
    expect(await takeDownLiveApp('readiness-probe-app', { deps: d })).toEqual({});
    await vi.waitFor(() =>
      expect(d.triggerLiveUnpublish).toHaveBeenCalledWith('readiness-probe-app')
    );
  });

  it('flag OFF: nothing, and no note', async () => {
    const d = deps({ flagOn: vi.fn(async () => false) });
    expect(await takeDownLiveApp('readiness-probe-app', { deps: d })).toEqual({});
    expect(d.triggerLiveUnpublish).not.toHaveBeenCalled();
    expect(d.readReadinessProbeSlugs).not.toHaveBeenCalled();
  });
});

describe('restoreLiveApp (after a relist commits)', () => {
  it('flag ON: re-runs the live publish Job with the approved build image, slug and sha', async () => {
    const d = deps();
    expect(await restoreLiveApp({ slug: 'cool-app', appBlockId: BLOCK }, { deps: d })).toBe(
      'restored'
    );
    expect(d.readLiveBuild).toHaveBeenCalledWith(BLOCK);
    expect(d.triggerLivePublish).toHaveBeenCalledTimes(1);
    expect(d.triggerLivePublish).toHaveBeenCalledWith({
      slug: 'cool-app',
      sha: SHA,
      appBlockId: BLOCK,
      imageRef: `ghcr.io/civitai/app-block-cool-app:${SHA}`,
      perAppObjects: false,
    });
    expect(d.waitForJob).toHaveBeenCalledWith(`cool-app-apply-${SHA.slice(0, 8)}`, 480_000);
  });

  it('carries the per-app-objects flag into the Job', async () => {
    const d = deps({ perAppObjectsOn: vi.fn(async () => true) });
    await restoreLiveApp({ slug: 'cool-app', appBlockId: BLOCK }, { deps: d });
    expect(d.triggerLivePublish).toHaveBeenCalledWith(
      expect.objectContaining({ perAppObjects: true })
    );
  });

  it('flag OFF: nothing', async () => {
    const d = deps({ flagOn: vi.fn(async () => false) });
    expect(await restoreLiveApp({ slug: 'cool-app', appBlockId: BLOCK }, { deps: d })).toBe(
      'disabled'
    );
    expect(d.triggerLivePublish).not.toHaveBeenCalled();
    expect(d.readLiveBuild).not.toHaveBeenCalled();
  });

  it('the readiness app: nothing', async () => {
    const d = deps();
    expect(
      await restoreLiveApp({ slug: 'readiness-probe-app', appBlockId: BLOCK }, { deps: d })
    ).toBe('readiness-app');
    expect(d.triggerLivePublish).not.toHaveBeenCalled();
  });

  it.each([
    ['no approved sha', { sha: null, deployedAt: new Date(0) }],
    ['a sha that is not a commit sha', { sha: 'c'.repeat(64), deployedAt: new Date(0) }],
    ['never deployed', { sha: SHA, deployedAt: null }],
  ])('%s: nothing to restore, no Job', async (_label, build) => {
    const d = deps({ readLiveBuild: vi.fn(async () => build) });
    expect(await restoreLiveApp({ slug: 'cool-app', appBlockId: BLOCK }, { deps: d })).toBe(
      'no-live-build'
    );
    expect(d.triggerLivePublish).not.toHaveBeenCalled();
  });

  it('a failed Job is reported, never thrown, NOT retried', async () => {
    const d = deps({ waitForJob: vi.fn(async () => 'failed' as const) });
    expect(await restoreLiveApp({ slug: 'cool-app', appBlockId: BLOCK }, { deps: d })).toBe(
      'failed'
    );
    expect(d.triggerLivePublish).toHaveBeenCalledTimes(1);
    const boom = deps({
      triggerLivePublish: vi.fn(async () => {
        throw new Error('k8s down');
      }),
    });
    expect(await restoreLiveApp({ slug: 'cool-app', appBlockId: BLOCK }, { deps: boom })).toBe(
      'failed'
    );
  });
});

describe('isReadinessProbeApp', () => {
  it('true only for a slug on the ConfigMap readiness list, with the flag on', async () => {
    expect(await isReadinessProbeApp('readiness-probe-app', deps())).toBe(true);
    expect(await isReadinessProbeApp('cool-app', deps())).toBe(false);
    expect(
      await isReadinessProbeApp('readiness-probe-app', deps({ flagOn: vi.fn(async () => false) }))
    ).toBe(false);
  });

  it('an unreadable list returns false (the script stays the backstop)', async () => {
    const d = deps({
      readReadinessProbeSlugs: vi.fn(async () => {
        throw new Error('forbidden');
      }),
    });
    expect(await isReadinessProbeApp('readiness-probe-app', d)).toBe(false);
  });
});

it('readinessAppNote is the line the moderator gets back', () => {
  expect(readinessAppNote('some-app')).toBe(
    "some-app keeps serving: it is the static server's readiness app"
  );
});
