import { describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import {
  afterLiveDeploy,
  isReadinessProbeApp,
  reconcileSuspendedLiveApps,
  readinessAppNote,
  restoreLiveApp,
  syncLivePointer,
  takeDownLiveApp,
  type LivePointerStore,
  type LiveUnpublishDeps,
} from '~/server/services/blocks/live-unpublish.service';

/**
 * LIVE POINTER (`app-blocks-live-unpublish`): a delisted on-site app's live pointer is removed
 * from the shared static server, and a relist writes it back ONLY when this platform took it
 * down. One reconciler per app decides from the app's CURRENT state, one Job at a time.
 */

const SHA = 'a'.repeat(39) + 'b';
const BLOCK = 'apb_01TESTBLOCK0000000000000000';
const SLUG = 'cool-app';

type Outcome = 'succeeded' | 'failed' | 'timeout';

/**
 * A fake world: the block's status, the store, and the pointer the shared server serves. A Job's
 * effect lands when it ENDS, and the test decides when each one ends (`finish`), so takedowns and
 * relists can be interleaved the way they race in production.
 */
function world(over: { status?: string; served?: boolean; flag?: boolean; auto?: boolean } = {}) {
  const w = {
    status: over.status ?? 'approved',
    served: over.served ?? true,
    flag: over.flag ?? true,
    takedown: new Map<string, 'attempted' | 'confirmed'>(),
    lock: false,
    dirty: false,
    jobs: [] as Array<{ action: string; name: string }>,
    pending: [] as Array<{ action: string; resolve: (o: Outcome) => void }>,
    storeWrites: 0,
  };
  const store: LivePointerStore = {
    readTakedown: vi.fn(async (s: string) => w.takedown.get(s) ?? 'none'),
    markTakedownAttempted: vi.fn(async (s: string) => {
      w.storeWrites++;
      w.takedown.set(s, 'attempted');
    }),
    // SET XX: only an attempt still recorded is upgraded.
    markTakedownConfirmed: vi.fn(async (s: string) => {
      w.storeWrites++;
      if (!w.takedown.has(s)) return false;
      w.takedown.set(s, 'confirmed');
      return true;
    }),
    clearTakedown: vi.fn(async (s: string) => {
      w.storeWrites++;
      w.takedown.delete(s);
    }),
    acquire: vi.fn(async () => {
      w.storeWrites++;
      if (w.lock) return false;
      w.lock = true;
      return true;
    }),
    refresh: vi.fn(async () => undefined),
    release: vi.fn(async () => {
      w.lock = false;
    }),
    markDirty: vi.fn(async () => {
      w.storeWrites++;
      w.dirty = true;
    }),
    takeDirty: vi.fn(async () => {
      const was = w.dirty;
      w.dirty = false;
      return was;
    }),
  };
  const deps = {
    flagOn: vi.fn(async () => w.flag),
    readReadinessProbeSlugs: vi.fn(async () => ['readiness-probe-app']),
    readBlockBySlug: vi.fn(async () => ({ id: BLOCK, status: w.status })),
    listSuspendedSlugs: vi.fn(async () => (w.status === 'suspended' ? [SLUG] : [])),
    readLiveBuild: vi.fn(
      async (): Promise<{ sha: string | null; deployedAt: Date | null } | null> => ({
        sha: SHA,
        deployedAt: new Date(0),
      })
    ),
    triggerPointerJob: vi.fn(
      async (job: { slug: string; action: string; sha?: string; imageRef?: string }) => {
        const name = `${job.slug}-live-pointer`;
        w.jobs.push({ action: job.action, name });
        return { name };
      }
    ),
    waitForJob: vi.fn(async (): Promise<Outcome> => {
      const action = w.jobs[w.jobs.length - 1].action;
      const outcome: Outcome =
        over.auto === false
          ? await new Promise<Outcome>((resolve) => w.pending.push({ action, resolve }))
          : 'succeeded';
      if (outcome === 'succeeded') w.served = action === 'restore';
      return outcome;
    }),
    store,
    report: vi.fn(),
  } satisfies LiveUnpublishDeps;
  /** End the oldest running Job, then let the reconciler run on. */
  const finish = async (outcome: Outcome = 'succeeded') => {
    const job = w.pending.shift();
    if (!job) throw new Error('no Job is running');
    job.resolve(outcome);
    await vi.waitFor(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
  };
  return { w, deps, finish };
}

const actions = (w: { jobs: Array<{ action: string }> }) => w.jobs.map((j) => j.action);

describe('takeDownLiveApp (after a takedown commits)', () => {
  it('flag ON: unpublishes the app, records the attempt before the Job starts, confirms it after', async () => {
    const { w, deps } = world({ status: 'suspended' });
    expect(await takeDownLiveApp(SLUG, { deps })).toEqual({});
    await vi.waitFor(() => expect(actions(w)).toEqual(['unpublish']));
    expect(vi.mocked(deps.store.markTakedownAttempted).mock.invocationCallOrder[0]).toBeLessThan(
      deps.triggerPointerJob.mock.invocationCallOrder[0]
    );
    await vi.waitFor(() => expect(w.lock).toBe(false));
    expect(w.served).toBe(false);
    expect(w.takedown.get(SLUG)).toBe('confirmed');
  });

  it('the readiness app: nothing started, and the note says it keeps serving', async () => {
    const { w, deps } = world({ status: 'suspended' });
    expect(await takeDownLiveApp('readiness-probe-app', { deps })).toEqual({
      liveNote: "readiness-probe-app keeps serving: it is the static server's readiness app",
    });
    expect(w.jobs).toEqual([]);
  });

  it('flag OFF: nothing, and no note', async () => {
    const { w, deps } = world({ status: 'suspended', flag: false });
    expect(await takeDownLiveApp(SLUG, { deps })).toEqual({});
    expect(w.jobs).toEqual([]);
    expect(w.storeWrites).toBe(0);
  });

  it('a failed unpublish is reported, not retried within the run, and left unconfirmed', async () => {
    const { w, deps } = world({ status: 'suspended' });
    deps.waitForJob.mockResolvedValue('failed');
    expect(await syncLivePointer(SLUG, { deps })).toBe('failed');
    expect(actions(w)).toEqual(['unpublish']);
    expect(w.takedown.get(SLUG)).toBe('attempted');
    expect(deps.report).toHaveBeenCalledWith(
      'live unpublish Job cool-app-live-pointer ended failed; cool-app may still be served',
      { slug: SLUG, job: 'cool-app-live-pointer', outcome: 'failed' }
    );
  });

  // An unpublish that did not go through leaves the app served: the next takedown call must run
  // it again, not read the earlier attempt as done.
  it.each(['failed', 'timeout'] as const)(
    'an unpublish Job that ended %s is run again by the next takedown call',
    async (outcome) => {
      const { w, deps } = world({ status: 'suspended' });
      deps.waitForJob.mockResolvedValueOnce(outcome);
      await syncLivePointer(SLUG, { deps });
      expect(w.served).toBe(true);
      void takeDownLiveApp(SLUG, { deps });
      await vi.waitFor(() => expect(actions(w)).toEqual(['unpublish', 'unpublish']));
      await vi.waitFor(() => expect(w.lock).toBe(false));
      expect(w.served).toBe(false);
    }
  );

  it('an unpublish whose Job could not be started is run again by the next takedown call', async () => {
    const { w, deps } = world({ status: 'suspended' });
    deps.triggerPointerJob.mockRejectedValueOnce(new Error('k8s API down'));
    expect(await syncLivePointer(SLUG, { deps })).toBe('failed');
    expect(w.jobs).toEqual([]);
    void takeDownLiveApp(SLUG, { deps });
    await vi.waitFor(() => expect(actions(w)).toEqual(['unpublish']));
    await vi.waitFor(() => expect(w.lock).toBe(false));
    expect(w.served).toBe(false);
  });

  it('a relist after a failed then retried takedown restores the app', async () => {
    const { w, deps } = world({ status: 'suspended' });
    deps.waitForJob.mockResolvedValueOnce('failed');
    await syncLivePointer(SLUG, { deps });
    await syncLivePointer(SLUG, { deps });
    expect(w.served).toBe(false);
    w.status = 'approved';
    expect(await restoreLiveApp({ slug: SLUG, appBlockId: BLOCK }, { deps })).toBe('settled');
    expect(actions(w)).toEqual(['unpublish', 'unpublish', 'restore']);
    expect(w.served).toBe(true);
    expect(w.takedown.has(SLUG)).toBe(false);
  });

  // The Job may have removed the pointer before it failed, so the attempt alone is enough for a
  // relist to put the app back.
  it('a relist after an unpublish that failed (not retried) still restores the app', async () => {
    const { w, deps } = world({ status: 'suspended' });
    deps.waitForJob.mockResolvedValueOnce('failed');
    await syncLivePointer(SLUG, { deps });
    w.status = 'approved';
    expect(await restoreLiveApp({ slug: SLUG, appBlockId: BLOCK }, { deps })).toBe('settled');
    expect(actions(w)).toEqual(['unpublish', 'restore']);
    expect(w.served).toBe(true);
    expect(w.takedown.has(SLUG)).toBe(false);
  });

  // A deploy that writes the pointer back while the unpublish runs clears the marker; the
  // unpublish ending afterwards must not record the app as taken down, or it would keep serving.
  it('a deploy that lands while the unpublish runs: the app is unpublished again', async () => {
    const { w, deps, finish } = world({ status: 'suspended', auto: false });
    void takeDownLiveApp(SLUG, { deps });
    await vi.waitFor(() => expect(w.pending).toHaveLength(1));
    w.served = true; // the deploy wrote the pointer back
    expect(await afterLiveDeploy(SLUG, { deps })).toBe('queued');
    await finish();
    await vi.waitFor(() => expect(actions(w)).toEqual(['unpublish', 'unpublish']));
    await finish();
    await vi.waitFor(() => expect(w.lock).toBe(false));
    expect(w.served).toBe(false);
    expect(w.takedown.get(SLUG)).toBe('confirmed');
  });
});

describe('takeDownLiveApp awaited (the late-hold approve)', () => {
  it('a takedown that settles in time: no note, and the app is unpublished', async () => {
    const { w, deps } = world({ status: 'suspended' });
    expect(await takeDownLiveApp(SLUG, { deps, awaitMs: 1000 })).toEqual({});
    expect(actions(w)).toEqual(['unpublish']);
    expect(w.served).toBe(false);
  });

  it('a failed takedown is noted for the moderator', async () => {
    const { deps } = world({ status: 'suspended' });
    deps.waitForJob.mockResolvedValue('failed');
    const { liveNote } = await takeDownLiveApp(SLUG, { deps, awaitMs: 1000 });
    expect(liveNote).toMatch(
      /^cool-app may still be served on its subdomain: its live takedown failed/
    );
  });

  it('a takedown still running past the wait is noted as not confirmed', async () => {
    const { w, deps, finish } = world({ status: 'suspended', auto: false });
    const { liveNote } = await takeDownLiveApp(SLUG, { deps, awaitMs: 20 });
    expect(liveNote).toMatch(/still running and is not confirmed/);
    await finish();
    await vi.waitFor(() => expect(w.lock).toBe(false));
  });

  it('a takedown that did not settle within its steps is noted', async () => {
    const { deps } = world({ status: 'suspended' });
    // The block flips between suspended and approved on every read, so each step undoes the last.
    let reads = 0;
    deps.readBlockBySlug.mockImplementation(async () => ({
      id: BLOCK,
      status: reads++ % 2 === 0 ? 'suspended' : 'approved',
    }));
    const { liveNote } = await takeDownLiveApp(SLUG, { deps, awaitMs: 1000 });
    expect(liveNote).toMatch(/did not settle/);
  });

  it('a takedown queued behind another run of the app is noted as not confirmed', async () => {
    const { w, deps } = world({ status: 'suspended' });
    w.lock = true;
    const { liveNote } = await takeDownLiveApp(SLUG, { deps, awaitMs: 1000 });
    expect(liveNote).toMatch(/queued behind another run/);
  });

  it('a flag read that fails is noted, never read as the flag being off', async () => {
    const { w, deps } = world({ status: 'suspended' });
    deps.flagOn.mockRejectedValueOnce(new Error('flipt down'));
    expect(await takeDownLiveApp(SLUG, { deps })).toEqual({
      liveNote:
        'cool-app may still be served on its subdomain: its live takedown could not be started',
    });
    expect(w.jobs).toEqual([]);
  });
});

describe('restoreLiveApp (after a relist commits)', () => {
  it('taken down here: re-publishes the approved build (image, slug, sha) and clears the marker', async () => {
    const { w, deps } = world({ status: 'approved', served: false });
    w.takedown.set(SLUG, 'confirmed');
    expect(await restoreLiveApp({ slug: SLUG, appBlockId: BLOCK }, { deps })).toBe('settled');
    expect(deps.triggerPointerJob).toHaveBeenCalledWith({
      slug: SLUG,
      action: 'restore',
      sha: SHA,
      imageRef: `ghcr.io/civitai/app-block-cool-app:${SHA}`,
    });
    expect(w.served).toBe(true);
    expect(w.takedown.has(SLUG)).toBe(false);
  });

  it('taken down here while the flag was on, flag OFF now: still restored', async () => {
    const { w, deps } = world({ status: 'approved', served: false, flag: false });
    w.takedown.set(SLUG, 'confirmed');
    await restoreLiveApp({ slug: SLUG, appBlockId: BLOCK }, { deps });
    expect(actions(w)).toEqual(['restore']);
    expect(w.served).toBe(true);
  });

  // With no takedown attempt recorded, a relist does nothing here, flag on or off: no Job, no
  // write, not even a read of the block.
  it.each([false, true])(
    'never taken down here (flag %s): nothing at all, no Job, no write',
    async (flag) => {
      const { w, deps } = world({ status: 'approved', flag });
      expect(await restoreLiveApp({ slug: SLUG, appBlockId: BLOCK }, { deps })).toBe(
        'not-taken-down'
      );
      expect(w.jobs).toEqual([]);
      expect(w.storeWrites).toBe(0);
      expect(deps.readBlockBySlug).not.toHaveBeenCalled();
      expect(deps.readLiveBuild).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['no approved sha', { sha: null, deployedAt: new Date(0) }],
    ['a sha that is not a commit sha', { sha: 'c'.repeat(64), deployedAt: new Date(0) }],
    ['never deployed', { sha: SHA, deployedAt: null }],
  ])('%s: no Job, the marker is cleared', async (_label, build) => {
    const { w, deps } = world({ status: 'approved', served: false });
    w.takedown.set(SLUG, 'confirmed');
    deps.readLiveBuild.mockResolvedValue(build);
    await restoreLiveApp({ slug: SLUG, appBlockId: BLOCK }, { deps });
    expect(w.jobs).toEqual([]);
    expect(w.takedown.has(SLUG)).toBe(false);
  });

  it('a failed restore is reported, not retried, and keeps the marker (unconfirmed) for the next relist', async () => {
    const { w, deps } = world({ status: 'approved', served: false });
    w.takedown.set(SLUG, 'confirmed');
    deps.waitForJob.mockResolvedValue('failed');
    expect(await restoreLiveApp({ slug: SLUG, appBlockId: BLOCK }, { deps })).toBe('failed');
    expect(actions(w)).toEqual(['restore']);
    expect(w.takedown.get(SLUG)).toBe('attempted');
    expect(deps.report).toHaveBeenCalledWith(
      expect.stringContaining('live restore Job cool-app-live-pointer ended failed'),
      expect.objectContaining({ slug: SLUG, outcome: 'failed' })
    );
  });
});

describe('afterLiveDeploy (a deploy succeeded)', () => {
  it('the deploy wrote the pointer: the takedown is cleared; on an approved block nothing runs', async () => {
    const { w, deps } = world({ status: 'approved' });
    w.takedown.set(SLUG, 'confirmed');
    expect(await afterLiveDeploy(SLUG, { deps })).toBe('none');
    expect(w.takedown.has(SLUG)).toBe(false);
    expect(w.jobs).toEqual([]);
  });

  it('a deploy that landed on a suspended block: taken down again', async () => {
    const { w, deps } = world({ status: 'suspended', served: true });
    w.takedown.set(SLUG, 'confirmed'); // taken down before the deploy wrote the pointer back
    expect(await afterLiveDeploy(SLUG, { deps })).toBe('settled');
    expect(actions(w)).toEqual(['unpublish']);
    expect(w.served).toBe(false);
  });

  it('flag OFF: no Job', async () => {
    const { w, deps } = world({ status: 'suspended', flag: false });
    expect(await afterLiveDeploy(SLUG, { deps })).toBe('none');
    expect(w.jobs).toEqual([]);
  });
});

// Takedowns and relists commit in one order and their Jobs finish in another. Whatever the
// interleaving, the app ends served exactly when its block is approved.
describe('ordering: the newest state wins', () => {
  it('delist, relist, then delist again while the first unpublish runs: ends suspended and NOT served', async () => {
    const { w, deps, finish } = world({ status: 'approved', served: true, auto: false });
    w.status = 'suspended';
    void takeDownLiveApp(SLUG, { deps }); // U1
    await vi.waitFor(() => expect(w.pending).toHaveLength(1));
    w.status = 'approved';
    expect(await restoreLiveApp({ slug: SLUG, appBlockId: BLOCK }, { deps })).toBe('queued'); // R1
    await finish(); // U1 ends: approved + taken down -> restore R2 starts
    await vi.waitFor(() => expect(actions(w)).toEqual(['unpublish', 'restore']));
    w.status = 'suspended';
    void takeDownLiveApp(SLUG, { deps }); // U2 arrives while R2 runs: queued
    await finish(); // R2 ends: suspended, not taken down -> unpublish U3
    await vi.waitFor(() => expect(actions(w)).toEqual(['unpublish', 'restore', 'unpublish']));
    await finish();
    await vi.waitFor(() => expect(w.lock).toBe(false));
    expect(w.served).toBe(false);
    expect(w.takedown.has(SLUG)).toBe(true);
    expect(w.pending).toEqual([]);
  });

  it('the mirror: delist, relist, delist, relist: ends approved and served', async () => {
    const { w, deps, finish } = world({ status: 'approved', served: true, auto: false });
    w.status = 'suspended';
    void takeDownLiveApp(SLUG, { deps });
    await vi.waitFor(() => expect(w.pending).toHaveLength(1));
    w.status = 'approved';
    void restoreLiveApp({ slug: SLUG, appBlockId: BLOCK }, { deps });
    w.status = 'suspended';
    void takeDownLiveApp(SLUG, { deps });
    w.status = 'approved';
    await restoreLiveApp({ slug: SLUG, appBlockId: BLOCK }, { deps });
    await finish(); // U1 ends: approved + taken down -> restore
    await vi.waitFor(() => expect(w.pending).toHaveLength(1));
    await finish();
    await vi.waitFor(() => expect(w.lock).toBe(false));
    expect(actions(w)).toEqual(['unpublish', 'restore']);
    expect(w.served).toBe(true);
    expect(w.takedown.has(SLUG)).toBe(false);
  });

  it('only one Job runs at a time per app, under one shared name', async () => {
    const { w, deps, finish } = world({ status: 'suspended', auto: false });
    void takeDownLiveApp(SLUG, { deps });
    await vi.waitFor(() => expect(w.pending).toHaveLength(1));
    w.status = 'approved';
    void restoreLiveApp({ slug: SLUG, appBlockId: BLOCK }, { deps });
    await new Promise((r) => setTimeout(r, 0));
    expect(w.pending).toHaveLength(1);
    await finish();
    await vi.waitFor(() => expect(w.pending).toHaveLength(1));
    await finish();
    expect(new Set(w.jobs.map((j) => j.name))).toEqual(new Set(['cool-app-live-pointer']));
  });
});

// The production store, on an in-memory Redis with SET NX / XX semantics: the attempt and the
// confirmation are separate values of one key, and a confirmation never re-creates as confirmed a
// key that a deploy cleared while the unpublish ran.
describe('the Redis store', () => {
  const KEY = `system:blocks:live-pointer-takedown:${SLUG}`;
  function redisKv() {
    const kv = new Map<string, string>();
    redisMock.sysRedis.get.mockImplementation(async (k: string) => kv.get(k) ?? null);
    redisMock.sysRedis.set.mockImplementation(
      async (k: string, v: string, o?: { NX?: boolean; XX?: boolean }) => {
        if (o?.NX && kv.has(k)) return null;
        if (o?.XX && !kv.has(k)) return null;
        kv.set(k, v);
        return 'OK';
      }
    );
    redisMock.sysRedis.del.mockImplementation(async (k: string) => (kv.delete(k) ? 1 : 0));
    // The takedown mark is in system Redis, the lock and the dirty mark on the cache cluster; one
    // map backs both, since their keys never collide.
    for (const command of ['get', 'set', 'del'] as const)
      redisMock.redis[command].mockImplementation(
        redisMock.sysRedis[command].getMockImplementation()!
      );
    return kv;
  }
  const withoutStore = (deps: LiveUnpublishDeps): Partial<LiveUnpublishDeps> => {
    const { store: _fake, ...rest } = deps;
    return rest;
  };

  it('attempted before the Job, confirmed after it, and re-attempted (not confirmed) once a deploy cleared it', async () => {
    const kv = redisKv();
    const { w, deps, finish } = world({ status: 'suspended', auto: false });
    void syncLivePointer(SLUG, { deps: withoutStore(deps) });
    await vi.waitFor(() => expect(w.pending).toHaveLength(1));
    expect(kv.get(KEY)).toBe('attempted');
    kv.delete(KEY); // a deploy wrote the pointer back and cleared the marker
    await finish();
    await vi.waitFor(() => expect(actions(w)).toEqual(['unpublish', 'unpublish']));
    expect(kv.get(KEY)).toBe('attempted');
    await finish();
    await vi.waitFor(() => expect(kv.get(KEY)).toBe('confirmed'));
  });

  it('a value written before the split reads as an attempt: a relist restores on it', async () => {
    const kv = redisKv();
    kv.set(KEY, '1');
    const { w, deps } = world({ status: 'approved', served: false });
    const d = withoutStore(deps);
    expect(await restoreLiveApp({ slug: SLUG, appBlockId: BLOCK }, { deps: d })).toBe('settled');
    expect(actions(w)).toEqual(['restore']);
    expect(kv.has(KEY)).toBe(false);
  });
});

// Interleavings around a restore and around the lock, where what the reconciler last read and
// what the app now needs can disagree.
describe('a restore or a request that races the holder', () => {
  // A restore Job that fails or times out may still write the pointer later, so it must not leave
  // the takedown recorded as confirmed: a later takedown runs the unpublish again.
  it('a restore that did not succeed never blocks a later unpublish', async () => {
    const { w, deps } = world({ status: 'approved', served: false });
    w.takedown.set(SLUG, 'confirmed');
    deps.waitForJob.mockResolvedValueOnce('failed');
    expect(await restoreLiveApp({ slug: SLUG, appBlockId: BLOCK }, { deps })).toBe('failed');
    w.served = true; // the failed restore wrote the pointer after all
    w.status = 'suspended';
    void takeDownLiveApp(SLUG, { deps });
    await vi.waitFor(() => expect(actions(w)).toEqual(['restore', 'unpublish']));
    await vi.waitFor(() => expect(w.lock).toBe(false));
    expect(w.served).toBe(false);
  });

  // A caller that finds the lock held asks the holder to look again. Its request must be visible
  // to the holder's last check after the release, however late the caller's own lock read returns.
  it('a request whose lock read returns after the holder let go is not lost', async () => {
    const { w, deps, finish } = world({ status: 'suspended', auto: false });
    void takeDownLiveApp(SLUG, { deps });
    await vi.waitFor(() => expect(w.pending).toHaveLength(1));
    let openRelease: () => void = () => undefined;
    const releaseGate = new Promise<void>((r) => (openRelease = r));
    let openAcquire: () => void = () => undefined;
    const acquireGate = new Promise<void>((r) => (openAcquire = r));
    vi.mocked(deps.store.release).mockImplementationOnce(async () => {
      await releaseGate;
      w.lock = false;
    });
    vi.mocked(deps.store.acquire).mockImplementationOnce(async () => {
      const got = !w.lock;
      if (got) w.lock = true;
      await acquireGate;
      return got;
    });
    await finish(); // the unpublish ends; the holder reads the app (nothing to do) and lets go
    await vi.waitFor(() => expect(deps.store.release).toHaveBeenCalled());
    w.status = 'approved'; // a relist commits after the holder's last read
    const relist = restoreLiveApp({ slug: SLUG, appBlockId: BLOCK }, { deps });
    await vi.waitFor(() => expect(deps.store.acquire).toHaveBeenCalledTimes(2));
    openRelease(); // the holder releases and checks for a request
    await new Promise((r) => setTimeout(r, 0));
    openAcquire(); // only now does the relist learn the lock was held
    expect(await relist).toBe('queued');
    await vi.waitFor(() => expect(actions(w)).toEqual(['unpublish', 'restore']));
    await finish();
    await vi.waitFor(() => expect(w.lock).toBe(false));
    expect(w.served).toBe(true);
  });

  // A deploy that lands while the unpublish runs clears the marker; the Job may still remove the
  // pointer after the deploy wrote it. A relist in that window reads no marker, so the holder must
  // keep the evidence itself, or the approved app stays dark.
  it('a relist while a deploy cleared the marker mid-unpublish: the app is served again', async () => {
    const { w, deps, finish } = world({ status: 'suspended', auto: false });
    void takeDownLiveApp(SLUG, { deps });
    await vi.waitFor(() => expect(w.pending).toHaveLength(1));
    w.served = true; // the deploy wrote the pointer back
    expect(await afterLiveDeploy(SLUG, { deps })).toBe('queued');
    w.status = 'approved';
    expect(await restoreLiveApp({ slug: SLUG, appBlockId: BLOCK }, { deps })).toBe(
      'not-taken-down'
    );
    await finish(); // the unpublish ends after the deploy's write: the app is dark
    await vi.waitFor(() => expect(actions(w)).toEqual(['unpublish', 'restore']));
    await finish();
    await vi.waitFor(() => expect(w.lock).toBe(false));
    expect(w.served).toBe(true);
    expect(w.takedown.has(SLUG)).toBe(false);
  });
});

describe('isReadinessProbeApp', () => {
  it('true only for a slug on the ConfigMap readiness list, with the flag on', async () => {
    const { deps } = world();
    expect(await isReadinessProbeApp('readiness-probe-app', deps)).toBe(true);
    expect(await isReadinessProbeApp(SLUG, deps)).toBe(false);
    const off = world({ flag: false });
    expect(await isReadinessProbeApp('readiness-probe-app', off.deps)).toBe(false);
  });

  it('an unreadable list returns false (the script stays the backstop)', async () => {
    const { deps } = world();
    deps.readReadinessProbeSlugs.mockRejectedValue(new Error('forbidden'));
    expect(await isReadinessProbeApp('readiness-probe-app', deps)).toBe(false);
  });
});

it('readinessAppNote is the line the moderator gets back', () => {
  expect(readinessAppNote('some-app')).toBe(
    "some-app keeps serving: it is the static server's readiness app"
  );
});

// The scheduled sweep: every suspended app whose takedown is not confirmed goes through the same
// reconciler, so an app delisted before the flag was on (no marker at all) and an app whose
// unpublish Job failed (marker attempted) are unpublished without a new takedown.
describe('reconcileSuspendedLiveApps (the scheduled sweep)', () => {
  /** Several apps, each with its own block status and marker; one shared lock map per slug. */
  function fleet(
    apps: Record<string, { status: string; takedown?: 'attempted' | 'confirmed' }>,
    over: { flag?: boolean; readiness?: string[] } = {}
  ) {
    const takedown = new Map<string, 'attempted' | 'confirmed'>();
    for (const [slug, a] of Object.entries(apps)) if (a.takedown) takedown.set(slug, a.takedown);
    const locks = new Set<string>();
    const dirty = new Set<string>();
    const unpublished: string[] = [];
    const jobs: Array<{ slug: string; action: string }> = [];
    const store: LivePointerStore = {
      readTakedown: vi.fn(async (s: string) => takedown.get(s) ?? 'none'),
      markTakedownAttempted: vi.fn(async (s: string) => {
        takedown.set(s, 'attempted');
      }),
      markTakedownConfirmed: vi.fn(async (s: string) => {
        if (!takedown.has(s)) return false;
        takedown.set(s, 'confirmed');
        return true;
      }),
      clearTakedown: vi.fn(async (s: string) => {
        takedown.delete(s);
      }),
      acquire: vi.fn(async (s: string) => {
        if (locks.has(s)) return false;
        locks.add(s);
        return true;
      }),
      refresh: vi.fn(async () => undefined),
      release: vi.fn(async (s: string) => {
        locks.delete(s);
      }),
      markDirty: vi.fn(async (s: string) => {
        dirty.add(s);
      }),
      takeDirty: vi.fn(async (s: string) => dirty.delete(s)),
    };
    const deps = {
      flagOn: vi.fn(async () => over.flag ?? true),
      readReadinessProbeSlugs: vi.fn(async () => over.readiness ?? []),
      readBlockBySlug: vi.fn(async (s: string) =>
        apps[s] ? { id: `apb_${s}`, status: apps[s].status } : null
      ),
      listSuspendedSlugs: vi.fn(async () =>
        Object.entries(apps)
          .filter(([, a]) => a.status === 'suspended')
          .map(([s]) => s)
      ),
      readLiveBuild: vi.fn(async () => ({ sha: SHA, deployedAt: new Date(0) })),
      triggerPointerJob: vi.fn(async (job: { slug: string; action: string }) => {
        jobs.push({ slug: job.slug, action: job.action });
        return { name: `${job.slug}-live-pointer` };
      }),
      waitForJob: vi.fn(async (name: string): Promise<Outcome> => {
        unpublished.push(name.replace(/-live-pointer$/, ''));
        return 'succeeded';
      }),
      store,
      report: vi.fn(),
    } satisfies LiveUnpublishDeps;
    return { deps, takedown, jobs, unpublished };
  }

  it('unpublishes a suspended app that has no marker (taken down before the flag was on)', async () => {
    const { deps, takedown, jobs } = fleet({ 'old-takedown': { status: 'suspended' } });
    const summary = await reconcileSuspendedLiveApps({ deps });
    expect(jobs).toEqual([{ slug: 'old-takedown', action: 'unpublish' }]);
    expect(takedown.get('old-takedown')).toBe('confirmed');
    expect(summary).toEqual({
      flag: 'on',
      suspended: 1,
      confirmed: 0,
      readiness: 0,
      unreadable: 0,
      selected: 1,
      deferred: 0,
      outcomes: { settled: 1 },
    });
  });

  it('retries a suspended app whose earlier unpublish only got as far as attempted', async () => {
    const { deps, takedown, jobs } = fleet({
      'failed-job': { status: 'suspended', takedown: 'attempted' },
    });
    await reconcileSuspendedLiveApps({ deps });
    expect(jobs).toEqual([{ slug: 'failed-job', action: 'unpublish' }]);
    expect(takedown.get('failed-job')).toBe('confirmed');
  });

  it('never touches an approved app, even one with a marker', async () => {
    const { deps, jobs, takedown } = fleet({
      live: { status: 'approved' },
      relisted: { status: 'approved', takedown: 'attempted' },
    });
    const summary = await reconcileSuspendedLiveApps({ deps });
    expect(jobs).toEqual([]);
    expect(takedown.get('relisted')).toBe('attempted');
    expect(deps.store.acquire).not.toHaveBeenCalled();
    expect(summary.selected).toBe(0);
  });

  it('skips a suspended app whose takedown is confirmed', async () => {
    const { deps, jobs } = fleet({
      done: { status: 'suspended', takedown: 'confirmed' },
      todo: { status: 'suspended' },
    });
    const summary = await reconcileSuspendedLiveApps({ deps });
    expect(jobs).toEqual([{ slug: 'todo', action: 'unpublish' }]);
    expect(deps.store.acquire).not.toHaveBeenCalledWith('done');
    expect(summary.confirmed).toBe(1);
    expect(summary.selected).toBe(1);
  });

  it('skips the readiness app', async () => {
    const { deps, jobs } = fleet(
      { probe: { status: 'suspended' }, other: { status: 'suspended' } },
      { readiness: ['probe'] }
    );
    const summary = await reconcileSuspendedLiveApps({ deps });
    expect(jobs).toEqual([{ slug: 'other', action: 'unpublish' }]);
    expect(summary.readiness).toBe(1);
  });

  it('flag OFF: lists nothing and starts nothing', async () => {
    const { deps, jobs } = fleet({ a: { status: 'suspended' } }, { flag: false });
    const summary = await reconcileSuspendedLiveApps({ deps });
    expect(jobs).toEqual([]);
    expect(deps.listSuspendedSlugs).not.toHaveBeenCalled();
    expect(summary.flag).toBe('off');
  });

  it('reconciles at most the batch; confirmed apps do not use it up', async () => {
    const apps: Record<string, { status: string; takedown?: 'confirmed' }> = {};
    for (let i = 0; i < 7; i++) apps[`done-${i}`] = { status: 'suspended', takedown: 'confirmed' };
    for (let i = 0; i < 5; i++) apps[`todo-${i}`] = { status: 'suspended' };
    const { deps, jobs } = fleet(apps);
    const summary = await reconcileSuspendedLiveApps({ deps, batch: 3 });
    expect(jobs.map((j) => j.slug).sort()).toEqual(['todo-0', 'todo-1', 'todo-2']);
    expect(summary).toMatchObject({ suspended: 12, confirmed: 7, selected: 3, deferred: 2 });
  });

  // An app whose unpublish fails every time stays `attempted` and keeps its place in the listing.
  // A fixed order would hand it the same batch slot every run; the retries rotate by the hour.
  it('never-attempted apps go first, and the retries rotate so repeat failures cannot hold the batch', async () => {
    const apps: Record<string, { status: string; takedown?: 'attempted' }> = {
      'retry-0': { status: 'suspended', takedown: 'attempted' },
      'retry-1': { status: 'suspended', takedown: 'attempted' },
      'retry-2': { status: 'suspended', takedown: 'attempted' },
      fresh: { status: 'suspended' },
    };
    const HOUR = 3_600_000;
    const picked: string[][] = [];
    for (const hour of [0, 1, 2, 3]) {
      const { deps, jobs } = fleet(apps);
      deps.waitForJob.mockResolvedValue('failed');
      await reconcileSuspendedLiveApps({ deps, batch: 2, now: () => hour * HOUR + 1 });
      picked.push(jobs.map((j) => j.slug));
    }
    expect(picked).toEqual([
      ['fresh', 'retry-0'],
      ['fresh', 'retry-1'],
      ['fresh', 'retry-2'],
      ['fresh', 'retry-0'],
    ]);
  });

  it('a cancelled run starts no further app', async () => {
    const { deps, jobs } = fleet({ a: { status: 'suspended' }, b: { status: 'suspended' } });
    const summary = await reconcileSuspendedLiveApps({ deps, shouldStop: () => true });
    expect(jobs).toEqual([]);
    expect(summary).toMatchObject({ selected: 0, deferred: 2 });
  });

  // The real listing (not the fake above) is what keeps an approved app out of the sweep.
  it('the default listing reads only suspended blocks, from the replica', async () => {
    const { deps, jobs } = fleet({ listed: { status: 'suspended' } });
    const { listSuspendedSlugs: _fake, ...rest } = deps;
    const reads = dbMock.dbRead.appBlock.findMany;
    const before = reads.mock.calls.length;
    const writesBefore = dbMock.dbWrite.appBlock.findMany.mock.calls.length;
    reads.mockResolvedValueOnce([{ blockId: 'listed' }]);
    const summary = await reconcileSuspendedLiveApps({ deps: rest });
    expect(reads.mock.calls.length - before).toBe(1);
    expect(reads.mock.calls[before][0]).toMatchObject({ where: { status: 'suspended' } });
    expect(dbMock.dbWrite.appBlock.findMany.mock.calls.length).toBe(writesBefore);
    expect(jobs).toEqual([{ slug: 'listed', action: 'unpublish' }]);
    expect(summary.suspended).toBe(1);
  });

  it('an unreadable marker skips that app only', async () => {
    const { deps, jobs } = fleet({ bad: { status: 'suspended' }, good: { status: 'suspended' } });
    const readTakedown = vi.mocked(deps.store.readTakedown);
    const fake = readTakedown.getMockImplementation()!;
    readTakedown.mockImplementation(async (s: string) => {
      if (s === 'bad') throw new Error('redis down');
      return fake(s);
    });
    const summary = await reconcileSuspendedLiveApps({ deps });
    expect(jobs).toEqual([{ slug: 'good', action: 'unpublish' }]);
    expect(summary.unreadable).toBe(1);
  });
});
