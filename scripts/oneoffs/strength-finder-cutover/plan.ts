// The cutover copy's PLAN for one app: legacy per-viewer `kv` rows into a private collection,
// legacy `shared_kv` rows into a shared collection under their original author and hidden
// state, legacy votes into `vote` marks. Pure: it reads only the rows handed to it, so the dry
// run, the execute and the tests all build the same plan from the same inputs.
//
// A plan with any ABORT reason is never executed, whatever else it holds. The abort reasons are
// the cases where copying would lose or misstate something the copy promises to keep:
//   - a shared row whose author cannot be kept (the developer would rather lose the data);
//   - two legacy keys that map to one document key (either would overwrite the other);
//   - one viewer holding one key in two block instances (the private collection has one);
//   - a key already holding a document written by someone else;
//   - a hidden row with no moderator to record as its hider;
//   - a document the store would refuse (size, the declared index's type), or a quota it would
//     exceed part-way through.
// Never pick a winner: report and stop. Abort examples carry keys, never user ids.
import { createHash } from 'crypto';

export const DOC_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const DOT_ONLY = /^\.+$/;
const KEY_MAX = 128;
export const DOC_BYTES_MAX = 65536;

export type Limits = { appBytes: number; appDocs: number; userBytes: number; userDocs: number };

export type KvRow = {
  blockInstanceId: string;
  userId: number;
  key: string;
  value: unknown;
  /** `octet_length(value::text)`, the same unit the document store charges. */
  sizeBytes: number;
  createdAt: Date;
};

export type SharedRow = {
  key: string;
  authorUserId: unknown;
  value: unknown;
  sizeBytes: number;
  hiddenAt: Date | null;
  hiddenBy: number | null;
  createdAt: Date;
};

export type VoteRow = { key: string; userId: number };

export type ExistingDoc = {
  key: string;
  /** 0 for a shared document, the viewer for a private one. */
  scopeUid: number;
  authorKind: string;
  authorUid: number | null;
  data: unknown;
  hidden: boolean;
};

export type Usage = { bytes: number; docs: number };

export type PlanInput = {
  kv: KvRow[];
  shared: SharedRow[];
  votes: VoteRow[];
  counterRows: number;
  reportRows: number;
  /** Documents already in the target collections (hidden included). */
  existingPrivate: ExistingDoc[];
  existingShared: ExistingDoc[];
  /** `vote` marks already on the shared collection, as `${key}\u0000${userId}`. */
  existingVotes: Set<string>;
  usageApp: Usage;
  usageUser: Map<number, Usage>;
  /** Index name → declared type, for the shared collection. */
  sharedIndexes: Record<string, string>;
  limits: Limits;
};

export type PrivateWrite = { userId: number; key: string; legacyKey: string; data: object };
export type SharedWrite = {
  key: string;
  legacyKey: string;
  authorUid: number;
  data: object;
  /** Votes to mark after the put and before any hide (a hidden document cannot be marked). */
  voters: number[];
  hideBy: number | null;
};
export type VoteWrite = { key: string; userId: number };
export type HideWrite = { key: string; moderatorUid: number };

export type AbortReason =
  | 'author_not_kept'
  | 'mapped_key_collision_private'
  | 'mapped_key_collision_shared'
  | 'instance_key_collision'
  | 'key_taken_private'
  | 'key_taken_shared'
  | 'hidden_without_moderator'
  | 'doc_too_large'
  | 'index_type'
  | 'quota_user'
  | 'quota_app'
  | 'vote_on_hidden_unmarked';

export type Plan = {
  privateWrites: PrivateWrite[];
  sharedWrites: SharedWrite[];
  /** Votes for shared documents that were already copied (a resumed run). */
  voteWrites: VoteWrite[];
  /** Hides for shared documents that were already copied (a resumed run). */
  hideWrites: HideWrite[];
  /** Every legacy key that changes, legacy → document key. */
  mapping: { store: 'kv' | 'shared_kv'; legacyKey: string; key: string }[];
  aborts: { reason: AbortReason; count: number; examples: string[] }[];
  counts: Record<string, number>;
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** The document body: a legacy object as is, anything else wrapped as `{ value }` (the guide). */
export function toDocData(value: unknown): { data: object; wrapped: boolean } {
  return isObject(value) ? { data: value, wrapped: false } : { data: { value }, wrapped: true };
}

/** The stored size of a body the copy wraps: `{"value": <v>}` in jsonb's text form. */
function storedSize(sizeBytes: number, wrapped: boolean): number {
  return wrapped ? sizeBytes + '{"value": }'.length : sizeBytes;
}

/**
 * The document key for a legacy key. A valid one is unchanged. Otherwise, deterministically:
 * each `/` becomes `:`, each other character outside the key alphabet becomes `-` plus the
 * lowercase hex of its UTF-8 bytes, and a result over 128 characters keeps its first 111 and
 * ends `.` + the first 16 hex of the legacy key's sha256. Collisions are not prevented here;
 * the plan detects them and aborts.
 */
export function mapKey(legacyKey: string): string {
  if (DOC_KEY.test(legacyKey) && !DOT_ONLY.test(legacyKey)) return legacyKey;
  let out = '';
  for (const ch of legacyKey) {
    if (ch === '/') out += ':';
    else if (/^[A-Za-z0-9_:-]$/.test(ch)) out += ch;
    else if (ch === '.') out += DOT_ONLY.test(legacyKey) ? '-2e' : '.';
    else
      out += [...Buffer.from(ch, 'utf8')]
        .map((b) => '-' + b.toString(16).padStart(2, '0'))
        .join('');
  }
  if (out.length > KEY_MAX) {
    const digest = createHash('sha256').update(legacyKey, 'utf8').digest('hex').slice(0, 16);
    out = out.slice(0, KEY_MAX - 17) + '.' + digest;
  }
  return out;
}

/** A positive safe integer, the only author a document can carry. */
export function keepsAuthor(uid: unknown): uid is number {
  return typeof uid === 'number' && Number.isSafeInteger(uid) && uid > 0;
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (isObject(v)) {
    return (
      '{' +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + stableStringify(v[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(v);
}

/** Why the store would refuse this body under the declared indexes, or null. */
function indexProblem(data: object, indexes: Record<string, string>): string | null {
  for (const [name, type] of Object.entries(indexes)) {
    let raw: unknown = data;
    for (const seg of name.split('.')) raw = isObject(raw) ? raw[seg] : undefined;
    if (raw === undefined || raw === null) continue;
    const ok =
      type === 'number'
        ? typeof raw === 'number' && Number.isFinite(raw)
        : type === 'string'
        ? typeof raw === 'string' && Buffer.byteLength(raw, 'utf8') <= 128
        : type === 'boolean'
        ? typeof raw === 'boolean'
        : type === 'time'
        ? Number.isFinite(
            typeof raw === 'number' ? raw : typeof raw === 'string' ? Date.parse(raw) : NaN
          )
        : false;
    if (!ok) return `${name}:${type}`;
  }
  return null;
}

export function buildPlan(input: PlanInput): Plan {
  const aborts = new Map<AbortReason, { count: number; examples: string[] }>();
  const abort = (reason: AbortReason, example: string) => {
    const a = aborts.get(reason) ?? { count: 0, examples: [] };
    a.count++;
    if (a.examples.length < 5) a.examples.push(example);
    aborts.set(reason, a);
  };
  const counts: Record<string, number> = {
    legacyKvRows: input.kv.length,
    legacySharedRows: input.shared.length,
    legacySharedHidden: input.shared.filter((r) => r.hiddenAt).length,
    legacyVoteRows: input.votes.length,
    legacyCounterRows: input.counterRows,
    legacyReportRows: input.reportRows,
    kvViewers: new Set(input.kv.map((r) => r.userId)).size,
    sharedAuthors: 0,
    sharedAuthorsKept: 0,
    sharedRowsAuthorNotKept: 0,
    mappedKeysKv: 0,
    mappedKeysShared: 0,
    wrappedKv: 0,
    wrappedShared: 0,
    alreadyCopiedPrivate: 0,
    alreadyCopiedShared: 0,
    alreadyCopiedSharedDiverged: 0,
    votesAlreadyMarked: 0,
    votesForMissingKey: 0,
  };
  const mapping: Plan['mapping'] = [];

  // Projected quota: existing usage plus what this plan adds.
  const userAdd = new Map<number, Usage>();
  const addUser = (uid: number, bytes: number) => {
    const u = userAdd.get(uid) ?? { bytes: 0, docs: 0 };
    u.bytes += bytes;
    u.docs += 1;
    userAdd.set(uid, u);
  };
  const appAdd: Usage = { bytes: 0, docs: 0 };

  // ---- private: kv → sweeps, per viewer --------------------------------------------------
  const existingPrivate = new Map(
    input.existingPrivate.map((d) => [`${d.scopeUid}\u0000${d.key}`, d])
  );
  const byTarget = new Map<string, KvRow[]>();
  for (const r of input.kv) {
    const key = mapKey(r.key);
    if (key !== r.key) {
      counts.mappedKeysKv++;
      mapping.push({ store: 'kv', legacyKey: r.key, key });
    }
    const t = `${r.userId}\u0000${key}`;
    byTarget.set(t, [...(byTarget.get(t) ?? []), r]);
  }
  const privateWrites: PrivateWrite[] = [];
  for (const [t, rows] of byTarget) {
    const [uidText, key] = t.split('\u0000');
    const userId = Number(uidText);
    const legacyKeys = new Set(rows.map((r) => r.key));
    if (legacyKeys.size > 1) {
      abort('mapped_key_collision_private', `${[...legacyKeys].join(' | ')} -> ${key}`);
      continue;
    }
    if (rows.length > 1) {
      abort('instance_key_collision', `${rows[0].key} in ${rows.length} instances`);
      continue;
    }
    const r = rows[0];
    const { data, wrapped } = toDocData(r.value);
    if (wrapped) counts.wrappedKv++;
    const existing = existingPrivate.get(t);
    if (existing) {
      if (
        existing.authorKind === 'user' &&
        existing.authorUid === userId &&
        jsonEqual(existing.data, data)
      ) {
        counts.alreadyCopiedPrivate++;
      } else {
        abort('key_taken_private', `${key}`);
      }
      continue;
    }
    const size = storedSize(r.sizeBytes, wrapped);
    if (size > DOC_BYTES_MAX) {
      abort('doc_too_large', `kv ${r.key} (${size} B)`);
      continue;
    }
    addUser(userId, size);
    privateWrites.push({ userId, key, legacyKey: r.key, data });
  }

  // ---- shared: shared_kv → picks, original author + hidden state -------------------------
  const authors = new Set<number>();
  const authorsKept = new Set<number>();
  const existingShared = new Map(input.existingShared.map((d) => [d.key, d]));
  const sharedByKey = new Map<string, SharedRow[]>();
  for (const r of input.shared) {
    const key = mapKey(r.key);
    if (key !== r.key) {
      counts.mappedKeysShared++;
      mapping.push({ store: 'shared_kv', legacyKey: r.key, key });
    }
    sharedByKey.set(key, [...(sharedByKey.get(key) ?? []), r]);
  }
  const votesByLegacyKey = new Map<string, number[]>();
  for (const v of input.votes)
    votesByLegacyKey.set(v.key, [...(votesByLegacyKey.get(v.key) ?? []), v.userId]);
  const legacySharedKeys = new Set(input.shared.map((r) => r.key));
  for (const v of input.votes) if (!legacySharedKeys.has(v.key)) counts.votesForMissingKey++;

  const sharedWrites: SharedWrite[] = [];
  const voteWrites: VoteWrite[] = [];
  const hideWrites: HideWrite[] = [];
  const ordered = [...sharedByKey.entries()].sort(
    (a, b) => a[1][0].createdAt.getTime() - b[1][0].createdAt.getTime() || (a[0] < b[0] ? -1 : 1)
  );
  for (const [key, rows] of ordered) {
    for (const r of rows) {
      if (keepsAuthor(r.authorUserId)) authors.add(r.authorUserId);
    }
    if (rows.length > 1) {
      abort('mapped_key_collision_shared', `${rows.map((r) => r.key).join(' | ')} -> ${key}`);
      continue;
    }
    const r = rows[0];
    if (!keepsAuthor(r.authorUserId)) {
      counts.sharedRowsAuthorNotKept++;
      abort('author_not_kept', `${r.key}: author ${JSON.stringify(r.authorUserId)}`);
      continue;
    }
    const authorUid = r.authorUserId;
    const { data, wrapped } = toDocData(r.value);
    if (wrapped) counts.wrappedShared++;
    if (r.hiddenAt && !keepsAuthor(r.hiddenBy)) {
      abort('hidden_without_moderator', r.key);
      continue;
    }
    const hideBy = r.hiddenAt ? (r.hiddenBy as number) : null;
    const voters = [...new Set(votesByLegacyKey.get(r.key) ?? [])].sort((a, b) => a - b);

    const existing = existingShared.get(key);
    if (existing) {
      if (existing.authorKind !== 'user' || existing.authorUid !== authorUid) {
        abort('key_taken_shared', `${key}: held by another author (${existing.authorKind})`);
        continue;
      }
      // Ours from an earlier run. Its body may since have been edited by its author: never
      // overwrite it. Finish what that run left: missing votes, then the hide.
      authorsKept.add(authorUid);
      counts.alreadyCopiedShared++;
      if (!jsonEqual(existing.data, data)) counts.alreadyCopiedSharedDiverged++;
      const missing = voters.filter((u) => {
        const has = input.existingVotes.has(`${key}\u0000${u}`);
        if (has) counts.votesAlreadyMarked++;
        return !has;
      });
      if (missing.length > 0 && existing.hidden) {
        abort('vote_on_hidden_unmarked', `${key}: ${missing.length} votes`);
        continue;
      }
      for (const u of missing) voteWrites.push({ key, userId: u });
      if (hideBy !== null && !existing.hidden) hideWrites.push({ key, moderatorUid: hideBy });
      continue;
    }
    const size = storedSize(r.sizeBytes, wrapped);
    if (size > DOC_BYTES_MAX) {
      abort('doc_too_large', `shared ${r.key} (${size} B)`);
      continue;
    }
    const bad = indexProblem(data, input.sharedIndexes);
    if (bad) {
      abort('index_type', `${r.key}: ${bad}`);
      continue;
    }
    authorsKept.add(authorUid);
    addUser(authorUid, size);
    appAdd.bytes += size;
    appAdd.docs += 1;
    sharedWrites.push({ key, legacyKey: r.key, authorUid, data, voters, hideBy });
  }
  counts.sharedAuthors = authors.size;
  counts.sharedAuthorsKept = authorsKept.size;

  // ---- quota: the store charges each write; one refused part-way leaves a partial copy -----
  for (const [uid, add] of userAdd) {
    const have = input.usageUser.get(uid) ?? { bytes: 0, docs: 0 };
    if (
      have.bytes + add.bytes > input.limits.userBytes ||
      have.docs + add.docs > input.limits.userDocs
    ) {
      abort('quota_user', `a user: +${add.docs} docs / +${add.bytes} B`);
    }
  }
  if (
    input.usageApp.bytes + appAdd.bytes > input.limits.appBytes ||
    input.usageApp.docs + appAdd.docs > input.limits.appDocs
  ) {
    abort('quota_app', `+${appAdd.docs} docs / +${appAdd.bytes} B`);
  }

  counts.privateWrites = privateWrites.length;
  counts.sharedWrites = sharedWrites.length;
  counts.voteMarksWithNewDocs = sharedWrites.reduce((n, w) => n + w.voters.length, 0);
  counts.voteMarksResumed = voteWrites.length;
  counts.hidesWithNewDocs = sharedWrites.filter((w) => w.hideBy !== null).length;
  counts.hidesResumed = hideWrites.length;

  return {
    privateWrites,
    sharedWrites,
    voteWrites,
    hideWrites,
    // One entry per legacy key: a per-viewer key held by many viewers maps the same way.
    mapping: [...new Map(mapping.map((m) => [`${m.store}\u0000${m.legacyKey}`, m])).values()].sort(
      (a, b) => (a.store + a.legacyKey < b.store + b.legacyKey ? -1 : 1)
    ),
    aborts: [...aborts.entries()].map(([reason, a]) => ({ reason, ...a })),
    counts,
  };
}

/** Writes the plan would make. Zero is what a re-run after a complete execute must show. */
export function pendingWrites(plan: Plan): number {
  return (
    plan.privateWrites.length +
    plan.sharedWrites.length +
    plan.voteWrites.length +
    plan.hideWrites.length
  );
}
