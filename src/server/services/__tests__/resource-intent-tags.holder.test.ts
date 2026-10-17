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
  const calls = { manifest: 0, vocab: 0, get: 0, decode: 0, specHash: 0 };
  let manifestGate: Promise<void> | null = null;
  let failManifest: Error | null = null;
  const sql: CoocSql = {
    query: async <T>(q: { text: string }) => {
      if (/FROM "ResourceIntentVocabulary"/.test(q.text)) {
        calls.vocab++;
        return [{ status: 'frozen' }] as T[];
      }
      calls.manifest++;
      if (manifestGate) await manifestGate;
      if (failManifest) throw failManifest;
      const ready = rows
        .filter((r) => r.status === 'ready')
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return ready.slice(0, 1) as T[];
    },
    execute: async () => 0,
  } as unknown as CoocSql;
  const store: TagIndexObjectStore = {
    prefix: 'p',
    put: async () => undefined,
    get: async (key) => {
      calls.get++;
      const b = objects.get(key);
      if (!b) throw new TagIndexObjectMissingError(`no object ${key}`);
      return { bytes: Buffer.from(b), sha256: sha(b) };
    },
  };
  let enabled = true;
  let decodeGate: Promise<void> | null = null;
  const loads: [string, number | null][] = [];
  const held: (string | null)[] = [];
  const failures: string[] = [];
  const deps: TagIndexHolderDeps = {
    enabled: async () => enabled,
    sql: () => sql,
    objects: () => store,
    decode: async (p: Uint8Array): Promise<DecodedTagIndex> => {
      calls.decode++;
      if (decodeGate) await decodeGate;
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
    loads,
    held,
    failures,
    add,
    advance: (ms: number) => (clock += ms),
    setEnabled: (v: boolean) => (enabled = v),
    gateManifest: (p: Promise<void> | null) => (manifestGate = p),
    failManifestWith: (e: Error | null) => (failManifest = e),
    gateDecode: (p: Promise<void> | null) => (decodeGate = p),
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
    expect(h.calls).toEqual({ manifest: 0, vocab: 0, get: 0, decode: 0, specHash: 0 });
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
    // The check starts; while s2 decodes, s1 is still served, without waiting.
    expect((await h.holder.resolve()).snapshot?.id).toBe('s1');
    await vi.waitFor(() => expect(h.calls.decode).toBe(2));
    expect((await h.holder.resolve()).snapshot?.id).toBe('s1');
    release();
    await vi.waitFor(async () => expect((await h.holder.resolve()).snapshot?.id).toBe('s2'));
    expect(h.held).toEqual(['s1', 's2']);
  });

  it('a failed load keeps the held snapshot, refuses the bad one until another is newest', async () => {
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
    expect(h.calls.get).toBe(2);
    expect((await h.holder.resolve()).snapshot?.id).toBe('good');
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

  it('a check running past the load timeout is abandoned and its late result discarded', async () => {
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
      await vi.advanceTimersByTimeAsync(TAG_INDEX_LOAD_TIMEOUT_MS);
      expect(h.failures).toEqual(['load_failed']);
      h.gateManifest(null);
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.held).toEqual([]);
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
