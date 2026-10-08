import { promisify } from 'util';
import zlib from 'zlib';
import { Prisma } from '@prisma/client';
import { Packr } from 'msgpackr';
import type { CoocModelText } from './tokenize';

/**
 * Builder side of the resource-intent co-occurrence index: the training-row sampler, the
 * counts, and the snapshot payload. A port of the offline screen's draw loop and its
 * reference index builder; the seam tests in
 * `src/server/services/__tests__/resource-intent-cooc.*.seam.test.ts` hold each piece to the
 * screen's output.
 *
 * Takes its parameters as arguments rather than importing `./spec`, because `./spec` hashes
 * what these functions produce.
 */

/**
 * The conditions of the M3 registration's `GOLDSET_ELIGIBLE_IMAGE` after its rolling-window
 * line, byte for byte (compared by
 * `src/server/services/__tests__/resource-intent-cooc.eligibility.test.ts`). The draw replaces
 * that window with explicit `[trainStart, trainEnd)` bounds.
 */
export const COOC_ELIGIBLE_REST = `  AND i."hideMeta" = false
  AND length(i.meta->>'prompt') > 0
  AND i.ingestion = 'Scanned'
  AND i."tosViolation" = false
  AND i."needsReview" IS NULL
  AND i."blockedFor" IS NULL
  AND i.minor = false
  AND i.poi = false
  AND p."publishedAt" IS NOT NULL
  AND p."publishedAt" <= now()
  AND p.availability != 'Private'::"Availability"
  AND p.availability != 'Unsearchable'::"Availability"
  AND NOT EXISTS (
    SELECT 1
    FROM "ImageResourceNew" fr
    JOIN "ModelVersion" fmv ON fmv.id = fr."modelVersionId"
    JOIN "Model" fm ON fm.id = fmv."modelId"
    WHERE fr."imageId" = i.id
      AND (fm.poi OR fm.minor)
  )
`;

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type CoocRawQuery = (sql: Prisma.Sql) => Promise<unknown[]>;

/** Per-statement cap on the draw's replica reads; the screen's slowest batch took 5.7 s. */
export const COOC_STATEMENT_TIMEOUT_MS = 120_000;

type CoocTxClient = {
  $executeRawUnsafe: (query: string) => Promise<number>;
  $queryRaw: <T = unknown>(query: Prisma.Sql) => Promise<T>;
};
export type CoocTxRunner = <T>(fn: (tx: CoocTxClient) => Promise<T>) => Promise<T>;

/**
 * Each statement in its own transaction under `SET LOCAL statement_timeout`, so a stuck batch is
 * cancelled by the database (and counts as a failed attempt for the retry) instead of holding a
 * replica connection without bound.
 */
export function timedCoocQuery(run: CoocTxRunner, timeoutMs: number): CoocRawQuery {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error('statement timeout must be a positive integer of milliseconds');
  return (sql) =>
    run(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);
      return tx.$queryRaw<unknown[]>(sql);
    });
}

/** The screen's retry, ported: 3 tries, waiting `delayMs` then twice that. */
async function coocRetry<T>(fn: () => Promise<T>, delayMs = 2000, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw last;
}

export type CoocDrawRow = {
  imageId: number;
  createdAt: Date;
  prompt: string;
  att: { modelId: number; modelType: string; versionId: number }[];
};

export type CoocDrawParams = {
  query: CoocRawQuery;
  trainStart: Date;
  trainEnd: Date;
  seed: number;
  target: number;
  idBatch: number;
  maxBatches: number;
  onBatch: (rows: CoocDrawRow[]) => Promise<void>;
  retryDelayMs?: number;
};

export type CoocDrawStats = {
  idLo: number;
  idHi: number;
  boundQueries: number;
  idsTried: number;
  matched: number;
  batches: number;
};

/**
 * Uniformly random Image ids in the window's id range, `mulberry32(seed)`, `idBatch` untried ids
 * per statement, until `target` matched rows or `maxBatches` batches. The id range comes from a
 * binary search on the primary key, so the window costs one tiny indexed read per step.
 */
export async function drawTrainingRows(p: CoocDrawParams): Promise<CoocDrawStats> {
  const q = <T>(sql: Prisma.Sql) => coocRetry(() => p.query(sql) as Promise<T[]>, p.retryDelayMs);
  const maxIdRow = await q<{ max: number | null }>(Prisma.sql`SELECT max(id) AS max FROM "Image"`);
  const maxId = Number(maxIdRow[0]?.max ?? 0);
  let boundQueries = 0;
  async function firstIdAtOrAfter(t: Date): Promise<number> {
    let lo = 1;
    let hi = maxId;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      boundQueries++;
      const r = await q<{ id: number; createdAt: Date }>(Prisma.sql`
        SELECT id, "createdAt" FROM "Image" WHERE id >= ${mid}::int ORDER BY id LIMIT 1`);
      if (!r.length || r[0].createdAt >= t) hi = mid;
      else lo = r[0].id + 1;
    }
    return lo;
  }
  const idLo = await firstIdAtOrAfter(p.trainStart);
  const idHi = (await firstIdAtOrAfter(p.trainEnd)) - 1;

  const rand = mulberry32(p.seed);
  const tried = new Set<number>();
  const span = idHi - idLo + 1;
  let matched = 0;
  let batches = 0;
  for (let b = 0; b < p.maxBatches && matched < p.target; b++) {
    const ids: number[] = [];
    while (ids.length < p.idBatch && tried.size < span) {
      const id = idLo + Math.floor(rand() * span);
      if (tried.has(id)) continue;
      tried.add(id);
      ids.push(id);
    }
    if (!ids.length) break;
    const got = await q<CoocDrawRow>(Prisma.sql`
      WITH s AS (
        SELECT i.id, i."createdAt", i.meta->>'prompt' AS prompt
        FROM "Image" i
        JOIN "Post" p ON p.id = i."postId"
        WHERE i.id = ANY(${ids}::int[])
          AND i."createdAt" >= ${p.trainStart} AND i."createdAt" < ${p.trainEnd}
        ${Prisma.raw(COOC_ELIGIBLE_REST)}
          AND EXISTS (SELECT 1 FROM "ImageResourceNew" r WHERE r."imageId" = i.id)
      )
      SELECT s.id AS "imageId", s."createdAt", s.prompt,
             jsonb_agg(DISTINCT jsonb_build_object('modelId', m.id, 'modelType', m.type::text, 'versionId', mv.id)) AS att
      FROM s
      JOIN "ImageResourceNew" irn ON irn."imageId" = s.id
      JOIN "ModelVersion" mv ON mv.id = irn."modelVersionId"
      JOIN "Model" m ON m.id = mv."modelId"
      GROUP BY s.id, s."createdAt", s.prompt`);
    matched += got.length;
    batches++;
    await p.onBatch(got);
  }
  return { idLo, idHi, boundQueries, idsTried: tried.size, matched, batches };
}

const VERSION_TEXT_CHUNK = 20_000;

/** Names and trigger words of the given versions. */
export async function fetchVersionText(
  query: CoocRawQuery,
  versionIds: readonly number[],
  retryDelayMs?: number
): Promise<Map<number, CoocModelText>> {
  const out = new Map<number, CoocModelText>();
  for (let i = 0; i < versionIds.length; i += VERSION_TEXT_CHUNK) {
    const chunk = versionIds.slice(i, i + VERSION_TEXT_CHUNK);
    const vs = (await coocRetry(
      () =>
        query(Prisma.sql`
      SELECT mv.id, mv."trainedWords", m.name AS "modelName" FROM "ModelVersion" mv JOIN "Model" m ON m.id = mv."modelId"
      WHERE mv.id = ANY(${chunk}::int[])`),
      retryDelayMs
    )) as { id: number; trainedWords: string[] | null; modelName: string }[];
    for (const v of vs) out.set(v.id, { modelName: v.modelName, trainedWords: v.trainedWords });
  }
  return out;
}

export type CoocCountParams = {
  /** Model types that are indexed; every other attachment is ignored. */
  addonTypes: readonly string[];
  minSup: number;
  dfMax: number;
  beta: number;
};

/**
 * Integer counts and the kept (token, model) pairs, in canonical order: `vocab` sorted by UTF-16
 * code unit, `modelIds` ascending, pairs token-major with model index ascending. Nothing here
 * depends on the order rows were added, except the type a model seen with two types keeps: the
 * first, as the screen's builder did. `vocab` holds only tokens with at least one kept pair: a
 * token without one cannot change any ranking, so the snapshot does not keep it.
 */
export type CoocCounts = {
  N: number;
  vocab: string[];
  modelIds: number[];
  modelTypes: string[];
  nT: Uint32Array;
  nM: Uint32Array;
  ptr: Uint32Array;
  modelIdx: Uint32Array;
  c: Uint32Array;
};

class GrowableU32 {
  buf = new Uint32Array(1024);
  length = 0;
  push(v: number) {
    if (this.length === this.buf.length) {
      const next = new Uint32Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.length++] = v;
  }
  view() {
    return this.buf.subarray(0, this.length);
  }
}

const compareCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Accumulates training rows (tokens interned to provisional ids, so an occurrence does not hold a
 * string) and turns them into `CoocCounts`, once. A row is one image: its tokens and its attached
 * models as `[modelId, modelType]`. Duplicates within a row count once.
 */
export class CoocCountAccumulator {
  private readonly addon: ReadonlySet<string>;
  private readonly tokenIds = new Map<string, number>();
  private readonly tokens: string[] = [];
  private readonly models = new Map<number, { idx: number; type: string }>();
  private readonly modelList: number[] = [];
  private readonly rowTok = new GrowableU32();
  private readonly rowTokEnd = new GrowableU32();
  private readonly rowMod = new GrowableU32();
  private readonly rowModEnd = new GrowableU32();
  private finalized = false;
  private typeConflicts = 0;

  constructor(addonTypes: readonly string[]) {
    this.addon = new Set(addonTypes);
  }

  get rows() {
    return this.rowTokEnd.length;
  }

  add(tokens: readonly string[], models: readonly (readonly [number, string])[]) {
    if (this.finalized) throw new Error('CoocCountAccumulator already finalized');
    const seenTok = new Set<number>();
    for (const t of tokens) {
      let id = this.tokenIds.get(t);
      if (id === undefined) {
        id = this.tokens.length;
        this.tokenIds.set(t, id);
        this.tokens.push(t);
      }
      if (seenTok.has(id)) continue;
      seenTok.add(id);
      this.rowTok.push(id);
    }
    this.rowTokEnd.push(this.rowTok.length);
    const seenMod = new Set<number>();
    for (const [modelId, type] of models) {
      if (!this.addon.has(type)) continue;
      let m = this.models.get(modelId);
      if (!m) {
        m = { idx: this.modelList.length, type };
        this.models.set(modelId, m);
        this.modelList.push(modelId);
      } else if (m.type !== type) {
        this.typeConflicts++;
      }
      if (seenMod.has(m.idx)) continue;
      seenMod.add(m.idx);
      this.rowMod.push(m.idx);
    }
    this.rowModEnd.push(this.rowMod.length);
  }

  finalize(
    params: CoocCountParams
  ): CoocCounts & { rawPairs: number; rawVocab: number; typeConflicts: number } {
    if (this.finalized) throw new Error('CoocCountAccumulator already finalized');
    this.finalized = true;
    const N = this.rows;
    const vocab = [...this.tokens].sort(compareCodeUnits);
    const tokRemap = new Uint32Array(this.tokens.length);
    vocab.forEach((t, i) => (tokRemap[this.tokenIds.get(t) as number] = i));
    const modelIds = [...this.modelList].sort((a, b) => a - b);
    const modRemap = new Uint32Array(this.modelList.length);
    const finalIdx = new Map(modelIds.map((id, i) => [id, i]));
    this.modelList.forEach((id, prov) => (modRemap[prov] = finalIdx.get(id) as number));
    const modelTypes = modelIds.map((id) => (this.models.get(id) as { type: string }).type);
    const V = vocab.length;
    const M = modelIds.length;

    const rowTok = this.rowTok.view();
    const rowTokEnd = this.rowTokEnd.view();
    const rowMod = this.rowMod.view();
    const rowModEnd = this.rowModEnd.view();
    for (let k = 0; k < rowTok.length; k++) rowTok[k] = tokRemap[rowTok[k]];
    for (let k = 0; k < rowMod.length; k++) rowMod[k] = modRemap[rowMod[k]];
    this.tokenIds.clear();
    this.tokens.length = 0;

    const nT = new Uint32Array(V);
    const nM = new Uint32Array(M);
    for (let k = 0; k < rowTok.length; k++) nT[rowTok[k]]++;
    for (let k = 0; k < rowMod.length; k++) nM[rowMod[k]]++;

    const postStart = new Uint32Array(V + 1);
    for (let t = 0; t < V; t++) postStart[t + 1] = postStart[t] + nT[t];
    const fill = postStart.slice(0, V);
    const postRows = new Uint32Array(rowTok.length);
    for (let r = 0, k = 0; r < N; r++) {
      for (const end = rowTokEnd[r]; k < end; k++) postRows[fill[rowTok[k]]++] = r;
    }

    const ptr = new Uint32Array(V + 1);
    const keptMod = new GrowableU32();
    const keptC = new GrowableU32();
    const cnt = new Uint32Array(M);
    const touched = new Uint32Array(M);
    const dfLimit = params.dfMax * N;
    let rawPairs = 0;
    for (let t = 0; t < V; t++) {
      let nTouched = 0;
      for (let k = postStart[t]; k < postStart[t + 1]; k++) {
        const r = postRows[k];
        for (let j = r === 0 ? 0 : rowModEnd[r - 1]; j < rowModEnd[r]; j++) {
          const m = rowMod[j];
          if (cnt[m]++ === 0) touched[nTouched++] = m;
        }
      }
      const ms = touched.subarray(0, nTouched).sort();
      rawPairs += nTouched;
      const nt = nT[t];
      for (const m of ms) {
        const c = cnt[m];
        cnt[m] = 0;
        if (c < params.minSup || nt > dfLimit) continue;
        if (Math.log((c * N) / ((nt + params.beta) * nM[m])) > 0) {
          keptMod.push(m);
          keptC.push(c);
        }
      }
      ptr[t + 1] = keptMod.length;
    }
    const keep: number[] = [];
    for (let t = 0; t < V; t++) if (ptr[t + 1] > ptr[t]) keep.push(t);
    const keptPtr = new Uint32Array(keep.length + 1);
    keep.forEach((t, i) => (keptPtr[i + 1] = ptr[t + 1]));
    return {
      N,
      vocab: keep.map((t) => vocab[t]),
      modelIds,
      modelTypes,
      nT: Uint32Array.from(keep, (t) => nT[t]),
      nM,
      ptr: keptPtr,
      modelIdx: keptMod.view().slice(),
      c: keptC.view().slice(),
      rawPairs,
      rawVocab: V,
      typeConflicts: this.typeConflicts,
    };
  }
}

// Payload: msgpack + brotli of the counts and the kept-token vocabulary; integer arrays are
// little-endian uint32 `bin` fields.

export const COOC_PAYLOAD_FORMAT = 'resource-intent-cooc/1';
/** Refuse to write or read a payload above this. */
export const COOC_MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const COOC_MAX_INFLATED_BYTES = 512 * 1024 * 1024;

const packr = new Packr({ useRecords: false, mapsAsObjects: true });
const brotliCompress = promisify(zlib.brotliCompress);
const brotliDecompress = promisify(zlib.brotliDecompress);
const BROTLI_QUALITY = 9;

function u32le(a: Uint32Array): Buffer {
  const out = Buffer.allocUnsafe(a.length * 4);
  for (let i = 0; i < a.length; i++) out.writeUInt32LE(a[i], i * 4);
  return out;
}
function fromU32le(b: Uint8Array, what: string): Uint32Array {
  if (b.length % 4 !== 0) throw new Error(`cooc payload: ${what} is not a uint32 array`);
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  const out = new Uint32Array(b.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = buf.readUInt32LE(i * 4);
  return out;
}

/** Fixed parameters: changing any of them changes the payload bytes, and so every content hash. */
async function compress(raw: Buffer) {
  return brotliCompress(raw, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
      [zlib.constants.BROTLI_PARAM_LGWIN]: zlib.constants.BROTLI_DEFAULT_WINDOW,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
    },
  });
}

export async function serializeCoocCounts(counts: CoocCounts): Promise<Buffer> {
  const typeTable = [...new Set(counts.modelTypes)].sort(compareCodeUnits);
  const typeCode = new Map(typeTable.map((t, i) => [t, i]));
  const codes = Buffer.from(counts.modelTypes.map((t) => typeCode.get(t) as number));
  const raw = packr.pack([
    COOC_PAYLOAD_FORMAT,
    counts.N,
    counts.vocab,
    u32le(Uint32Array.from(counts.modelIds)),
    typeTable,
    codes,
    u32le(counts.nT),
    u32le(counts.nM),
    u32le(counts.ptr),
    u32le(counts.modelIdx),
    u32le(counts.c),
  ]);
  const payload = await compress(raw);
  if (payload.length > COOC_MAX_PAYLOAD_BYTES)
    throw new Error(`cooc payload ${payload.length} bytes exceeds ${COOC_MAX_PAYLOAD_BYTES}`);
  return payload;
}

/** Decode and structurally validate a payload. Does NOT check its hash; the store does. */
export async function deserializeCoocCounts(payload: Uint8Array): Promise<CoocCounts> {
  if (payload.length > COOC_MAX_PAYLOAD_BYTES)
    throw new Error(`cooc payload ${payload.length} bytes exceeds ${COOC_MAX_PAYLOAD_BYTES}`);
  const raw = await brotliDecompress(payload, { maxOutputLength: COOC_MAX_INFLATED_BYTES });
  const v = packr.unpack(raw) as unknown[];
  if (!Array.isArray(v) || v.length !== 11 || v[0] !== COOC_PAYLOAD_FORMAT)
    throw new Error('cooc payload: unknown format');
  const [, N, vocab, mids, typeTable, codes, nTb, nMb, ptrb, midxb, cb] = v as [
    string,
    number,
    string[],
    Uint8Array,
    string[],
    Uint8Array,
    Uint8Array,
    Uint8Array,
    Uint8Array,
    Uint8Array,
    Uint8Array
  ];
  const modelIds = [...fromU32le(mids, 'modelIds')];
  const counts: CoocCounts = {
    N,
    vocab,
    modelIds,
    modelTypes: [...codes].map((code) => {
      const t = typeTable[code];
      if (t === undefined) throw new Error('cooc payload: bad type code');
      return t;
    }),
    nT: fromU32le(nTb, 'nT'),
    nM: fromU32le(nMb, 'nM'),
    ptr: fromU32le(ptrb, 'ptr'),
    modelIdx: fromU32le(midxb, 'modelIdx'),
    c: fromU32le(cb, 'c'),
  };
  validateCoocCounts(counts);
  return counts;
}

export function validateCoocCounts(x: CoocCounts) {
  const fail = (what: string) => {
    throw new Error(`cooc counts invalid: ${what}`);
  };
  const V = x.vocab.length;
  const M = x.modelIds.length;
  if (!Number.isInteger(x.N) || x.N < 0) fail('N');
  for (let i = 1; i < V; i++) if (!(x.vocab[i - 1] < x.vocab[i])) fail('vocab order');
  for (let i = 1; i < M; i++) if (!(x.modelIds[i - 1] < x.modelIds[i])) fail('model order');
  if (x.modelTypes.length !== M || x.nM.length !== M) fail('model arrays');
  if (x.nT.length !== V || x.ptr.length !== V + 1) fail('token arrays');
  if (x.ptr[0] !== 0 || x.ptr[V] !== x.modelIdx.length || x.c.length !== x.modelIdx.length)
    fail('pair arrays');
  for (let t = 0; t < V; t++) {
    if (x.ptr[t + 1] < x.ptr[t]) fail('ptr order');
    for (let k = x.ptr[t]; k < x.ptr[t + 1]; k++) {
      if (x.modelIdx[k] >= M) fail('model index');
      if (k > x.ptr[t] && x.modelIdx[k] <= x.modelIdx[k - 1]) fail('pair order');
      if (x.c[k] === 0 || x.c[k] > x.nT[t] || x.c[k] > x.nM[x.modelIdx[k]]) fail('pair count');
    }
  }
}

/** The training image ids, sorted ascending, as brotli'd little-endian uint32. */
export async function serializeTrainImageIds(ids: readonly number[]): Promise<Buffer> {
  return compress(u32le(Uint32Array.from([...ids].sort((a, b) => a - b))));
}

export async function deserializeTrainImageIds(b: Uint8Array): Promise<number[]> {
  const raw = await brotliDecompress(b, { maxOutputLength: COOC_MAX_INFLATED_BYTES });
  return [...fromU32le(raw, 'trainImageIds')];
}
