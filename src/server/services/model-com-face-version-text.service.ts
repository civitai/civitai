import { Prisma } from '@prisma/client';
import { NsfwLevel } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { TextScanEachVerdict } from '~/server/services/text-scan/preview';
import { previewTextScanEach } from '~/server/services/text-scan/preview';
import { getActiveTextScanPrompts, getTextScanConfig } from '~/server/services/text-scan/prompt';
import { applyCsamHold } from '~/server/services/text-scan/actions/csam-hold';
import { loadModelScanSubjects } from '~/server/services/text-scan/profiles/model.profile';
import { textScanTextHash } from '~/server/services/text-scan/prompt';
import { scanEntityInBackground } from '~/server/services/text-scan/submit';
import type { TextScanField, TextScanLabel } from '~/server/services/text-scan/types';
import { nsfwLevelFromName } from '~/server/services/text-scan/types';
import { backoffDelay } from '~/utils/backoff';
import { Availability, ModelStatus } from '~/shared/utils/prisma/enums';

/**
 * Every KeyValue row this module owns starts with this: `v:<versionId>` holds a version's verdicts,
 * `m:<modelId>` a model waiting to be rated.
 */
export const COM_FACE_VERSION_TEXT_KEY_PREFIX = 'com-face-version-text:';
const VERDICT_PREFIX = `${COM_FACE_VERSION_TEXT_KEY_PREFIX}v:`;
const QUEUE_PREFIX = `${COM_FACE_VERSION_TEXT_KEY_PREFIX}m:`;
export const comVersionTextVerdictKey = (versionId: number) => `${VERDICT_PREFIX}${versionId}`;
export const comVersionTextQueueKey = (modelId: number) => `${QUEUE_PREFIX}${modelId}`;

/**
 * The .com verdicts on one version's name and trigger words, each rated on its own. `name` and
 * `words` are the text that was rated; `policy` the prompts and model that rated it. Only `shown`
 * strings may show on .com. `hidden` (rated above PG-13, refused, or too long to rate) and `held`
 * (a minor, poi or csam detection) have verdicts too; a string in no list is unrated.
 */
export type ComVersionTextVerdicts = {
  name: string;
  words: string[];
  shown: string[];
  hidden: string[];
  held: string[];
  pending: boolean;
  policy: string;
  at: string;
};

type QueueEntry = {
  editAt: string;
  source: 'edit' | 'sweep';
  attempt?: number;
  nextAt?: string;
};

export const COM_VERSION_TEXT_LABELS: TextScanLabel[] = ['nsfw', 'minor', 'poi', 'csam'];
export const COM_VERSION_TEXT_STEPS_PER_WORKFLOW = 20;
export const COM_VERSION_TEXT_WORKFLOWS_PER_RUN = 20;
/** So one model with many strings cannot take a whole run from the others. */
export const COM_VERSION_TEXT_WORKFLOWS_PER_MODEL_RUN = 5;
/** One rating per burst of edits: a model is rated once its owner has stopped editing this long. */
export const COM_VERSION_TEXT_QUIET_MS = 2 * 60_000;
export const COM_VERSION_TEXT_RUN_BUDGET_MS = 4 * 60_000;
export const COM_VERSION_TEXT_SWEEP_LIMIT = 500;
const RETRY_FIRST_DELAY_MS = 60_000;
const RETRY_MAX_DELAY_MS = 60 * 60_000;
/** Past this a model leaves the queue; the hourly sweep queues it again behind owner edits. */
export const COM_VERSION_TEXT_MAX_ATTEMPTS = 8;
const WAIT_SECONDS = 10;

/** Changes when the prompts or model that rate version text change, which makes old verdicts stale. */
export async function getComVersionTextPolicy() {
  const [config, prompts] = await Promise.all([getTextScanConfig(), getActiveTextScanPrompts()]);
  const ids = ['base', ...COM_VERSION_TEXT_LABELS.map((label) => `label:${label}`)].map(
    (key) => `${key}=${prompts[key]?.id ?? 'missing'}`
  );
  return [config.model, `thinking=${config.thinking}`, ...ids].join('|');
}

function log(type: 'info' | 'error', message: string, extra: Record<string, unknown> = {}) {
  logToAxiom({ type, name: 'com-face-version-text', message, ...extra }).catch(() => undefined);
}

/**
 * Queues the model's version text for rating after an owner edit. A model already waiting has its
 * quiet period and backoff restarted. Call after the write commits; it never throws.
 */
export async function queueComFaceVersionText(modelId: number) {
  const entry: QueueEntry = { editAt: new Date().toISOString(), source: 'edit' };
  try {
    await dbWrite.$executeRaw(
      Prisma.sql`
        INSERT INTO "KeyValue" (key, value)
        VALUES (${comVersionTextQueueKey(modelId)}, ${JSON.stringify(entry)}::jsonb)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
      `
    );
  } catch (error) {
    log('error', 'enqueue failed', { modelId, ...errorFields(error) });
  }
}

type Reader = Pick<typeof dbWrite, 'model' | 'modelVersion' | 'keyValue'>;

/** Versions .com can show: published and not private. */
async function readComVersions(modelId: number, db: Reader) {
  const model = await db.model.findUnique({
    where: { id: modelId },
    select: { sfwName: true, deletedAt: true },
  });
  if (!model || model.deletedAt || model.sfwName == null) return [];
  const versions = await db.modelVersion.findMany({
    where: {
      modelId,
      status: ModelStatus.Published,
      availability: { not: Availability.Private },
    },
    select: { id: true, name: true, trainedWords: true },
  });
  return versions.map((version) => ({ ...version, trainedWords: version.trainedWords ?? [] }));
}

export async function readComVersionTextVerdicts(versionIds: number[], db: Reader = dbWrite) {
  if (!versionIds.length) return new Map<number, ComVersionTextVerdicts>();
  const rows = await db.keyValue.findMany({
    where: { key: { in: versionIds.map(comVersionTextVerdictKey) } },
  });
  return new Map(
    rows.map((row) => [
      Number(row.key.slice(VERDICT_PREFIX.length)),
      row.value as ComVersionTextVerdicts,
    ])
  );
}

const versionStrings = (version: { name: string; trainedWords: string[] }) =>
  [...new Set([version.name, ...version.trainedWords])].filter((text) => text.trim());

type Verdict = 'shown' | 'hidden' | 'held';

function verdictOf(result: TextScanEachVerdict): Verdict | null {
  if (result.status === 'refused' || result.status === 'too-long') return 'hidden';
  if (result.status !== 'ok' && result.status !== 'partial') return null;
  const { nsfw, minor, poi, csam } = result.output;
  if (minor?.detected || poi?.detected || csam?.detected) return 'held';
  if (!nsfw || !minor || !poi || !csam) return null;
  return nsfwLevelFromName[nsfw.level] <= NsfwLevel.PG13 ? 'shown' : 'hidden';
}

/** Where a string sits in the model's versions, so a hold can name it without its text. */
const positionsOf = (
  versions: { id: number; name: string; trainedWords: string[] }[],
  text: string
) =>
  versions.flatMap((version) => [
    ...(version.name === text ? [{ versionId: version.id, field: 'name' }] : []),
    ...version.trainedWords.flatMap((word, index) =>
      word === text ? [{ versionId: version.id, field: 'trainedWords', index }] : []
    ),
  ]);

type CsamHit = { text: string; reason: string; workflowId: string };

/**
 * The hold a positive csam Model scan writes, written here directly so it does not depend on the
 * Model scan's own mode or rollout. The held text is the model's whole scan subject.
 */
async function holdCsamHits(
  modelId: number,
  versions: { id: number; name: string; trainedWords: string[] }[],
  hits: CsamHit[]
) {
  const subject = (await loadModelScanSubjects([modelId], { publicVersionsOnly: true })).get(
    modelId
  );
  if (!subject) throw new Error('csam hit on a model with no scan subject');
  const prompts = await getActiveTextScanPrompts();
  const csamPromptId = prompts['label:csam']?.id;
  await applyCsamHold({
    entityType: 'Model',
    entityId: modelId,
    workflowId: hits[0].workflowId,
    outcome: {
      csam: { detected: true, reason: hits[0].reason },
      triggeredLabels: ['csam'],
      nsfwLevel: null,
    },
    subject: {
      ...subject,
      meta: {
        ...subject.meta,
        comVersionTextHits: hits.flatMap((hit) => positionsOf(versions, hit.text)),
      },
    },
    textHash: textScanTextHash(subject),
    ...(csamPromptId !== undefined && { promptIds: { csam: csamPromptId } }),
  });
}

/**
 * Writes the verdicts only while the version's name and trigger words are still the ones rated;
 * a later edit queued its own rating.
 */
export const comVersionTextVerdictSql = (versionId: number, verdicts: ComVersionTextVerdicts) =>
  Prisma.sql`
    INSERT INTO "KeyValue" (key, value)
    SELECT ${comVersionTextVerdictKey(versionId)}, ${JSON.stringify(verdicts)}::jsonb
    WHERE EXISTS (
      SELECT 1 FROM "ModelVersion"
      WHERE id = ${versionId}
        AND name = ${verdicts.name}
        AND COALESCE("trainedWords", '{}'::text[]) = ${verdicts.words}::text[]
    )
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `;

export type RateResult = {
  status: 'complete' | 'partial' | 'unrated';
  workflows: number;
  /** Strings with a csam detection in this run. */
  csamHits: number;
};

/**
 * Rates each name and trigger word of the model's .com-visible versions that has no verdict yet,
 * one step per string, at most `maxWorkflows` workflows. `partial`: the budget ran out first;
 * `unrated`: some string got no verdict. A csam detection is held before any verdict is written,
 * so a failed hold leaves the strings unrated for the retry. `dryRun` rates and writes nothing.
 */
export async function rateComFaceVersionText(
  modelId: number,
  maxWorkflows = COM_VERSION_TEXT_WORKFLOWS_PER_RUN,
  { dryRun = false }: { dryRun?: boolean } = {}
): Promise<RateResult> {
  // A dry run writes nothing, so it reads the replica; a real run reads the edit just committed.
  const db = dryRun ? dbRead : dbWrite;
  const versions = await readComVersions(modelId, db);
  if (!versions.length) return { status: 'complete', workflows: 0, csamHits: 0 };
  const [stored, policy] = await Promise.all([
    readComVersionTextVerdicts(
      versions.map((version) => version.id),
      db
    ),
    getComVersionTextPolicy(),
  ]);

  const known = new Map<string, Verdict>();
  for (const row of stored.values()) {
    if (row.policy !== policy) continue;
    for (const text of row.shown ?? []) known.set(text, 'shown');
    for (const text of row.hidden ?? []) known.set(text, 'hidden');
    for (const text of row.held ?? []) known.set(text, 'held');
  }

  const unrated = new Map<string, TextScanField>();
  for (const version of versions) {
    if (!known.has(version.name) && version.name.trim())
      unrated.set(version.name, { heading: 'Version name', text: version.name });
    for (const word of version.trainedWords)
      if (!known.has(word) && !unrated.has(word) && word.trim())
        unrated.set(word, { heading: 'Trained word', text: word });
  }

  const pending = [...unrated.values()];
  let workflows = 0;
  let rated = 0;
  const csamHits: CsamHit[] = [];
  while (pending.length && workflows < maxWorkflows) {
    const chunk = pending.splice(0, COM_VERSION_TEXT_STEPS_PER_WORKFLOW);
    workflows++;
    const { workflowId, verdicts: results } = await previewTextScanEach({
      labels: COM_VERSION_TEXT_LABELS,
      fields: chunk,
      waitSeconds: WAIT_SECONDS,
    }).catch((error) => {
      log('error', 'rating failed', { modelId, ...errorFields(error) });
      return {
        workflowId: null,
        verdicts: chunk.map((): TextScanEachVerdict => ({ status: 'unavailable' })),
      };
    });
    results.forEach((result, i) => {
      const verdict = verdictOf(result);
      if (result.status === 'ok' || result.status === 'partial') {
        const { csam } = result.output;
        if (csam?.detected)
          csamHits.push({
            text: chunk[i].text as string,
            reason: csam.reason,
            workflowId: workflowId ?? '',
          });
        for (const label of ['minor', 'poi'] as const)
          if (result.output[label]?.detected)
            log('info', 'version text detection', { modelId, label });
      }
      if (verdict) {
        known.set(chunk[i].text as string, verdict);
        rated++;
      }
    });
  }

  if (dryRun)
    return {
      status: pending.length ? 'partial' : 'complete',
      workflows,
      csamHits: csamHits.length,
    };

  if (csamHits.length) {
    log('info', 'csam hit', { modelId });
    await holdCsamHits(modelId, versions, csamHits);
    scanEntityInBackground({ entityType: 'Model', entityId: modelId, force: true });
  }

  let anyUnrated = false;
  for (const version of versions) {
    const strings = versionStrings(version);
    const pick = (verdict: Verdict) => strings.filter((text) => known.get(text) === verdict);
    const next: ComVersionTextVerdicts = {
      name: version.name,
      words: version.trainedWords,
      shown: pick('shown'),
      hidden: pick('hidden'),
      held: pick('held'),
      pending: strings.some((text) => !known.has(text)),
      policy,
      at: new Date().toISOString(),
    };
    if (next.pending) anyUnrated = true;
    if (sameVerdicts(stored.get(version.id), next)) continue;
    await dbWrite.$executeRaw(comVersionTextVerdictSql(version.id, next));
  }

  // A run that rated nothing backs off rather than coming straight back.
  if (pending.length && rated) return { status: 'partial', workflows, csamHits: csamHits.length };
  return { status: anyUnrated ? 'unrated' : 'complete', workflows, csamHits: csamHits.length };
}

function sameVerdicts(a: ComVersionTextVerdicts | undefined, b: ComVersionTextVerdicts) {
  if (!a) return false;
  const same = (x: string[] | undefined, y: string[]) =>
    (x ?? []).length === y.length && y.every((text, i) => x?.[i] === text);
  return (
    a.name === b.name &&
    a.pending === b.pending &&
    a.policy === b.policy &&
    same(a.words, b.words) &&
    same(a.shown, b.shown) &&
    same(a.hidden, b.hidden) &&
    same(a.held, b.held)
  );
}

const retryDelay = (attempt: number) =>
  backoffDelay(attempt - 1, { baseMs: RETRY_FIRST_DELAY_MS, maxMs: RETRY_MAX_DELAY_MS });

/**
 * Rates the queued models whose edits have gone quiet: owner edits first, then sweep rows, at most
 * {@link COM_VERSION_TEXT_WORKFLOWS_PER_RUN} workflows per run. A model rated in full leaves the
 * queue; one with strings still unrated waits for a backed-off retry; one cut off by the budget is
 * due again next run.
 */
export async function processComFaceVersionText(
  now = new Date(),
  budgetMs = COM_VERSION_TEXT_RUN_BUDGET_MS
) {
  const startedAt = Date.now();
  const counts = { complete: 0, partial: 0, unrated: 0, failed: 0, workflows: 0 };
  const rows = await dbWrite.keyValue.findMany({ where: { key: { startsWith: QUEUE_PREFIX } } });

  const due = rows
    .map((row) => ({
      row,
      modelId: Number(row.key.slice(QUEUE_PREFIX.length)),
      entry: (row.value ?? {}) as Partial<QueueEntry>,
    }))
    .filter(({ row, modelId, entry }) => {
      if (!Number.isInteger(modelId) || comVersionTextQueueKey(modelId) !== row.key) return false;
      const editAt = Date.parse(entry.editAt ?? '');
      if (now.getTime() - (Number.isFinite(editAt) ? editAt : 0) < COM_VERSION_TEXT_QUIET_MS)
        return false;
      return !(Date.parse(entry.nextAt ?? '') > now.getTime());
    })
    .sort(
      (a, b) =>
        Number(a.entry.source === 'sweep') - Number(b.entry.source === 'sweep') ||
        (Date.parse(a.entry.editAt ?? '') || 0) - (Date.parse(b.entry.editAt ?? '') || 0)
    );

  for (const { row, modelId, entry } of due) {
    const left = COM_VERSION_TEXT_WORKFLOWS_PER_RUN - counts.workflows;
    if (left <= 0 || Date.now() - startedAt > budgetMs) break;
    const result = await rateComFaceVersionText(
      modelId,
      Math.min(left, COM_VERSION_TEXT_WORKFLOWS_PER_MODEL_RUN)
    ).catch((error) => {
      log('error', 'rating threw', { modelId, ...errorFields(error) });
      return { status: 'failed' as const, workflows: 0, csamHits: 0 };
    });
    counts[result.status]++;
    counts.workflows += result.workflows;

    // Only while the row is the one read: an edit since then restarted it.
    const unchanged = Prisma.sql`key = ${row.key} AND value = ${JSON.stringify(row.value)}::jsonb`;
    if (result.status === 'complete') {
      await dbWrite
        .$executeRaw(Prisma.sql`DELETE FROM "KeyValue" WHERE ${unchanged}`)
        .catch((error) => log('error', 'queue delete failed', { modelId, ...errorFields(error) }));
      continue;
    }
    if (result.status === 'partial') continue;
    const attempt = (entry.attempt ?? 0) + 1;
    if (attempt > COM_VERSION_TEXT_MAX_ATTEMPTS) {
      log('error', 'left the queue without verdicts', { modelId, attempts: attempt - 1 });
      await dbWrite
        .$executeRaw(Prisma.sql`DELETE FROM "KeyValue" WHERE ${unchanged}`)
        .catch((error) => log('error', 'queue delete failed', { modelId, ...errorFields(error) }));
      continue;
    }
    const next: QueueEntry = {
      editAt: entry.editAt ?? new Date(0).toISOString(),
      source: entry.source ?? 'sweep',
      attempt,
      nextAt: new Date(
        now.getTime() + (Date.now() - startedAt) + retryDelay(attempt)
      ).toISOString(),
    };
    await dbWrite
      .$executeRaw(
        Prisma.sql`UPDATE "KeyValue" SET value = ${JSON.stringify(next)}::jsonb WHERE ${unchanged}`
      )
      .catch((error) => log('error', 'queue retry failed', { modelId, ...errorFields(error) }));
  }
  return counts;
}

/**
 * Faced models with a .com-visible version whose verdicts are missing, still pending, or were
 * rated on text the version no longer has or under another policy, and that are not already queued.
 */
export const comVersionTextSweepSql = (limit: number, policy: string) => Prisma.sql`
  SELECT DISTINCT mv."modelId" AS "modelId"
  FROM "ModelVersion" mv
  JOIN "Model" m ON m.id = mv."modelId"
  LEFT JOIN "KeyValue" kv ON kv.key = ${VERDICT_PREFIX} || mv.id::text
  WHERE m."sfwName" IS NOT NULL
    AND m."deletedAt" IS NULL
    AND mv.status = 'Published'
    AND mv.availability <> 'Private'
    AND (
      kv.key IS NULL
      OR kv.value->>'pending' = 'true'
      OR kv.value->>'policy' IS DISTINCT FROM ${policy}
      OR kv.value->>'name' IS DISTINCT FROM mv.name
      OR kv.value->'words' IS DISTINCT FROM to_jsonb(COALESCE(mv."trainedWords", '{}'::text[]))
    )
    AND NOT EXISTS (
      SELECT 1 FROM "KeyValue" q WHERE q.key = ${QUEUE_PREFIX} || mv."modelId"::text
    )
  ORDER BY mv."modelId"
  LIMIT ${limit}
`;

/** Queues every model {@link comVersionTextSweepSql} finds, up to `limit`. Returns the ids queued. */
export async function sweepComFaceVersionText(limit = COM_VERSION_TEXT_SWEEP_LIMIT) {
  // The replica: a lagging read only re-queues a model already queued or rated, which costs nothing.
  const found = await dbRead.$queryRaw<{ modelId: number }[]>(
    comVersionTextSweepSql(limit, await getComVersionTextPolicy())
  );
  const modelIds = found.map((row) => row.modelId);
  const entry = JSON.stringify({ editAt: new Date(0).toISOString(), source: 'sweep' });
  for (const modelId of modelIds)
    await dbWrite.$executeRaw(
      Prisma.sql`
        INSERT INTO "KeyValue" (key, value)
        VALUES (${comVersionTextQueueKey(modelId)}, ${entry}::jsonb)
        ON CONFLICT (key) DO NOTHING
      `
    );
  log('info', 'sweep queued', { count: modelIds.length });
  return modelIds;
}

/** Name and code only: a database error message can echo its arguments, which can be held text. */
function errorFields(error: unknown) {
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    errorCode: (error as { code?: unknown } | null | undefined)?.code,
  };
}
