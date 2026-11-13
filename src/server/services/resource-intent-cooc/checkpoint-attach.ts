import { createHash } from 'crypto';

import {
  CHECKPOINT_ATTACH_CANDIDATES,
  rankAttachCounts,
} from '~/server/services/resource-intent-checkpoint';
import { fromU32le, u32le } from './build';

/**
 * Builder side of checkpoint mode's ATTACH_BM arm: how many training images attach each
 * checkpoint model, per baseModel, counted over the SAME draw the co-occurrence index is built
 * from, and stored as an optional section of that snapshot's payload.
 *
 * A port of the offline checkpoint screen's training loop (its `bmPairsOf` and the count loop over
 * it); `resource-intent-checkpoint.seam.test.ts` holds it to that code, copied in verbatim.
 *
 * Why a section and not its own snapshot: the counts need exactly the rows the co-occurrence draw
 * already reads, so one build, one content hash, one retention rule and one holder serve both. The
 * section is NOT part of `RESOURCE_INTENT_COOC_SPEC_HASH` (that fingerprint hashes the cooc counts
 * only), so adding it leaves every existing snapshot servable for POOL_MERGE. A snapshot built
 * before this code, or while the section-writer flag is off (`pipeline.ts`), has no section;
 * checkpoint mode treats it as `spec_mismatch`. The section
 * carries its own `CHECKPOINT_ATTACH_BUILD_HASH`, and a section built under another one is ignored
 * the same way.
 */

export const CHECKPOINT_ATTACH_SECTION_FORMAT = 'resource-intent-checkpoint-attach/1';
/** The baseModel key of an attachment whose version was not found at build time (the screen's). */
export const CHECKPOINT_UNKNOWN_BASE_MODEL = '?';

type Attachment = { modelId: number; modelType: string; versionId: number };
/** baseModel → checkpoint model id → number of training images attaching it under that baseModel. */
export type CheckpointAttachCounts = Map<string, Map<number, number>>;

/**
 * Collects each training image's checkpoint attachments as the draw arrives; `finalize` counts
 * them once the versions' baseModels are known. An image counts once per distinct
 * (baseModel, model) pair, so two versions of one model under one baseModel count once.
 */
export class CheckpointAttachAccumulator {
  private readonly images: { modelId: number; versionId: number }[][] = [];
  private finalized = false;

  add(att: readonly Attachment[]) {
    if (this.finalized) throw new Error('CheckpointAttachAccumulator already finalized');
    const ck = att
      .filter((a) => a.modelType === 'Checkpoint')
      .map((a) => ({ modelId: a.modelId, versionId: a.versionId }));
    if (ck.length) this.images.push(ck);
  }

  /** Images with at least one checkpoint attachment. */
  get imagesWithCheckpoint() {
    return this.images.length;
  }

  /** The distinct checkpoint version ids seen, ascending: the versions whose baseModel is needed. */
  versionIds(): number[] {
    return [...new Set(this.images.flat().map((x) => x.versionId))].sort((a, b) => a - b);
  }

  finalize(versionBaseModel: ReadonlyMap<number, string>): CheckpointAttachCounts {
    if (this.finalized) throw new Error('CheckpointAttachAccumulator already finalized');
    this.finalized = true;
    const out: CheckpointAttachCounts = new Map();
    for (const ck of this.images) {
      const pairs = new Map<string, [string, number]>();
      for (const x of ck) {
        const bm = versionBaseModel.get(x.versionId) ?? CHECKPOINT_UNKNOWN_BASE_MODEL;
        pairs.set(`${bm}\u0000${x.modelId}`, [bm, x.modelId]);
      }
      for (const [bm, modelId] of pairs.values()) {
        let m = out.get(bm);
        if (!m) out.set(bm, (m = new Map()));
        m.set(modelId, (m.get(modelId) ?? 0) + 1);
      }
    }
    this.images.length = 0;
    return out;
  }
}

const compareCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The section as the payload stores it, in canonical order (baseModels by UTF-16 code unit, model
 * ids ascending within each), so equal counts always give equal bytes:
 * `[format, buildHash, baseModels, modelIds[] (uint32 LE), counts[] (uint32 LE)]`.
 */
export function encodeCheckpointAttachSection(
  counts: CheckpointAttachCounts,
  buildHash: string = CHECKPOINT_ATTACH_BUILD_HASH
): unknown[] {
  const baseModels = [...counts.keys()].sort(compareCodeUnits);
  const ids: Buffer[] = [];
  const ns: Buffer[] = [];
  for (const bm of baseModels) {
    const entries = [...(counts.get(bm) as Map<number, number>).entries()].sort(
      (a, b) => a[0] - b[0]
    );
    ids.push(u32le(Uint32Array.from(entries, ([id]) => id)));
    ns.push(u32le(Uint32Array.from(entries, ([, n]) => n)));
  }
  return [CHECKPOINT_ATTACH_SECTION_FORMAT, buildHash, baseModels, ids, ns];
}

export type CheckpointAttachSection = { buildHash: string; counts: CheckpointAttachCounts };

/** Decode and structurally validate a stored section; throws on anything malformed. */
export function decodeCheckpointAttachSection(raw: unknown): CheckpointAttachSection {
  const fail = (what: string): never => {
    throw new Error(`checkpoint attach section invalid: ${what}`);
  };
  if (!Array.isArray(raw) || raw.length !== 5 || raw[0] !== CHECKPOINT_ATTACH_SECTION_FORMAT)
    fail('unknown format');
  const [, buildHash, baseModels, ids, ns] = raw as [string, unknown, unknown, unknown, unknown];
  if (typeof buildHash !== 'string' || !buildHash) fail('build hash');
  if (!Array.isArray(baseModels) || !baseModels.every((b) => typeof b === 'string'))
    fail('baseModels');
  const bms = baseModels as string[];
  for (let i = 1; i < bms.length; i++) if (!(bms[i - 1] < bms[i])) fail('baseModel order');
  if (!Array.isArray(ids) || ids.length !== bms.length) fail('modelIds per baseModel');
  if (!Array.isArray(ns) || ns.length !== bms.length) fail('counts per baseModel');
  const u32 = (b: unknown, what: string) =>
    b instanceof Uint8Array && b.length % 4 === 0 ? fromU32le(b, what) : fail(what);
  const counts: CheckpointAttachCounts = new Map();
  bms.forEach((bm, i) => {
    const mids = u32((ids as unknown[])[i], 'modelIds bytes');
    const cs = u32((ns as unknown[])[i], 'counts bytes');
    if (!mids.length) fail('empty baseModel');
    if (mids.length !== cs.length) fail('model/count lengths');
    const m = new Map<number, number>();
    for (let k = 0; k < mids.length; k++) {
      if (k > 0 && mids[k] <= mids[k - 1]) fail('model order');
      if (cs[k] === 0) fail('zero count');
      m.set(mids[k], cs[k]);
    }
    counts.set(bm, m);
  });
  return { buildHash: buildHash as string, counts };
}

/**
 * What the request path serves from a section: per baseModel, the first
 * `CHECKPOINT_ATTACH_CANDIDATES` model ids by count. Ranked once at load, not per request.
 */
export type CheckpointAttachIndex = { candidates: ReadonlyMap<string, readonly number[]> };

export function checkpointAttachIndex(counts: CheckpointAttachCounts): CheckpointAttachIndex {
  return {
    candidates: new Map(
      [...counts].map(([bm, m]) => [bm, rankAttachCounts(m).slice(0, CHECKPOINT_ATTACH_CANDIDATES)])
    ),
  };
}

/**
 * Hashes the format and what the accumulator and the encoding produce on a fixture: a duplicate
 * (baseModel, model) pair within an image, one model under two baseModels, a version with no
 * baseModel, and an image with no checkpoint. A section built under another hash is not served.
 */
function checkpointAttachFingerprint() {
  const acc = new CheckpointAttachAccumulator();
  const ck = (modelId: number, versionId: number) => ({
    modelId,
    versionId,
    modelType: 'Checkpoint',
  });
  acc.add([ck(7, 70), ck(7, 71), { modelId: 9, versionId: 90, modelType: 'LORA' }]);
  acc.add([ck(7, 72), ck(8, 80)]);
  acc.add([ck(8, 81)]);
  acc.add([{ modelId: 9, versionId: 90, modelType: 'LORA' }]);
  const counts = acc.finalize(
    new Map([
      [70, 'B'],
      [71, 'B'],
      [72, 'A'],
      [80, 'B'],
    ])
  );
  const [format, , baseModels, ids, ns] = encodeCheckpointAttachSection(counts, '') as [
    string,
    string,
    string[],
    Buffer[],
    Buffer[]
  ];
  return {
    format,
    unknown: CHECKPOINT_UNKNOWN_BASE_MODEL,
    baseModels,
    ids: ids.map((b) => [...b]),
    ns: ns.map((b) => [...b]),
  };
}

export const CHECKPOINT_ATTACH_BUILD_HASH = createHash('sha256')
  .update(JSON.stringify(checkpointAttachFingerprint()))
  .digest('hex');
