import { createHash } from 'crypto';
import { v4 as uuid } from 'uuid';
import { REDIS_SYS_KEYS, sysRedis, type RedisKeyTemplateSys } from '~/server/redis/client';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';
import {
  type DatasetExportRecord,
  datasetExportRecordSchema,
  type DeleteCandidateInput,
  type DeleteLabelInput,
  type ListCandidatesInput,
  type ListExportsInput,
  type ScannerPolicyCandidate,
  scannerPolicyCandidateSchema,
  type ScannerPolicyMode,
  type SetActiveInput,
  type SetSystemPromptInput,
  type UpsertCandidateInput,
} from '~/server/schema/scanner-policies.schema';

/**
 * Scanner-policies test bench — sysRedis-backed CRUD.
 *
 * Reads fail open (return empty / null + log) so a transient Redis flap doesn't
 * brick the moderator UI. Writes fail loud (throw) so a silent write-after-
 * failed-read can't wipe the registry, per the discipline documented in
 * src/server/services/system-cache.ts.
 */

const KEYS = REDIS_SYS_KEYS.SCANNER_POLICY;

// ----- helpers -----

const candidateField = (mode: ScannerPolicyMode, label: string, id: string) =>
  `${mode}:${label}:${id}`;

const idsField = (mode: ScannerPolicyMode, label: string) => `${mode}:${label}`;

function computePolicyHash(input: {
  mode: ScannerPolicyMode;
  label: string;
  threshold: number;
  policy: string;
}) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        mode: input.mode,
        label: input.label,
        threshold: input.threshold,
        policy: input.policy,
      })
    )
    .digest('hex');
}

function nowIso() {
  return new Date().toISOString();
}

// ----- reads (fail open) -----

/**
 * Returns the full label catalog grouped by mode. Derived from the keys of the
 * CANDIDATE_IDS hash — `${mode}:${label}` decomposes into per-mode label sets.
 */
export async function listLabels(): Promise<{
  prompt: { label: string; candidateCount: number }[];
  text: { label: string; candidateCount: number }[];
}> {
  try {
    const all = await sysRedis.packed.hGetAll<string[]>(KEYS.CANDIDATE_IDS);
    const out: { prompt: Record<string, number>; text: Record<string, number> } = {
      prompt: {},
      text: {},
    };
    for (const [field, ids] of Object.entries(all ?? {})) {
      const sepIdx = field.indexOf(':');
      if (sepIdx <= 0) continue;
      const mode = field.slice(0, sepIdx) as ScannerPolicyMode;
      const label = field.slice(sepIdx + 1);
      if (mode !== 'prompt' && mode !== 'text') continue;
      out[mode][label] = Array.isArray(ids) ? ids.length : 0;
    }
    return {
      prompt: Object.entries(out.prompt)
        .map(([label, candidateCount]) => ({ label, candidateCount }))
        .sort((a, b) => a.label.localeCompare(b.label)),
      text: Object.entries(out.text)
        .map(([label, candidateCount]) => ({ label, candidateCount }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    };
  } catch (err) {
    logSysRedisFailOpen('read-degraded', 'listLabels', err);
    return { prompt: [], text: [] };
  }
}

export async function listCandidates(
  input: ListCandidatesInput
): Promise<ScannerPolicyCandidate[]> {
  try {
    const { mode, label } = input;
    const ids =
      (await sysRedis.packed.hGet<string[]>(KEYS.CANDIDATE_IDS, idsField(mode, label))) ?? [];
    if (ids.length === 0) return [];
    const fields = ids.map((id) => candidateField(mode, label, id));
    const raw = await sysRedis.packed.hmGet<unknown>(KEYS.CANDIDATES, fields);
    const out: ScannerPolicyCandidate[] = [];
    for (let i = 0; i < raw.length; i++) {
      const r = raw[i];
      if (!r) continue;
      const parsed = scannerPolicyCandidateSchema.safeParse(r);
      if (parsed.success) out.push(parsed.data);
      else
        logSysRedisFailOpen('read-degraded', 'listCandidates parse', parsed.error, {
          mode,
          label,
          id: ids[i],
        });
    }
    return out;
  } catch (err) {
    logSysRedisFailOpen('read-degraded', 'listCandidates', err, {
      mode: input.mode,
      label: input.label,
    });
    return [];
  }
}

export async function getCandidate(input: {
  mode: ScannerPolicyMode;
  label: string;
  id: string;
}): Promise<ScannerPolicyCandidate | null> {
  try {
    const raw = await sysRedis.packed.hGet<unknown>(
      KEYS.CANDIDATES,
      candidateField(input.mode, input.label, input.id)
    );
    if (!raw) return null;
    const parsed = scannerPolicyCandidateSchema.safeParse(raw);
    if (!parsed.success) {
      logSysRedisFailOpen('read-degraded', 'getCandidate parse', parsed.error, input);
      return null;
    }
    return parsed.data;
  } catch (err) {
    logSysRedisFailOpen('read-degraded', 'getCandidate', err, input);
    return null;
  }
}

export async function getSystemPrompt(mode: ScannerPolicyMode): Promise<string | null> {
  try {
    const value = await sysRedis.packed.hGet<string>(KEYS.SYSTEM_PROMPTS, mode);
    return value ?? null;
  } catch (err) {
    logSysRedisFailOpen('read-degraded', 'getSystemPrompt', err, { mode });
    return null;
  }
}

export async function listExports(input: ListExportsInput): Promise<DatasetExportRecord[]> {
  try {
    const { mode, label } = input;
    const raw = await sysRedis.packed.hGet<unknown[]>(KEYS.EXPORTS, idsField(mode, label));
    if (!Array.isArray(raw)) return [];
    const records: DatasetExportRecord[] = [];
    for (const r of raw) {
      const parsed = datasetExportRecordSchema.safeParse(r);
      if (parsed.success) records.push(parsed.data);
    }
    return records;
  } catch (err) {
    logSysRedisFailOpen('read-degraded', 'listExports', err, {
      mode: input.mode,
      label: input.label,
    });
    return [];
  }
}

export async function getExportById(exportId: string): Promise<DatasetExportRecord | null> {
  try {
    // EXPORTS is keyed by (mode, label) → array of records. We have to scan;
    // the registry is small enough this is fine.
    const all = await sysRedis.packed.hGetAll<unknown[]>(KEYS.EXPORTS);
    for (const list of Object.values(all ?? {})) {
      if (!Array.isArray(list)) continue;
      for (const r of list) {
        const parsed = datasetExportRecordSchema.safeParse(r);
        if (parsed.success && parsed.data.id === exportId) return parsed.data;
      }
    }
    return null;
  } catch (err) {
    logSysRedisFailOpen('read-degraded', 'getExportById', err, { exportId });
    return null;
  }
}

// ----- writes (fail loud — DO NOT swallow errors) -----

/**
 * Create or update a candidate. Returns the persisted record (with server-set
 * id / policyHash / timestamps).
 *
 * No try/catch — see system-cache.ts comment block: a silent fail here followed
 * by a successful read elsewhere can lose data.
 */
export async function upsertCandidate(
  input: UpsertCandidateInput,
  userId: number
): Promise<ScannerPolicyCandidate> {
  const id = input.id ?? uuid();
  const isCreate = !input.id;
  const now = nowIso();

  // Preserve createdAt on update.
  let createdAt = now;
  if (!isCreate) {
    const existing = await getCandidate({ mode: input.mode, label: input.label, id });
    if (existing) createdAt = existing.createdAt;
  }

  const candidate: ScannerPolicyCandidate = scannerPolicyCandidateSchema.parse({
    id,
    name: input.name,
    mode: input.mode,
    label: input.label,
    threshold: input.threshold,
    archived: input.archived,
    active: input.active,
    policy: input.policy,
    notes: input.notes,
    createdBy: userId,
    createdAt,
    updatedAt: now,
    policyHash: computePolicyHash(input),
  });

  await sysRedis.packed.hSet(
    KEYS.CANDIDATES,
    candidateField(candidate.mode, candidate.label, candidate.id),
    candidate
  );

  if (isCreate) {
    // Append to the per-(mode,label) ID list.
    const existingIds =
      (await sysRedis.packed.hGet<string[]>(
        KEYS.CANDIDATE_IDS,
        idsField(candidate.mode, candidate.label)
      )) ?? [];
    if (!existingIds.includes(id)) {
      await sysRedis.packed.hSet(KEYS.CANDIDATE_IDS, idsField(candidate.mode, candidate.label), [
        ...existingIds,
        id,
      ]);
    }
  }

  return candidate;
}

export async function setCandidateActive(input: SetActiveInput): Promise<ScannerPolicyCandidate> {
  const current = await getCandidate(input);
  if (!current) {
    throw new Error(`Candidate ${input.mode}:${input.label}:${input.id} not found`);
  }
  const next: ScannerPolicyCandidate = {
    ...current,
    active: input.active,
    updatedAt: nowIso(),
  };
  await sysRedis.packed.hSet(
    KEYS.CANDIDATES,
    candidateField(input.mode, input.label, input.id),
    next
  );
  return next;
}

export async function deleteCandidate(input: DeleteCandidateInput): Promise<void> {
  await sysRedis.hDel(KEYS.CANDIDATES, candidateField(input.mode, input.label, input.id));
  const ids =
    (await sysRedis.packed.hGet<string[]>(KEYS.CANDIDATE_IDS, idsField(input.mode, input.label))) ??
    [];
  const next = ids.filter((x) => x !== input.id);
  if (next.length > 0) {
    await sysRedis.packed.hSet(KEYS.CANDIDATE_IDS, idsField(input.mode, input.label), next);
  } else {
    // Remove the empty entry so the label disappears from `listLabels`.
    await sysRedis.hDel(KEYS.CANDIDATE_IDS, idsField(input.mode, input.label));
  }
}

export async function deleteLabel(input: DeleteLabelInput): Promise<void> {
  const ids =
    (await sysRedis.packed.hGet<string[]>(KEYS.CANDIDATE_IDS, idsField(input.mode, input.label))) ??
    [];
  if (ids.length > 0) {
    throw new Error(
      `Cannot delete label ${input.mode}:${input.label} — it still has ${ids.length} candidate(s). Delete them first.`
    );
  }
  await sysRedis.hDel(KEYS.CANDIDATE_IDS, idsField(input.mode, input.label));
  // Also clear any stale export history under this label.
  await sysRedis.hDel(KEYS.EXPORTS, idsField(input.mode, input.label));
}

export async function setSystemPrompt(input: SetSystemPromptInput): Promise<void> {
  if (input.clear) {
    await sysRedis.hDel(KEYS.SYSTEM_PROMPTS, input.mode);
    return;
  }
  if (input.body === undefined) {
    throw new Error('setSystemPrompt requires either `body` or `clear: true`');
  }
  await sysRedis.packed.hSet(KEYS.SYSTEM_PROMPTS, input.mode, input.body);
}

/** Prepend a new export record to the (mode, label) bucket. Newest first. */
export async function recordExport(record: DatasetExportRecord): Promise<void> {
  datasetExportRecordSchema.parse(record);
  const existing =
    (await sysRedis.packed.hGet<DatasetExportRecord[]>(
      KEYS.EXPORTS,
      idsField(record.mode, record.label)
    )) ?? [];
  await sysRedis.packed.hSet(KEYS.EXPORTS, idsField(record.mode, record.label), [
    record,
    ...existing,
  ]);
}

/**
 * Remove an export record from sysRedis. Caller is responsible for deleting
 * the underlying S3 object first (see `deleteExport` in the dataset service).
 */
export async function removeExportRecord(exportId: string): Promise<DatasetExportRecord | null> {
  // We don't have (mode, label) up front — find the bucket the record lives in
  // and patch it. Total registry is small enough that hGetAll is cheap.
  const all = await sysRedis.packed.hGetAll<DatasetExportRecord[]>(KEYS.EXPORTS);
  for (const [field, list] of Object.entries(all ?? {})) {
    if (!Array.isArray(list)) continue;
    const removed = list.find((r) => r.id === exportId);
    if (!removed) continue;
    const next = list.filter((r) => r.id !== exportId);
    if (next.length > 0) {
      await sysRedis.packed.hSet(KEYS.EXPORTS, field, next);
    } else {
      await sysRedis.hDel(KEYS.EXPORTS, field);
    }
    return removed;
  }
  return null;
}

/**
 * Patch a single export record's lastRun fields in place. Caller has already
 * resolved the export's (mode, label) — we don't search the whole hash for it.
 */
export async function updateExportLastRun(args: {
  mode: ScannerPolicyMode;
  label: string;
  exportId: string;
  lastRunId: string;
  lastRunAt: string;
  lastRunBy: number;
  lastRunCandidateIds: string[];
}): Promise<void> {
  const list =
    (await sysRedis.packed.hGet<DatasetExportRecord[]>(
      KEYS.EXPORTS,
      idsField(args.mode, args.label)
    )) ?? [];
  const next = list.map((r) =>
    r.id === args.exportId
      ? {
          ...r,
          lastRunId: args.lastRunId,
          lastRunAt: args.lastRunAt,
          lastRunBy: args.lastRunBy,
          lastRunCandidateIds: args.lastRunCandidateIds,
        }
      : r
  );
  await sysRedis.packed.hSet(KEYS.EXPORTS, idsField(args.mode, args.label), next);
}

// ----- run-cancel flag -----

const runCancelKey = (runId: string) =>
  `${KEYS.RUN_CANCEL}:${runId}` as `${typeof KEYS.RUN_CANCEL}:${string}`;

export async function markRunCancelled(runId: string): Promise<void> {
  await sysRedis.set(runCancelKey(runId), '1', { EX: 60 * 60 });
}

export async function isRunCancelled(runId: string): Promise<boolean> {
  try {
    // sysRedis.get is typed string but the HA/Sentinel client returns a Buffer
    // for BLOB_STRING replies. `Buffer === '1'` is always false, so cancellation
    // would silently never be detected in sentinel mode. Coerce to utf8 first.
    // See PR #2697/#2700 for the canonical Buffer-vs-string regression.
    const raw = await sysRedis.get(runCancelKey(runId));
    const v = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
    return v === '1';
  } catch (err) {
    logSysRedisFailOpen('read-degraded', 'isRunCancelled', err, { runId });
    return false;
  }
}

export async function clearRunCancelled(runId: string): Promise<void> {
  await sysRedis.del(runCancelKey(runId));
}

// ----- run-state (callback-driven scoring) -----

const runStateKey = (runId: string) =>
  `${REDIS_SYS_KEYS.SCANNER_POLICY.RUN_STATE}:${runId}` as RedisKeyTemplateSys;
const runResultsKey = (runId: string) =>
  `${REDIS_SYS_KEYS.SCANNER_POLICY.RUN_RESULTS}:${runId}` as RedisKeyTemplateSys;
const runCounterKey = (runId: string) =>
  `${REDIS_SYS_KEYS.SCANNER_POLICY.RUN_COUNTER}:${runId}` as RedisKeyTemplateSys;

const RUN_TTL_SECONDS = 24 * 60 * 60;

/**
 * Run-state blob written when a scoring run starts. Holds everything the
 * callback webhook needs to (a) compute one row's result and (b) finalize
 * the run when the counter reaches `total`.
 *
 * `rows` is kept here so the webhook doesn't re-fetch the workbook from S3
 * per callback (would be 2500 GetObject calls for a 500-row × 5-candidate
 * run). Roughly ~500KB packed for a typical run — well within sysRedis hash
 * value limits.
 */
export type ScannerPolicyRunState = {
  runId: string;
  userId: number;
  datasetId: string;
  datasetS3Key: string;
  mode: ScannerPolicyMode;
  label: string;
  total: number;
  baselineCandidateId: string | null;
  systemPromptOverride: string | null;
  startedAt: string;
  /** Snapshotted candidates — webhook uses these instead of re-reading sysRedis. */
  candidates: Array<{
    id: string;
    name: string;
    mode: ScannerPolicyMode;
    label: string;
    threshold: number;
    policyHash: string;
    policy: string;
  }>;
  /** Snapshotted rows in submission order. rowIdx is the index into this array. */
  rows: Array<{
    contentHash: string;
    expectedTrigger: boolean;
    positivePrompt: string;
    negativePrompt?: string;
  }>;
};

export async function setRunState(state: ScannerPolicyRunState): Promise<void> {
  await sysRedis.packed.set(runStateKey(state.runId), state, { EX: RUN_TTL_SECONDS });
  await sysRedis.set(runCounterKey(state.runId), '0', { EX: RUN_TTL_SECONDS });
}

export async function getRunState(runId: string): Promise<ScannerPolicyRunState | null> {
  try {
    return await sysRedis.packed.get<ScannerPolicyRunState>(runStateKey(runId));
  } catch (err) {
    logSysRedisFailOpen('read-degraded', 'getRunState', err, { runId });
    return null;
  }
}

export async function deleteRunState(runId: string): Promise<void> {
  await sysRedis.del([runStateKey(runId), runResultsKey(runId), runCounterKey(runId)]);
}

/** Store a single (rowIdx, candidateId) result in the run's results hash. */
export async function recordRunResult(
  runId: string,
  rowIdx: number,
  candidateId: string,
  result: unknown
): Promise<void> {
  await sysRedis.packed.hSet(runResultsKey(runId), `${rowIdx}:${candidateId}`, result);
  // hSet doesn't accept TTL; refresh the hash TTL so partial-run state doesn't
  // expire mid-run when the run takes longer than its initial setRunState TTL.
  await sysRedis.expire(runResultsKey(runId), RUN_TTL_SECONDS);
}

/** Atomically increment the run's completed-result counter and return the new value. */
export async function incrementRunCounter(runId: string): Promise<number> {
  const next = await sysRedis.incrBy(runCounterKey(runId), 1);
  await sysRedis.expire(runCounterKey(runId), RUN_TTL_SECONDS);
  return next;
}

export async function readAllRunResults<T = unknown>(runId: string): Promise<Record<string, T>> {
  try {
    return await sysRedis.packed.hGetAll<T>(runResultsKey(runId));
  } catch (err) {
    logSysRedisFailOpen('read-degraded', 'readAllRunResults', err, { runId });
    return {};
  }
}
