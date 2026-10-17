import { createHash } from 'crypto';
import { decode as decodeHtmlEntities } from 'he';
import { canonicalTagKey, compareCodePoints, tagKeys, tagSegments, TAG_STOPWORDS } from './extract';
import type { FloatArray, TagVocabularyEntry } from './score';

/**
 * Builder side of the v1 content-tag index: the frozen vocabulary, each resource's content tags, the
 * outcome-fit tables, popularity, the user-side distributions and the (tag, ecosystem) counts, in the
 * plain arrays the snapshot codec (`./payload`) writes. A port of the offline prototype's v0 `outcomes`
 * and `fit_tables`, its scoring step and `eco_options` counts, and v1's `content_scores`;
 * `src/server/services/__tests__/resource-intent-tags.build.parity.test.ts` holds it to the prototype's
 * own output on synthetic inputs.
 *
 * Reads no database: rows and models are handed in already fetched.
 */

export const TAG_BUILD_PARAMS = {
  /** Per-user outcome normalisation. */
  outcome: { genUserPrior: 10, postUserPrior: 5, tipBonus: 1, disliked: -1 },
  /** Shrinkage priors of the fits, and the user-side score's relevance and lift. */
  fit: {
    resourcePrior: 20,
    tagPrior: 10,
    ecosystemPrior: 10,
    fitExponent: 1,
    liftExponent: 0.5,
    relevancePrior: 5,
    /** A (resource, tag) pair needs this many users for its own fit and user-side share. */
    minTagUsers: 2,
  },
  content: {
    /** Showcase and gallery prompts count only when a resource has at least this many of them. */
    minPrompts: 3,
    promptPrior: 3,
    minScore: 0.1,
    scoreDecimals: 4,
    /** Noisy-OR weight of each content source. */
    weights: { showcase: 1, gallery: 0.6, tags: 0.8, trigger: 0.5, name: 0.8, description: 0.3 },
  },
} as const;
export type TagBuildParams = typeof TAG_BUILD_PARAMS;

/**
 * The largest |fit| a build can produce, from its outcome scale. A generator outcome is y − b with y
 * and the user's shrunk mean b both in [disliked, 1]; a posted outcome is tanh(·) + tipBonus. Each
 * fit is a shrunk average of per-user means of those outcomes (the resource's toward 0, a pair's
 * toward the resource's), so it stays inside the same range, and so does the scorer's weighted F.
 */
export function tagFitBound(params: TagBuildParams['outcome'] = TAG_BUILD_PARAMS.outcome): number {
  return Math.max(1 - params.disliked, 1 + params.tipBonus);
}

export const TAG_VOCABULARY_SCHEMA = 'p2m-vocab/2';

export type TagVocabulary = {
  vocabVersion: string;
  tags: readonly (TagVocabularyEntry & { users: number })[];
  idByKey: ReadonlyMap<string, number>;
};

/**
 * The frozen vocabulary row's payload: version = sha256 of exactly these bytes. Refuses a payload whose
 * tags are not in code-point order of key with `id` = position, or whose `near` sets are not
 * ascending, symmetric, self-free and in range.
 */
export function parseTagVocabulary(payload: Uint8Array): TagVocabulary {
  const fail = (what: string): never => {
    throw new Error(`vocabulary payload invalid: ${what}`);
  };
  const doc = JSON.parse(Buffer.from(payload).toString('utf8')) as {
    schema?: unknown;
    tags?: unknown;
  };
  if (doc.schema !== TAG_VOCABULARY_SCHEMA) fail(`schema ${String(doc.schema)}`);
  if (!Array.isArray(doc.tags) || !doc.tags.length) fail('no tags');
  const raw = doc.tags as Record<string, unknown>[];
  const n = raw.length;
  const tags = raw.map((t, i) => {
    if (t.id !== i) fail(`tag ${i}: id is not its position`);
    if (typeof t.key !== 'string' || !t.key) fail(`tag ${i}: key`);
    if (typeof t.idf !== 'number' || !Number.isFinite(t.idf)) fail(`tag ${i}: idf`);
    if (!Number.isInteger(t.users) || (t.users as number) < 1) fail(`tag ${i}: users`);
    if (typeof t.explicit !== 'boolean') fail(`tag ${i}: explicit`);
    const near = t.near;
    if (!Array.isArray(near)) fail(`tag ${i}: near`);
    for (let k = 0; k < (near as unknown[]).length; k++) {
      const j = (near as unknown[])[k];
      if (!Number.isInteger(j) || (j as number) < 0 || (j as number) >= n || j === i)
        fail(`tag ${i}: near id`);
      if (k && (j as number) <= (near as number[])[k - 1]) fail(`tag ${i}: near order`);
    }
    return {
      key: t.key as string,
      idf: t.idf as number,
      users: t.users as number,
      explicit: t.explicit as boolean,
      near: near as number[],
    };
  });
  for (let i = 1; i < n; i++)
    if (compareCodePoints(tags[i - 1].key, tags[i].key) >= 0) fail('key order');
  const nearSets = tags.map((t) => new Set(t.near));
  tags.forEach((t, i) => {
    for (const j of t.near) if (!nearSets[j].has(i)) fail(`tag ${i}: near is not symmetric`);
  });
  return {
    vocabVersion: createHash('sha256').update(payload).digest('hex'),
    tags,
    idByKey: new Map(tags.map((t, i) => [t.key, i])),
  };
}

/** Vocabulary ids written in a prompt (the request extractor's keys), ascending. */
export function promptTagIds(prompt: string, idByKey: ReadonlyMap<string, number>): number[] {
  const out: number[] = [];
  for (const k of tagKeys(prompt)) {
    const id = idByKey.get(k);
    if (id !== undefined) out.push(id);
  }
  return out.sort((a, b) => a - b);
}

/** Vocabulary ids in a metadata string: every 1–4-gram of every segment, unless all stopwords. */
export function metadataTagIds(text: string, idByKey: ReadonlyMap<string, number>): Set<number> {
  const out = new Set<number>();
  for (const seg of tagSegments(text)) {
    for (let n = 1; n <= 4; n++) {
      for (let i = 0; i + n <= seg.length; i++) {
        const g = seg.slice(i, i + n);
        if (g.every((t) => TAG_STOPWORDS.has(t))) continue;
        const id = idByKey.get(canonicalTagKey(g));
        if (id !== undefined) out.add(id);
      }
    }
  }
  return out;
}

/**
 * `<...>` with at least one character inside each replaced by a space: exactly
 * `s.replace(/<[^>]+>/g, ' ')`, as a linear scan (the regex is quadratic in a run of `<`).
 */
function replaceHtmlTags(s: string): string {
  let out = '';
  let pos = 0;
  let from = 0;
  for (;;) {
    const i = s.indexOf('<', from);
    if (i < 0) break;
    const j = s.indexOf('>', i + 1);
    if (j < 0) break;
    if (j === i + 1) {
      from = j + 1;
      continue;
    }
    out += s.slice(pos, i) + ' ';
    pos = from = j + 1;
  }
  return out + s.slice(pos);
}

/** A model description as plain text: tags removed, then entities decoded. */
export function stripHtml(s: string): string {
  return decodeHtmlEntities(replaceHtmlTags(s));
}

/**
 * `x` rounded to `digits` decimals half to even on its exact binary value, as Python's `round`. Exact
 * for |x| ≥ 2^-4, whose expansion ends within 60 decimals; content scores are at least 0.1.
 */
export function roundHalfEven(x: number, digits: number): number {
  const s = Math.abs(x).toFixed(60);
  const dot = s.indexOf('.');
  const head = s.slice(0, dot + 1 + digits);
  const rest = s.slice(dot + 1 + digits);
  const last = Number(head[head.length - 1]);
  const up = rest[0] > '5' || (rest[0] === '5' && (/[1-9]/.test(rest.slice(1)) || last % 2 === 1));
  const unit = 10 ** -digits;
  const v = Number(head) + (up ? unit : 0);
  return Math.sign(x) * Number(v.toFixed(digits));
}

export type TagContentSources = {
  showcase: readonly string[];
  gallery: readonly string[];
  tags: readonly string[];
  trigger: readonly string[];
  name: string;
  description: string;
};

type ContentSource = keyof TagBuildParams['content']['weights'];
const CONTENT_SOURCES: readonly ContentSource[] = [
  'showcase',
  'gallery',
  'tags',
  'trigger',
  'name',
  'description',
];

/**
 * A resource's content tags, c(t) = 1 − Π_s (1 − w_s·f_s(t)), kept at c ≥ minScore and rounded. A
 * prompt source's f is the share of its prompts carrying t, k_t / (n + promptPrior), used only when
 * the resource has at least `minPrompts` showcase and gallery prompts; a metadata source's f is 1 when
 * its text carries t. `description` is HTML.
 */
export function contentTagScores(
  src: TagContentSources,
  idByKey: ReadonlyMap<string, number>,
  params: TagBuildParams['content'] = TAG_BUILD_PARAMS.content
): Map<number, number> {
  const f = new Map<number, Map<ContentSource, number>>();
  const set = (t: number, s: ContentSource, v: number) => {
    let m = f.get(t);
    if (!m) f.set(t, (m = new Map()));
    m.set(s, v);
  };
  if (src.showcase.length + src.gallery.length >= params.minPrompts) {
    for (const s of ['showcase', 'gallery'] as const) {
      const ps = src[s];
      const count = new Map<number, number>();
      for (const p of ps)
        for (const t of promptTagIds(p, idByKey)) count.set(t, (count.get(t) ?? 0) + 1);
      for (const [t, k] of count) set(t, s, k / (ps.length + params.promptPrior));
    }
  }
  for (const s of ['tags', 'trigger'] as const)
    for (const item of src[s]) for (const t of metadataTagIds(item, idByKey)) set(t, s, 1);
  for (const t of metadataTagIds(src.name, idByKey)) set(t, 'name', 1);
  for (const t of metadataTagIds(stripHtml(src.description), idByKey)) set(t, 'description', 1);

  const out = new Map<number, number>();
  for (const [t, fs] of f) {
    let q = 1;
    for (const s of CONTENT_SOURCES) {
      const v = fs.get(s);
      if (v !== undefined) q *= 1 - params.weights[s] * v;
    }
    const c = 1 - q;
    if (c >= params.minScore) out.set(t, roundHalfEven(c, params.scoreDecimals));
  }
  return out;
}

export type TagResourceKind = 'addon' | 'checkpoint';

export type TrainingResource = { modelId: number; type: string; baseModel: string | null };

type TrainingRowBase = {
  /** Any stable identifier; both sources must share one namespace. */
  user: string;
  prompt: string;
  resources: readonly TrainingResource[];
};
export type TagTrainingRow =
  | (TrainingRowBase & { source: 'gen'; liked: boolean; favorite: boolean; disliked: boolean })
  | (TrainingRowBase & { source: 'post'; reactions: number; tips: number });

/** A row's ecosystem: the base model of its checkpoints when they agree on exactly one. */
export function rowEcosystem(resources: readonly TrainingResource[]): string | null {
  const bms = new Set(resources.filter((r) => r.type === 'Checkpoint').map((r) => r.baseModel));
  if (bms.size !== 1) return null;
  return [...bms][0] || null;
}

export type TagModelContent = TagContentSources & {
  modelId: number;
  type: string;
  /** Base models of the model's versions: the ecosystems it is published for. */
  baseModels: readonly string[];
};

/** Sparse per-key lists, CSR: key `keys[i]` owns entries `ptr[i]` to `ptr[i + 1]`. */
export type SparseByKey = {
  keys: Uint32Array;
  ptr: Uint32Array;
  resource: Uint32Array;
  value: FloatArray;
};

export type TagIndexKindData = {
  modelIds: Uint32Array;
  fit: FloatArray;
  /** Per resource, its ecosystem ids, CSR. */
  ecosystemPtr: Uint32Array;
  ecosystemIds: Uint32Array;
  /** Per tag id, CSR over the whole vocabulary. `fit` is NaN where the pair has no fit of its own. */
  postings: { ptr: Uint32Array; resource: Uint32Array; c: FloatArray; fit: FloatArray };
  ecosystemUsers: SparseByKey;
  userByTag: SparseByKey;
  userByEcosystem: SparseByKey;
};

export type TagIndexData = {
  vocabVersion: string;
  /** Not derived from `ecosystems`, so `tagIndexFromData` can tell if one was dropped after counting. */
  rowsWithEcosystem: number;
  vocabulary: readonly (TagVocabularyEntry & { users: number })[];
  ecosystems: { name: string; users: number; observations: number }[];
  /** Per tag id, CSR over the vocabulary: training observations per ecosystem id. */
  tagEcosystemCounts: { ptr: Uint32Array; ecosystem: Uint32Array; count: Uint32Array };
  kinds: Record<TagResourceKind, TagIndexKindData>;
};

export type TagBuildStats = {
  rows: { gen: number; post: number };
  excludedByAuditor: number;
  droppedNoResources: number;
  users: number;
  rowsWithEcosystem: number;
  rowsWithTag: number;
  models: { content: number; used: number; addon: number; checkpoint: number };
  modelsWithContentTag: number;
  typeConflicts: number;
  contentPairs: number;
  fitPairs: number;
  postings: number;
  ecosystems: number;
};

/**
 * The entry order that groups entries by key (0..keyCount-1) and, within a key, by resource ascending;
 * equal (key, resource) entries keep their input order.
 */
function csrOrder(keyCount: number, keys: Uint32Array, resource: Uint32Array): Uint32Array {
  const start = new Uint32Array(keyCount + 1);
  for (let k = 0; k < keys.length; k++) start[keys[k] + 1]++;
  for (let i = 0; i < keyCount; i++) start[i + 1] += start[i];
  const fill = start.slice(0, keyCount);
  const order = new Uint32Array(keys.length);
  for (let k = 0; k < keys.length; k++) order[fill[keys[k]]++] = k;
  for (let i = 0; i < keyCount; i++) {
    const seg = order.subarray(start[i], start[i + 1]);
    if (seg.length > 1) seg.set(Array.from(seg).sort((a, b) => resource[a] - resource[b] || a - b));
  }
  return order;
}

/** Entries grouped by key; with `normalise`, each key's values divided by their sum. */
function sparseByKey(
  keyCount: number,
  keys: Uint32Array,
  resource: Uint32Array,
  value: Float64Array,
  normalise: boolean
): SparseByKey {
  const order = csrOrder(keyCount, keys, resource);
  const keyList: number[] = [];
  const ptr: number[] = [0];
  const res = new Uint32Array(order.length);
  const val = new Float64Array(order.length);
  for (let j = 0; j < order.length; j++) {
    const k = order[j];
    if (j && keys[order[j - 1]] !== keys[k]) ptr.push(j);
    if (!j || keys[order[j - 1]] !== keys[k]) keyList.push(keys[k]);
    res[j] = resource[k];
    val[j] = value[k];
  }
  if (order.length) ptr.push(order.length);
  if (normalise) {
    for (let i = 0; i < keyList.length; i++) {
      let tot = 0;
      for (let k = ptr[i]; k < ptr[i + 1]; k++) tot += val[k];
      for (let k = ptr[i]; k < ptr[i + 1]; k++) val[k] /= tot;
    }
  }
  return { keys: Uint32Array.from(keyList), ptr: Uint32Array.from(ptr), resource: res, value: val };
}

class Grow<T extends Uint32Array | Float64Array | Uint8Array> {
  length = 0;
  constructor(public buf: T) {}
  push(v: number) {
    if (this.length === this.buf.length) {
      const next = new (this.buf.constructor as new (n: number) => T)(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.length++] = v;
  }
  view(): T {
    return this.buf.subarray(0, this.length) as T;
  }
}
const u32 = () => new Grow(new Uint32Array(1024));
const f64 = () => new Grow(new Float64Array(1024));

type ModelEntry = {
  kind: TagResourceKind;
  content: { tags: Uint32Array; c: Float64Array } | null;
  baseModels: readonly string[];
};

/**
 * Accumulates models and training rows, then computes the index once. Rows are kept as interned ids
 * (no prompt text), and every aggregate is computed per user then per model, so memory follows the
 * number of (row, tag) and (row, resource) incidences rather than of (user, resource, tag) triples.
 */
export class TagIndexAccumulator {
  private readonly models = new Map<number, ModelEntry>();
  private readonly users = new Map<string, number>();
  private readonly ecoIds = new Map<string, number>();
  private readonly ecoNames: string[] = [];
  private readonly addon: ReadonlySet<string>;
  private readonly rowUser = u32();
  private readonly rowSource = new Grow(new Uint8Array(1024));
  /** gen: the raw outcome y; post: log1p(reactions). */
  private readonly rowValue = f64();
  private readonly rowTipped = new Grow(new Uint8Array(1024));
  /** Ecosystem id + 1; 0 when the row has none. */
  private readonly rowEco = u32();
  private readonly rowTagEnd = u32();
  private readonly rowTags = u32();
  private readonly rowResEnd = u32();
  private readonly rowResModel = u32();
  private readonly rowResMult = u32();
  private readonly modelIdx = new Map<number, number>();
  private readonly modelList: number[] = [];
  private excluded = 0;
  private dropped = 0;
  private typeConflicts = 0;
  private finalized = false;

  constructor(
    private readonly vocab: TagVocabulary,
    opts: {
      addonTypes: readonly string[];
      /** True drops the generator row (counted as `excludedByAuditor`). */
      excludeGenPrompt: (prompt: string) => boolean;
      params?: TagBuildParams;
    }
  ) {
    this.addon = new Set(opts.addonTypes);
    this.excludeGenPrompt = opts.excludeGenPrompt;
    this.params = opts.params ?? TAG_BUILD_PARAMS;
  }
  private readonly excludeGenPrompt: (prompt: string) => boolean;
  private readonly params: TagBuildParams;

  private kindOf(type: string): TagResourceKind | null {
    return type === 'Checkpoint' ? 'checkpoint' : this.addon.has(type) ? 'addon' : null;
  }

  private eco(name: string): number {
    let id = this.ecoIds.get(name);
    if (id === undefined) {
      id = this.ecoNames.length;
      this.ecoIds.set(name, id);
      this.ecoNames.push(name);
    }
    return id;
  }

  private model(modelId: number, kind: TagResourceKind): number {
    const m = this.models.get(modelId);
    if (!m) this.models.set(modelId, { kind, content: null, baseModels: [] });
    else if (m.kind !== kind) this.typeConflicts++;
    let idx = this.modelIdx.get(modelId);
    if (idx === undefined) {
      idx = this.modelList.length;
      this.modelIdx.set(modelId, idx);
      this.modelList.push(modelId);
    }
    return idx;
  }

  /** Ids of the models seen in a row, as an add-on or a checkpoint, ascending. */
  usedModelIds(): number[] {
    const used = new Set(this.rowResModel.view());
    return [...used].map((idx) => this.modelList[idx]).sort((a, b) => a - b);
  }

  /** One model's content; a model given twice keeps its first content. */
  addModel(m: TagModelContent) {
    if (this.finalized) throw new Error('TagIndexAccumulator already finalized');
    const kind = this.kindOf(m.type);
    if (!kind) return;
    this.model(m.modelId, kind);
    const entry = this.models.get(m.modelId) as ModelEntry;
    if (entry.content) return;
    const scores = contentTagScores(m, this.vocab.idByKey, this.params.content);
    const tags = [...scores.keys()].sort((a, b) => a - b);
    entry.content = {
      tags: Uint32Array.from(tags),
      c: Float64Array.from(tags, (t) => scores.get(t) as number),
    };
    entry.baseModels = [...new Set(m.baseModels.filter(Boolean))];
    for (const b of entry.baseModels) this.eco(b);
  }

  addRow(row: TagTrainingRow) {
    if (this.finalized) throw new Error('TagIndexAccumulator already finalized');
    if (row.source === 'gen' && this.excludeGenPrompt(row.prompt)) {
      this.excluded++;
      return;
    }
    if (!row.resources.length) {
      this.dropped++;
      return;
    }
    let u = this.users.get(row.user);
    if (u === undefined) this.users.set(row.user, (u = this.users.size));
    this.rowUser.push(u);
    if (row.source === 'gen') {
      this.rowSource.push(0);
      const o = this.params.outcome;
      this.rowValue.push(row.liked || row.favorite ? 1 : row.disliked ? o.disliked : 0);
      this.rowTipped.push(0);
    } else {
      this.rowSource.push(1);
      this.rowValue.push(Math.log1p(row.reactions));
      this.rowTipped.push(row.tips > 0 ? 1 : 0);
    }
    const eco = rowEcosystem(row.resources);
    this.rowEco.push(eco ? this.eco(eco) + 1 : 0);
    for (const t of promptTagIds(row.prompt, this.vocab.idByKey)) this.rowTags.push(t);
    this.rowTagEnd.push(this.rowTags.length);
    // Distinct (model, type, baseModel) triples, as the prototype's set: a model reached through
    // versions of two base models counts twice in its user's mean.
    const mult = new Map<number, Set<string>>();
    for (const r of row.resources) {
      const kind = this.kindOf(r.type);
      if (!kind) continue;
      const idx = this.model(r.modelId, kind);
      let s = mult.get(idx);
      if (!s) mult.set(idx, (s = new Set()));
      s.add(`${r.type}\u0000${r.baseModel ?? ''}`);
    }
    for (const [idx, s] of mult) {
      this.rowResModel.push(idx);
      this.rowResMult.push(s.size);
    }
    this.rowResEnd.push(this.rowResModel.length);
  }

  finalize(): { data: TagIndexData; stats: TagBuildStats } {
    if (this.finalized) throw new Error('TagIndexAccumulator already finalized');
    this.finalized = true;
    const P = this.params;
    const V = this.vocab.tags.length;
    const N = this.rowUser.length;
    const nUsers = this.users.size;
    const rowUser = this.rowUser.view();
    const rowSource = this.rowSource.view();
    const rowValue = this.rowValue.view();
    const rowTipped = this.rowTipped.view();
    const rowEco = this.rowEco.view();
    const rowTagEnd = this.rowTagEnd.view();
    const rowTags = this.rowTags.view();
    const rowResEnd = this.rowResEnd.view();
    const rowResModel = this.rowResModel.view();
    const rowResMult = this.rowResMult.view();
    const tagStart = (r: number) => (r === 0 ? 0 : rowTagEnd[r - 1]);
    const resStart = (r: number) => (r === 0 ? 0 : rowResEnd[r - 1]);

    // Outcomes, each against its user's own shrunk baseline (the prototype's `outcomes`).
    const x = new Float64Array(N);
    {
      const sum = [new Float64Array(nUsers), new Float64Array(nUsers)];
      const cnt = [new Uint32Array(nUsers), new Uint32Array(nUsers)];
      const tot = [0, 0];
      const n = [0, 0];
      for (let r = 0; r < N; r++) {
        const s = rowSource[r];
        sum[s][rowUser[r]] += rowValue[r];
        cnt[s][rowUser[r]]++;
        tot[s] += rowValue[r];
        n[s]++;
      }
      const g = [tot[0] / Math.max(n[0], 1), tot[1] / Math.max(n[1], 1)];
      const k = [P.outcome.genUserPrior, P.outcome.postUserPrior];
      const base = (s: number, u: number) => (sum[s][u] + k[s] * g[s]) / (cnt[s][u] + k[s]);
      let ss = 0;
      for (let r = 0; r < N; r++) {
        if (rowSource[r] !== 1) continue;
        const d = rowValue[r] - base(1, rowUser[r]);
        ss += d * d;
      }
      const sd = Math.sqrt(ss / Math.max(n[1], 1)) || 1;
      for (let r = 0; r < N; r++) {
        const b = base(rowSource[r], rowUser[r]);
        x[r] =
          rowSource[r] === 0
            ? rowValue[r] - b
            : Math.tanh((rowValue[r] - b) / sd) + (rowTipped[r] ? P.outcome.tipBonus : 0);
      }
    }

    // Rows grouped by user; every "distinct users" count below walks this order.
    const byUser = new Uint32Array(N);
    {
      const start = new Uint32Array(nUsers + 1);
      for (let r = 0; r < N; r++) start[rowUser[r] + 1]++;
      for (let u = 0; u < nUsers; u++) start[u + 1] += start[u];
      const fill = start.slice(0, nUsers);
      for (let r = 0; r < N; r++) byUser[fill[rowUser[r]]++] = r;
    }

    const E = this.ecoNames.length;
    const tagUsers = new Uint32Array(V);
    const ecoUsers = new Uint32Array(E);
    const ecoObs = new Uint32Array(E);
    const tagEco = new Uint32Array(V * E);
    let rowsWithEco = 0;
    let rowsWithTag = 0;
    {
      const tagSeen = new Int32Array(V).fill(-1);
      const ecoSeen = new Int32Array(E).fill(-1);
      for (const r of byUser) {
        const u = rowUser[r];
        const e = rowEco[r] - 1;
        if (rowTagEnd[r] > tagStart(r)) rowsWithTag++;
        for (let k = tagStart(r); k < rowTagEnd[r]; k++) {
          const t = rowTags[k];
          if (tagSeen[t] !== u) {
            tagSeen[t] = u;
            tagUsers[t]++;
          }
          if (e >= 0) tagEco[t * E + e]++;
        }
        if (e >= 0) {
          rowsWithEco++;
          ecoObs[e]++;
          if (ecoSeen[e] !== u) {
            ecoSeen[e] = u;
            ecoUsers[e]++;
          }
        }
      }
    }

    // Per model, its (row, multiplicity) incidences in user order.
    const M = this.modelList.length;
    const incStart = new Uint32Array(M + 1);
    for (let k = 0; k < rowResModel.length; k++) incStart[rowResModel[k] + 1]++;
    for (let m = 0; m < M; m++) incStart[m + 1] += incStart[m];
    const incRow = new Uint32Array(rowResModel.length);
    const incMult = new Uint32Array(rowResModel.length);
    {
      const fill = incStart.slice(0, M);
      for (const r of byUser) {
        for (let k = resStart(r); k < rowResEnd[r]; k++) {
          const at = fill[rowResModel[k]]++;
          incRow[at] = r;
          incMult[at] = rowResMult[k];
        }
      }
    }

    // One vote per user: X = Σ_users (that user's mean outcome), n = users; then the shrunk fits and
    // the user-side score s = rel·lift^γ·exp(λ·fit) (the prototype's `fit_tables` and scoring step).
    const F = P.fit;
    const fitR = new Float64Array(M);
    const usedR = new Uint8Array(M);
    const tagOut = { tag: u32(), model: u32(), fit: f64(), s: f64() };
    const ecoOut = { eco: u32(), model: u32(), users: u32(), s: f64() };
    {
      const tSum = new Float64Array(V);
      const tW = new Uint32Array(V);
      const tX = new Float64Array(V);
      const tN = new Uint32Array(V);
      const eSum = new Float64Array(E);
      const eW = new Uint32Array(E);
      const eX = new Float64Array(E);
      const eN = new Uint32Array(E);
      const touchedT: number[] = [];
      const touchedTAll: number[] = [];
      const touchedE: number[] = [];
      const touchedEAll: number[] = [];
      for (let m = 0; m < M; m++) {
        let rX = 0;
        let rN = 0;
        let k = incStart[m];
        const end = incStart[m + 1];
        while (k < end) {
          const u = rowUser[incRow[k]];
          let sum = 0;
          let w = 0;
          for (; k < end && rowUser[incRow[k]] === u; k++) {
            const r = incRow[k];
            const mult = incMult[k];
            const xv = x[r] * mult;
            sum += xv;
            w += mult;
            const e = rowEco[r] - 1;
            if (e >= 0) {
              if (!eW[e]) touchedE.push(e);
              eSum[e] += xv;
              eW[e] += mult;
            }
            for (let j = tagStart(r); j < rowTagEnd[r]; j++) {
              const t = rowTags[j];
              if (!tW[t]) touchedT.push(t);
              tSum[t] += xv;
              tW[t] += mult;
            }
          }
          rX += sum / w;
          rN++;
          for (const t of touchedT) {
            if (!tN[t]) touchedTAll.push(t);
            tX[t] += tSum[t] / tW[t];
            tN[t]++;
            tSum[t] = 0;
            tW[t] = 0;
          }
          touchedT.length = 0;
          for (const e of touchedE) {
            if (!eN[e]) touchedEAll.push(e);
            eX[e] += eSum[e] / eW[e];
            eN[e]++;
            eSum[e] = 0;
            eW[e] = 0;
          }
          touchedE.length = 0;
        }
        if (rN) {
          usedR[m] = 1;
          fitR[m] = rX / (rN + F.resourcePrior);
        }
        const fr = fitR[m];
        const s = (n: number, keyUsers: number, fit: number) => {
          const rel = n / (keyUsers + F.relevancePrior);
          const lift = rel / ((rN + 1) / nUsers);
          return rel * Math.max(lift, 1e-9) ** F.liftExponent * Math.exp(F.fitExponent * fit);
        };
        for (const t of touchedTAll) {
          if (tN[t] >= F.minTagUsers) {
            const fit = (tX[t] + F.tagPrior * fr) / (tN[t] + F.tagPrior);
            tagOut.tag.push(t);
            tagOut.model.push(m);
            tagOut.fit.push(fit);
            tagOut.s.push(s(tN[t], tagUsers[t], fit));
          }
          tX[t] = 0;
          tN[t] = 0;
        }
        touchedTAll.length = 0;
        for (const e of touchedEAll) {
          const fit = (eX[e] + F.ecosystemPrior * fr) / (eN[e] + F.ecosystemPrior);
          ecoOut.eco.push(e);
          ecoOut.model.push(m);
          ecoOut.users.push(eN[e]);
          ecoOut.s.push(s(eN[e], ecoUsers[e], fit));
          eX[e] = 0;
          eN[e] = 0;
        }
        touchedEAll.length = 0;
      }
    }

    // Ecosystems in code-point order of name; ids are positions.
    const ecoOrder = this.ecoNames
      .map((name, prov) => ({ name, prov }))
      .sort((a, b) => compareCodePoints(a.name, b.name));
    const ecoRemap = new Uint32Array(E);
    ecoOrder.forEach((x, i) => (ecoRemap[x.prov] = i));

    const tagEcoPtr = new Uint32Array(V + 1);
    const tagEcoEco = u32();
    const tagEcoCount = u32();
    for (let t = 0; t < V; t++) {
      for (const { prov } of ecoOrder) {
        const c = tagEco[t * E + prov];
        if (!c) continue;
        tagEcoEco.push(ecoRemap[prov]);
        tagEcoCount.push(c);
      }
      tagEcoPtr[t + 1] = tagEcoEco.length;
    }

    const stats: TagBuildStats = {
      rows: {
        gen: rowSource.reduce((n, s) => n + (s === 0 ? 1 : 0), 0),
        post: rowSource.reduce((n, s) => n + (s === 1 ? 1 : 0), 0),
      },
      excludedByAuditor: this.excluded,
      droppedNoResources: this.dropped,
      users: nUsers,
      rowsWithEcosystem: rowsWithEco,
      rowsWithTag,
      models: {
        content: [...this.models.values()].filter((m) => m.content).length,
        used: usedR.reduce((n, v) => n + v, 0),
        addon: 0,
        checkpoint: 0,
      },
      modelsWithContentTag: [...this.models.values()].filter((m) => m.content?.tags.length).length,
      typeConflicts: this.typeConflicts,
      contentPairs: 0,
      fitPairs: tagOut.tag.length,
      postings: 0,
      ecosystems: E,
    };

    const kinds = {} as Record<TagResourceKind, TagIndexKindData>;
    const tagModel = tagOut.model.view();
    const tagTag = tagOut.tag.view();
    const tagFit = tagOut.fit.view();
    const tagS = tagOut.s.view();
    const em = ecoOut.model.view();
    const ee = Uint32Array.from(ecoOut.eco.view(), (e) => ecoRemap[e]);
    const eu = Float64Array.from(ecoOut.users.view());
    const es = ecoOut.s.view();
    for (const kind of ['addon', 'checkpoint'] as const) {
      const ids = this.modelList
        .map((id, idx) => ({ id, idx }))
        .filter((x) => (this.models.get(x.id) as ModelEntry).kind === kind)
        .sort((a, b) => a.id - b.id);
      const n = ids.length;
      stats.models[kind] = n;
      const local = new Int32Array(M).fill(-1);
      ids.forEach((x, i) => (local[x.idx] = i));
      const content = ids.map((x) => (this.models.get(x.id) as ModelEntry).content);

      const ecoPtr = new Uint32Array(n + 1);
      const ecoList: number[] = [];
      ids.forEach((x, i) => {
        const bms = (this.models.get(x.id) as ModelEntry).baseModels;
        const ids_ = bms.map((b) => ecoRemap[this.ecoIds.get(b) as number]).sort((a, b) => a - b);
        ecoList.push(...ids_);
        ecoPtr[i + 1] = ecoList.length;
      });

      // Postings: content pairs ∪ pairs with their own fit, per tag in resource order.
      const ck = u32();
      const cr = u32();
      const cc = f64();
      const cf = f64();
      content.forEach((ct, i) => {
        if (!ct) return;
        for (let k = 0; k < ct.tags.length; k++) {
          ck.push(ct.tags[k]);
          cr.push(i);
          cc.push(ct.c[k]);
          cf.push(NaN);
        }
        stats.contentPairs += ct.tags.length;
      });
      for (let k = 0; k < tagModel.length; k++) {
        const i = local[tagModel[k]];
        if (i < 0) continue;
        ck.push(tagTag[k]);
        cr.push(i);
        cc.push(0);
        cf.push(tagFit[k]);
      }
      const order = csrOrder(V, ck.view(), cr.view());
      const ptr = new Uint32Array(V + 1);
      const pr = u32();
      const pc = f64();
      const pf = f64();
      {
        const keys = ck.view();
        const res = cr.view();
        const cv = cc.view();
        const fv = cf.view();
        for (let j = 0; j < order.length; j++) {
          const k = order[j];
          // A pair in both lists: its content entry comes first (pushed first, stable order).
          if (j && keys[order[j - 1]] === keys[k] && res[order[j - 1]] === res[k]) {
            pf.buf[pf.length - 1] = fv[k];
            continue;
          }
          ptr[keys[k] + 1]++;
          pr.push(res[k]);
          pc.push(cv[k]);
          pf.push(fv[k]);
        }
      }
      for (let t = 0; t < V; t++) ptr[t + 1] += ptr[t];
      stats.postings += pr.length;

      /** The entries whose model is of this kind, with model indices made kind-local. */
      const ofKind = (model: Uint32Array, key: Uint32Array, value: Float64Array) => {
        const sel: number[] = [];
        for (let k = 0; k < model.length; k++) if (local[model[k]] >= 0) sel.push(k);
        return {
          key: Uint32Array.from(sel, (k) => key[k]),
          resource: Uint32Array.from(sel, (k) => local[model[k]]),
          value: Float64Array.from(sel, (k) => value[k]),
        };
      };
      const tu = ofKind(tagModel, tagTag, tagS);
      const eUsers = ofKind(em, ee, eu);
      const eShare = ofKind(em, ee, es);

      kinds[kind] = {
        modelIds: Uint32Array.from(ids, (x) => x.id),
        fit: Float64Array.from(ids, (x) => fitR[x.idx]),
        ecosystemPtr: ecoPtr,
        ecosystemIds: Uint32Array.from(ecoList),
        postings: {
          ptr,
          resource: pr.view().slice(),
          c: pc.view().slice(),
          fit: pf.view().slice(),
        },
        ecosystemUsers: sparseByKey(E, eUsers.key, eUsers.resource, eUsers.value, false),
        userByTag: sparseByKey(V, tu.key, tu.resource, tu.value, true),
        userByEcosystem: sparseByKey(E, eShare.key, eShare.resource, eShare.value, true),
      };
    }

    return {
      data: {
        vocabVersion: this.vocab.vocabVersion,
        rowsWithEcosystem: rowsWithEco,
        vocabulary: this.vocab.tags,
        ecosystems: ecoOrder.map((x) => ({
          name: x.name,
          users: ecoUsers[x.prov],
          observations: ecoObs[x.prov],
        })),
        tagEcosystemCounts: {
          ptr: tagEcoPtr,
          ecosystem: tagEcoEco.view().slice(),
          count: tagEcoCount.view().slice(),
        },
        kinds,
      },
      stats,
    };
  }
}
