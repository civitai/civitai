import { createHash } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import type { CoocSql } from '~/server/services/resource-intent-cooc/store';
import {
  TAG_INDEX_FIRST_LOAD_WAIT_MS,
  TAG_INDEX_LOAD_TIMEOUT_MS,
  TAG_INDEX_POLL_JITTER_MS,
  TAG_INDEX_POLL_MS,
  TAG_INDEX_RETRY_MS,
  TagIndexSnapshotHolder,
  type TagIndexHolderDeps,
} from '~/server/services/resource-intent-tags/holder';
import {
  decodeTagIndex,
  encodeTagIndex,
  type DecodedTagIndex,
} from '~/server/services/resource-intent-tags/payload';
import {
  TagIndexDecodeUnavailableError,
  TagIndexObjectMissingError,
  type TagIndexObjectStore,
  type TagIndexSnapshotManifest,
} from '~/server/services/resource-intent-tags/store';
import { smallTagIndexData } from './resource-intent-tags.fixture';

/**
 * The per-pod tag-index holder over fake deps: a manifest table that `latestReadyManifest` reads
 * (newest ready row for the spec hash), an in-memory object store, and the main-thread decoder
 * (the worker decoder has its own test). The flag-off cases are the "merging adds nothing" proof:
 * no database read, no download, no decode, nothing held.
 */

const SPEC = 'd'.repeat(64);
const VOCAB = 'a'.repeat(64);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

let payloadA: Buffer;
let payloadB: Buffer;
const payloads = async () => {
  payloadA ??= await encodeTagIndex(smallTagIndexData(VOCAB), SPEC);
  // Different bytes, same validity: another vocabulary version in the header.
  payloadB ??= await encodeTagIndex(smallTagIndexData('b'.repeat(64)), SPEC);
  return { payloadA, payloadB };
};

type Manifest = TagIndexSnapshotManifest;

function manifestOf(id: string, bytes: Buffer, createdAt: Date, vocabVersion = VOCAB): Manifest {
  const s = sha(bytes);
  return {
    id,
    status: 'ready',
    vocabVersion,
    specHash: SPEC,
    payloadSha256: s,
    payloadBytes: bytes.length,
    objectKey: `p/${s}`,
    buildStats: {} as Manifest['buildStats'],
    createdAt,
    retiredAt: null,
  };
}

function harness() {
  let clock = 1_000_000;
  const rows: Manifest[] = [];
  const objects = new Map<string, Buffer>();
  const calls = {
    manifest: 0,
    readyIds: 0,
    vocab: 0,
    get: 0,
    getAborted: 0,
    decode: 0,
    specHash: 0,
  };
  let manifestGate: Promise<void> | null = null;
  let vocabGate: Promise<void> | null = null;
  let failManifest: Error | null = null;
  const specsQueried: unknown[] = [];
  const sql: CoocSql = {
    // latestReadyManifest's statement, by its bound values: [specHash] or [specHash, exceptId].
    query: async <T>(q: { text: string; values: unknown[] }) => {
      // readyIds: which of the bound ids are still ready.
      if (/"id" = ANY\(/.test(q.text)) {
        calls.readyIds++;
        const [ids] = q.values as [string[]];
        return rows
          .filter((r) => r.status === 'ready' && ids.includes(r.id))
          .map((r) => ({
            id: r.id,
          })) as T[];
      }
      if (/FROM "ResourceIntentVocabulary"/.test(q.text)) {
        calls.vocab++;
        if (vocabGate) await vocabGate;
        return [{ status: 'frozen' }] as T[];
      }
      calls.manifest++;
      if (manifestGate) await manifestGate;
      if (failManifest) throw failManifest;
      const [spec, except] = q.values;
      specsQueried.push(spec);
      const ready = rows
        .filter(
          (r) =>
            r.status === 'ready' &&
            r.specHash === spec &&
            !((except as string[] | undefined) ?? []).includes(r.id)
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return ready.slice(0, 1) as T[];
    },
    execute: async () => 0,
  } as unknown as CoocSql;
  let getGate: Promise<void> | null = null;
  const store: TagIndexObjectStore = {
    prefix: 'p',
    put: async () => undefined,
    // Honours its signal, as the S3 adapter does: an abort rejects a download in progress.
    get: async (key, _bytes, signal) => {
      calls.get++;
      if (getGate)
        await new Promise<void>((resolve, reject) => {
          void getGate!.then(resolve);
          signal?.addEventListener(
            'abort',
            () => {
              calls.getAborted++;
              reject(signal.reason);
            },
            { once: true }
          );
        });
      const b = objects.get(key);
      if (!b) throw new TagIndexObjectMissingError(`no object ${key}`);
      return { bytes: Buffer.from(b), sha256: sha(b) };
    },
  };
  let enabled = true;
  let decodeGate: Promise<void> | null = null;
  let failDecode: Error | null = null;
  const decodeSignals: (AbortSignal | undefined)[] = [];
  const loads: [string, number | null][] = [];
  const held: (string | null)[] = [];
  const failures: string[] = [];
  const deps: TagIndexHolderDeps = {
    enabled: async () => enabled,
    sql: () => sql,
    objects: () => store,
    decode: async (p: Uint8Array, signal?: AbortSignal): Promise<DecodedTagIndex> => {
      calls.decode++;
      decodeSignals.push(signal);
      if (decodeGate) await decodeGate;
      if (failDecode) throw failDecode;
      return decodeTagIndex(p);
    },
    specHash: async () => {
      calls.specHash++;
      return SPEC;
    },
    now: () => clock,
    random: () => 0,
    onLoad: (outcome, seconds) => loads.push([outcome, seconds]),
    onHeld: (h) => held.push(h ? h.id : null),
    onLoadFailure: (reason) => failures.push(reason),
  };
  const add = (m: Manifest, bytes: Buffer) => {
    rows.push(m);
    objects.set(m.objectKey, bytes);
  };
  return {
    holder: new TagIndexSnapshotHolder(deps),
    deps,
    rows,
    objects,
    calls,
    specsQueried,
    decodeSignals,
    loads,
    held,
    failures,
    add,
    advance: (ms: number) => (clock += ms),
    setEnabled: (v: boolean) => (enabled = v),
    gateManifest: (p: Promise<void> | null) => (manifestGate = p),
    failManifestWith: (e: Error | null) => (failManifest = e),
    gateDecode: (p: Promise<void> | null) => (decodeGate = p),
    failDecodeWith: (e: Error | null) => (failDecode = e),
    gateGet: (p: Promise<void> | null) => (getGate = p),
    gateVocab: (p: Promise<void> | null) => (vocabGate = p),
  };
}

const T0 = new Date('2026-10-20T06:30:00Z');

describe('TagIndexSnapshotHolder with the flag off', () => {
  it('answers disabled and reads, downloads, decodes and holds nothing', async () => {
    const h = harness();
    const { payloadA } = await payloads();
    h.add(manifestOf('s1', payloadA, T0), payloadA);
    h.setEnabled(false);
    for (let i = 0; i < 5; i++) {
      expect(await h.holder.resolve()).toEqual({ snapshot: null, fallbackReason: 'disabled' });
      h.advance(TAG_INDEX_POLL_MS + TAG_INDEX_POLL_JITTER_MS);
    }
    expect(h.calls).toEqual({
      manifest: 0,
      readyIds: 0,
      vocab: 0,
      get: 0,
      getAborted: 0,
      decode: 0,
      specHash: 0,
    });
    expect(h.loads).toEqual([]);
    expect(h.held).toEqual([]);
  });

  it('turning it off drops a held snapshot; turning it back on loads again', async () => {
    const h = harness();
    const { payloadA } = await payloads();
    h.add(manifestOf('s1', payloadA, T0), payloadA);
    expect((await h.holder.resolve()).snapshot?.id).toBe('s1');
    h.setEnabled(false);
    expect(await h.holder.resolve()).toEqual({ snapshot: null, fallbackReason: 'disabled' });
    expect(h.held).toEqual(['s1', null]);
    const callsWhileOff = { ...h.calls };
    expect(await h.holder.resolve()).toEqual({ snapshot: null, fallbackReason: 'disabled' });
    expect(h.calls).toEqual(callsWhileOff);
    h.setEnabled(true);
    expect((await h.holder.resolve()).snapshot?.id).toBe('s1');
    expect(h.calls.decode).toBe(2);
  });

  it('turning the flag off and on during a load starts no second load until the first has stopped', async () => {
    const h = harness();
    const { payloadA } = await payloads();
    h.add(manifestOf('s1', payloadA, T0), payloadA);
    let release!: () => void;
    // A decode that ignores the abort, standing for one still tearing down.
    h.gateDecode(new Promise<void>((r) => (release = r)));
    void h.holder.resolve();
    await vi.waitFor(() => expect(h.calls.decode).toBe(1));
    h.setEnabled(false);
    await h.holder.resolve();
    h.setEnabled(true);
    // Let the aborted check unwind as far as it will, then ask again: still no second check.
    await new Promise((r) => setTimeout(r, 10));
    void h.holder.resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(h.calls.manifest).toBe(1);
    expect(h.calls.decode).toBe(1);
    h.gateDecode(null);
    release();
    await vi.waitFor(async () => expect((await h.holder.resolve()).snapshot?.id).toBe('s1'));
    expect(h.calls.decode).toBe(2);
  });

  it('a load finishing after the flag went off is discarded', async () => {
    const h = harness();
    const { payloadA } = await payloads();
    h.add(manifestOf('s1', payloadA, T0), payloadA);
    let release!: () => void;
    h.gateDecode(new Promise<void>((r) => (release = r)));
    const first = h.holder.resolve();
    await vi.waitFor(() => expect(h.calls.decode).toBe(1));
    h.setEnabled(false);
    expect(await h.holder.resolve()).toEqual({ snapshot: null, fallbackReason: 'disabled' });
    release();
    await first;
    await new Promise((r) => setTimeout(r, 0));
    expect(h.held).toEqual([]);
    expect(h.loads).toEqual([]);
  });
});

describe('TagIndexSnapshotHolder with the flag on', () => {
  it('loads the newest ready snapshot once and serves it with its identity', async () => {
    const h = harness();
    const { payloadA, payloadB } = await payloads();
    h.add(manifestOf('old', payloadA, new Date(T0.getTime() - 7 * 86_400_000)), payloadA);
    h.add(manifestOf('new', payloadB, T0, 'b'.repeat(64)), payloadB);
    const r = await h.holder.resolve();
    expect(r.fallbackReason).toBeNull();
    expect(r.snapshot).toMatchObject({
      id: 'new',
      payloadSha256: sha(payloadB),
      specHash: SPEC,
      vocabVersion: 'b'.repeat(64),
      createdAt: T0,
    });
    expect(r.snapshot?.index).toEqual((await decodeTagIndex(payloadB)).index);
    expect((await h.holder.resolve()).snapshot).toBe(r.snapshot);
    expect(h.calls).toMatchObject({ manifest: 1, get: 1, decode: 1 });
    expect(h.loads).toHaveLength(1);
    expect(h.loads[0][0]).toBe('success');
    expect(h.held).toEqual(['new']);
  });

  it('concurrent callers share one check and one decode', async () => {
    const h = harness();
    const { payloadA } = await payloads();
    h.add(manifestOf('s1', payloadA, T0), payloadA);
    const results = await Promise.all(Array.from({ length: 8 }, () => h.holder.resolve()));
    expect(results.every((r) => r.snapshot?.id === 's1')).toBe(true);
    expect(h.calls).toMatchObject({ manifest: 1, get: 1, decode: 1 });
  });

  it('re-checks only after the poll interval, and swaps only once the new one has loaded', async () => {
    const h = harness();
    const { payloadA, payloadB } = await payloads();
    h.add(manifestOf('s1', payloadA, T0), payloadA);
    expect((await h.holder.resolve()).snapshot?.id).toBe('s1');
    h.add(manifestOf('s2', payloadB, new Date(T0.getTime() + 1000), 'b'.repeat(64)), payloadB);
    h.advance(TAG_INDEX_POLL_MS - 1);
    expect((await h.holder.resolve()).snapshot?.id).toBe('s1');
    expect(h.calls.manifest).toBe(1);
    h.advance(1);
    let release!: () => void;
    h.gateDecode(new Promise<void>((r) => (release = r)));
    // The check starts; while s2 decodes, s1 is still served, without waiting (a resolve that
    // waited would lose the race to a 50 ms timer; the first-load wait is 10 s).
    const blocked = () => new Promise((r) => setTimeout(() => r('blocked'), 50));
    const quick = async () => {
      const r = await Promise.race([h.holder.resolve(), blocked()]);
      return r === 'blocked' ? r : (r as { snapshot: { id: string } | null }).snapshot?.id;
    };
    expect(await quick()).toBe('s1');
    await vi.waitFor(() => expect(h.calls.decode).toBe(2));
    expect(await quick()).toBe('s1');
    release();
    await vi.waitFor(async () => expect((await h.holder.resolve()).snapshot?.id).toBe('s2'));
    expect(h.held).toEqual(['s1', 's2']);
  });

  it('a refused snapshot is not fetched again while newest, the one before it is served, and a newer one is tried', async () => {
    const h = harness();
    const { payloadA, payloadB } = await payloads();
    h.add(manifestOf('good', payloadA, T0), payloadA);
    expect((await h.holder.resolve()).snapshot?.id).toBe('good');
    // A newer row whose object is gone: unservable.
    h.rows.push(manifestOf('gone', payloadB, new Date(T0.getTime() + 1000), 'b'.repeat(64)));
    h.advance(TAG_INDEX_POLL_MS);
    await h.holder.resolve();
    await vi.waitFor(() => expect(h.failures).toEqual(['snapshot_unservable']));
    expect((await h.holder.resolve()).snapshot?.id).toBe('good');
    expect(h.loads.map((l) => l[0])).toEqual(['success', 'snapshot_unservable']);
    // The next poll does not download it again.
    h.advance(TAG_INDEX_POLL_MS);
    await h.holder.resolve();
    await vi.waitFor(() => expect(h.calls.manifest).toBe(3));
    expect(h.calls.readyIds).toBe(1);
    expect(h.calls.get).toBe(2);
    expect((await h.holder.resolve()).snapshot?.id).toBe('good');
    // A newer good row supersedes the refusal and loads.
    h.add(manifestOf('newer', payloadB, new Date(T0.getTime() + 2000), 'b'.repeat(64)), payloadB);
    h.advance(TAG_INDEX_POLL_MS);
    await h.holder.resolve();
    await vi.waitFor(async () => expect((await h.holder.resolve()).snapshot?.id).toBe('newer'));
  });

  it('a refusal outlives a newer row: good served, bad1 refused, bad2 refused, bad1 never downloaded again', async () => {
    const h = harness();
    const { payloadA, payloadB } = await payloads();
    const other = await encodeTagIndex(smallTagIndexData('c'.repeat(64)), SPEC);
    h.add(manifestOf('good', payloadA, T0), payloadA);
    expect((await h.holder.resolve()).snapshot?.id).toBe('good');
    const poll = async (manifestReads: number) => {
      h.advance(TAG_INDEX_POLL_MS);
      await h.holder.resolve();
      await vi.waitFor(() => expect(h.calls.manifest).toBe(manifestReads));
      await new Promise((r) => setTimeout(r, 0));
    };
    // bad1 lands (its object is gone) and is refused.
    h.rows.push(manifestOf('bad1', payloadB, new Date(T0.getTime() + 1000), 'b'.repeat(64)));
    await poll(2);
    expect(h.failures).toEqual(['snapshot_unservable']);
    expect(h.calls.get).toBe(2);
    // bad2 lands, newer still, and is refused too.
    h.rows.push(manifestOf('bad2', other, new Date(T0.getTime() + 2000), 'c'.repeat(64)));
    await poll(3);
    expect(h.failures).toEqual(['snapshot_unservable', 'snapshot_unservable']);
    expect(h.calls.get).toBe(3);
    // Later polls download neither again: bad1 is still ready, so its refusal stands.
    await poll(4);
    await poll(5);
    expect(h.calls.get).toBe(3);
    expect(h.failures).toHaveLength(2);
    expect((await h.holder.resolve()).snapshot?.id).toBe('good');
    // Retiring bad1 forgets its refusal (nothing left to refuse); bad2's stands.
    h.rows.find((r) => r.id === 'bad1')!.status = 'retired';
    await poll(6);
    expect(h.calls.get).toBe(3);
  });

  it('retiring the served row rolls back even while the newest row is refused', async () => {
    const h = harness();
    const { payloadA, payloadB } = await payloads();
    const older = await encodeTagIndex(smallTagIndexData('c'.repeat(64)), SPEC);
    h.add(manifestOf('older', older, new Date(T0.getTime() - 1000), 'c'.repeat(64)), older);
    h.add(manifestOf('served', payloadA, T0), payloadA);
    expect((await h.holder.resolve()).snapshot?.id).toBe('served');
    h.rows.push(manifestOf('bad', payloadB, new Date(T0.getTime() + 1000), 'b'.repeat(64)));
    h.advance(TAG_INDEX_POLL_MS);
    await h.holder.resolve();
    await vi.waitFor(() => expect(h.failures).toEqual(['snapshot_unservable']));
    h.rows.find((r) => r.id === 'served')!.status = 'retired';
    h.advance(TAG_INDEX_POLL_MS);
    await h.holder.resolve();
    await vi.waitFor(async () => expect((await h.holder.resolve()).snapshot?.id).toBe('older'));
    // Nothing ready but the refused row: nothing is held, and the reason says why.
    h.rows.find((r) => r.id === 'older')!.status = 'retired';
    h.advance(TAG_INDEX_POLL_MS);
    await h.holder.resolve();
    await vi.waitFor(async () =>
      expect(await h.holder.resolve()).toEqual({
        snapshot: null,
        fallbackReason: 'snapshot_unservable',
      })
    );
    // Retiring the refused row too forgets its refusal: nothing ready at all.
    h.rows.find((r) => r.id === 'bad')!.status = 'retired';
    h.advance(TAG_INDEX_POLL_MS);
    await h.holder.resolve();
    await vi.waitFor(async () =>
      expect(await h.holder.resolve()).toEqual({ snapshot: null, fallbackReason: 'no_snapshot' })
    );
  });

  it('two refused rows in a row: neither is downloaded again, and the good row below them is served', async () => {
    const h = harness();
    const { payloadA, payloadB } = await payloads();
    h.add(manifestOf('good', payloadA, T0), payloadA);
    expect((await h.holder.resolve()).snapshot?.id).toBe('good');
    // Two newer rows whose objects are gone.
    h.rows.push(manifestOf('bad1', payloadB, new Date(T0.getTime() + 1000), 'b'.repeat(64)));
    const other = await encodeTagIndex(smallTagIndexData('c'.repeat(64)), SPEC);
    h.rows.push(manifestOf('bad2', other, new Date(T0.getTime() + 2000), 'c'.repeat(64)));
    // One manifest read per check (refused rows excluded in it): 1, then one per poll.
    const expected = [2, 3, 4, 5, 6];
    for (let i = 0; i < 5; i++) {
      h.advance(TAG_INDEX_POLL_MS);
      await h.holder.resolve();
      await vi.waitFor(() => expect(h.calls.manifest).toBe(expected[i]));
      await new Promise((r) => setTimeout(r, 0));
    }
    // One refusal each; after that, no download at all.
    expect(h.failures).toEqual(['snapshot_unservable', 'snapshot_unservable']);
    expect(h.calls.get).toBe(3);
    expect((await h.holder.resolve()).snapshot?.id).toBe('good');
  });

  it('a decode that fails for a reason that is not the bytes is retried, not refused', async () => {
    const h = harness();
    const { payloadA } = await payloads();
    h.add(manifestOf('s1', payloadA, T0), payloadA);
    for (const e of [
      new TagIndexDecodeUnavailableError('tag index decode worker exited (code 1)'),
      Object.assign(new Error('worker heap'), { code: 'ERR_WORKER_OUT_OF_MEMORY' }),
    ]) {
      h.failDecodeWith(e);
      h.advance(TAG_INDEX_RETRY_MS);
      await h.holder.resolve();
      await vi.waitFor(() => expect(h.failures.at(-1)).toBe('load_failed'));
    }
    expect(h.failures).toEqual(['load_failed', 'load_failed']);
    h.failDecodeWith(null);
    h.advance(TAG_INDEX_RETRY_MS);
    expect((await h.holder.resolve()).snapshot?.id).toBe('s1');
  });

  it('asks only for its own spec hash: a newer row under another spec is never served', async () => {
    const h = harness();
    const { payloadA, payloadB } = await payloads();
    h.add(manifestOf('mine', payloadA, T0), payloadA);
    h.add(
      {
        ...manifestOf('theirs', payloadB, new Date(T0.getTime() + 1000)),
        specHash: 'f'.repeat(64),
      },
      payloadB
    );
    expect((await h.holder.resolve()).snapshot?.id).toBe('mine');
    expect(h.specsQueried).toEqual([SPEC]);
  });

  it('a database failure is retried a minute later, not at the next poll', async () => {
    const h = harness();
    const { payloadA } = await payloads();
    h.add(manifestOf('s1', payloadA, T0), payloadA);
    h.failManifestWith(new Error('connection refused'));
    expect(await h.holder.resolve()).toEqual({ snapshot: null, fallbackReason: 'load_failed' });
    expect(h.loads).toEqual([['load_failed', null]]);
    h.failManifestWith(null);
    h.advance(TAG_INDEX_RETRY_MS - 1);
    expect(await h.holder.resolve()).toEqual({ snapshot: null, fallbackReason: 'load_failed' });
    expect(h.calls.manifest).toBe(1);
    h.advance(1);
    expect((await h.holder.resolve()).snapshot?.id).toBe('s1');
  });

  it('a check running past the load timeout is aborted, its late result discarded, and the next check loads once', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const { payloadA } = await payloads();
      h.add(manifestOf('s1', payloadA, T0), payloadA);
      let release!: () => void;
      h.gateManifest(new Promise<void>((r) => (release = r)));
      const first = h.holder.resolve();
      await vi.advanceTimersByTimeAsync(TAG_INDEX_FIRST_LOAD_WAIT_MS);
      expect(await first).toEqual({ snapshot: null, fallbackReason: 'loading' });
      // The wait is spent: a later request gets the fallback without waiting.
      let settled = false;
      void h.holder.resolve().then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      await vi.advanceTimersByTimeAsync(TAG_INDEX_LOAD_TIMEOUT_MS);
      expect(h.failures).toEqual(['load_failed']);
      // Before the retry, nothing new starts; after it, a new check does, although the abandoned
      // check's database read has not returned.
      h.advance(TAG_INDEX_RETRY_MS - 1);
      void h.holder.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.calls.manifest).toBe(1);
      h.advance(1);
      void h.holder.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.calls.manifest).toBe(2);
      h.gateManifest(null);
      release();
      await vi.waitFor(() => expect(h.held).toEqual(['s1']));
      // Only the live check downloaded: the abandoned one stopped at its abort.
      expect(h.calls.get).toBe(1);
      expect(h.calls.decode).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a timed-out check stops a download that hangs, and the next check needs no release', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const { payloadA } = await payloads();
      h.add(manifestOf('s1', payloadA, T0), payloadA);
      h.gateGet(new Promise<void>(() => undefined));
      void h.holder.resolve();
      await vi.advanceTimersByTimeAsync(TAG_INDEX_LOAD_TIMEOUT_MS);
      expect(h.failures).toEqual(['load_failed']);
      // The download itself was told to stop.
      expect(h.calls.getAborted).toBe(1);
      h.gateGet(null);
      h.advance(TAG_INDEX_RETRY_MS);
      void h.holder.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.calls.manifest).toBe(2);
      await vi.waitFor(() => expect(h.held).toEqual(['s1']));
    } finally {
      vi.useRealTimers();
    }
  });

  it('a timed-out check stops waiting on a database read that never returns', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const { payloadA } = await payloads();
      h.add(manifestOf('s1', payloadA, T0), payloadA);
      h.gateManifest(new Promise<void>(() => undefined));
      void h.holder.resolve();
      await vi.advanceTimersByTimeAsync(TAG_INDEX_LOAD_TIMEOUT_MS);
      expect(h.failures).toEqual(['load_failed']);
      h.gateManifest(null);
      h.advance(TAG_INDEX_RETRY_MS);
      void h.holder.resolve();
      await vi.advanceTimersByTimeAsync(0);
      // The first read is still pending, yet a second check has started and loads.
      expect(h.calls.manifest).toBe(2);
      await vi.waitFor(() => expect(h.held).toEqual(['s1']));
    } finally {
      vi.useRealTimers();
    }
  });

  it('a timed-out check stops waiting on a read inside the load (the vocabulary check)', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const { payloadA } = await payloads();
      h.add(manifestOf('s1', payloadA, T0), payloadA);
      h.gateVocab(new Promise<void>(() => undefined));
      void h.holder.resolve();
      await vi.advanceTimersByTimeAsync(TAG_INDEX_LOAD_TIMEOUT_MS);
      expect(h.failures).toEqual(['load_failed']);
      h.gateVocab(null);
      h.advance(TAG_INDEX_RETRY_MS);
      void h.holder.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.calls.manifest).toBe(2);
      await vi.waitFor(() => expect(h.held).toEqual(['s1']));
    } finally {
      vi.useRealTimers();
    }
  });

  it('a check abandoned at the timeout aborts the decode it started', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const { payloadA } = await payloads();
      h.add(manifestOf('s1', payloadA, T0), payloadA);
      h.gateDecode(new Promise<void>(() => undefined));
      void h.holder.resolve();
      await vi.advanceTimersByTimeAsync(TAG_INDEX_LOAD_TIMEOUT_MS);
      expect(h.decodeSignals).toHaveLength(1);
      expect(h.decodeSignals[0]?.aborted).toBe(true);
      // Timed (the harness clock does not move under fake timers, so only its presence is checked).
      expect(h.loads).toEqual([['load_failed', expect.any(Number)]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a row naming the same bytes is adopted without a download; no ready row drops the snapshot', async () => {
    const h = harness();
    const { payloadA } = await payloads();
    h.add(manifestOf('s1', payloadA, T0), payloadA);
    expect((await h.holder.resolve()).snapshot?.id).toBe('s1');
    h.rows[0].status = 'retired';
    h.rows.push(manifestOf('s1-again', payloadA, new Date(T0.getTime() + 1000)));
    h.advance(TAG_INDEX_POLL_MS);
    await h.holder.resolve();
    await vi.waitFor(async () => expect((await h.holder.resolve()).snapshot?.id).toBe('s1-again'));
    expect(h.calls.get).toBe(1);
    h.rows[1].status = 'retired';
    h.advance(TAG_INDEX_POLL_MS);
    await h.holder.resolve();
    await vi.waitFor(async () =>
      expect(await h.holder.resolve()).toEqual({ snapshot: null, fallbackReason: 'no_snapshot' })
    );
    expect(h.held).toEqual(['s1', 's1-again', null]);
  });
});
