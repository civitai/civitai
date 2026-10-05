/**
 * One-off backfill: stamp TrainingStudioMeta onto old-trainer orchestrator workflows.
 *
 * Old-trainer runs live on the orchestrator with no Training Studio metadata, so the studio
 * renders them degraded ("Untitled training", base guessed from the step). The main app DB knows
 * their real names: a ModelVersion (uploadType 'Trained') + its 'Training Data' ModelFile whose
 * metadata.trainingResults (V2) carries the orchestrator workflowId. This script reads those
 * rows, then read-merge-writes each workflow's metadata (the orchestrator REPLACES metadata
 * wholesale) adding only the TrainingStudioMeta fields that are missing — a workflow that
 * already has a `name` is skipped entirely. It also adds the `name:<slug>` workflow tag the
 * studio's rename/search uses.
 *
 * Only workflows submitted in the last 30 days are considered (orchestrator retention — older
 * ones are gone). V1 trainingResults carry no workflowId and are skipped by construction.
 *
 * Usage:
 *   npm run tsscript scripts/backfill-training-studio-meta.ts                # dry-run (default)
 *   npm run tsscript scripts/backfill-training-studio-meta.ts --user 12345   # one user, dry-run
 *   npm run tsscript scripts/backfill-training-studio-meta.ts --execute      # write for real
 *
 * Options:
 *   --dry-run        Default. Print the per-user / per-workflow plan, write nothing.
 *   --execute        Apply the metadata/tag updates to the orchestrator.
 *   --user <id>      Scope to one user (pilot a single account first).
 *   --concurrency=N  Parallel workflow updates per user (default 4, max 4).
 *
 * Requires the app's .env (dotenv-loaded via ~/env/server under NODE_ENV=development):
 * DATABASE_URL, ORCHESTRATOR_ENDPOINT/MODE, and the redis + ApiKey machinery behind
 * getOrchestratorToken.
 */
import { getWorkflow, updateWorkflow } from '@civitai/client';
import { dbRead } from '~/server/db/client';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import { createOrchestratorClient } from '~/server/services/orchestrator/client';
import { limitConcurrency, type Task } from '~/server/utils/concurrency-helpers';
// Import-free vendored catalog — safe to reach into the studio app for the card/version mapping.
import { MODEL_CARDS } from '../apps/training-studio/src/lib/data/trainingModels';

const args = process.argv.slice(2);
const execute = args.includes('--execute');
const userArgIdx = args.indexOf('--user');
const onlyUserId = userArgIdx >= 0 ? parseInt(args[userArgIdx + 1] ?? '', 10) : null;
const concArg = args.find((a) => a.startsWith('--concurrency='));
const CONCURRENCY = Math.min(4, concArg ? parseInt(concArg.split('=')[1], 10) || 4 : 4);

if (userArgIdx >= 0 && (onlyUserId === null || Number.isNaN(onlyUserId))) {
  console.error('--user requires a numeric user id');
  process.exit(1);
}

// Mirrors apps/training-studio/src/lib/data/trainingRows.ts META_VERSION and
// train-core.ts's NAME_TAG_PREFIX + nameSlug (that module imports through $lib
// aliases, so the shape is restated here).
const META_VERSION = 1;
const NAME_TAG_PREFIX = 'name:';
function nameSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// trainingModelInfo key (= studio version key, e.g. `flux_dev`) → studio card/version ids.
const versionKeyToCard = new Map<string, { cardType: string; versionKey: string }>();
for (const card of MODEL_CARDS)
  for (const version of card.versions)
    versionKeyToCard.set(version.key, { cardType: card.type, versionKey: version.key });

const LORA_TYPES = new Set(['character', 'style', 'concept', 'effect']);
const MEDIA_TYPES = new Set(['image', 'video', 'audio']);

interface CandidateRow {
  userId: number;
  modelName: string;
  versionName: string;
  trainedWords: string[] | null;
  trainingDetails: {
    baseModel?: string;
    type?: string;
    mediaType?: string;
  } | null;
  workflowId: string;
  numImages: number | null;
}

type PlannedMeta = Record<string, unknown>;

function buildMeta(row: CandidateRow): PlannedMeta {
  const details = row.trainingDetails ?? {};
  const name =
    row.versionName && row.versionName.toLowerCase() !== row.modelName.toLowerCase()
      ? `${row.modelName} · ${row.versionName}`
      : row.modelName;
  const loraType = details.type?.toLowerCase();
  const mapped = details.baseModel ? versionKeyToCard.get(details.baseModel) : undefined;
  const trigger = row.trainedWords?.[0]?.trim();

  const meta: PlannedMeta = { v: META_VERSION, name: name.trim() };
  if (details.mediaType && MEDIA_TYPES.has(details.mediaType)) meta.media = details.mediaType;
  if (loraType && LORA_TYPES.has(loraType)) meta.loraType = loraType;
  // A baseModel outside the catalog is a custom AIR — leave cardType/versionKey unset and let
  // the studio resolve the base from the workflow step's ecosystem.
  if (mapped) {
    meta.cardType = mapped.cardType;
    meta.versionKey = mapped.versionKey;
  }
  if (typeof row.numImages === 'number' && row.numImages > 0) meta.imageCount = row.numImages;
  if (trigger) meta.trigger = trigger;
  return meta;
}

const counts = {
  candidates: 0,
  users: 0,
  planned: 0,
  updated: 0,
  alreadyNamed: 0,
  notFound: 0,
  errors: 0,
};

async function processUser(userId: number, rows: CandidateRow[]) {
  console.log(`\nuser ${userId} — ${rows.length} workflow(s)`);
  // Cross-user mint (the script acts for many users) — same bypass the moderator path uses.
  const token = await getOrchestratorToken(userId, undefined, { bypassCache: true });
  const client = createOrchestratorClient(token);

  const tasks: Task[] = rows.map((row) => async () => {
    try {
      const { data: workflow, response } = await getWorkflow({
        client,
        path: { workflowId: row.workflowId },
      });
      if (!workflow) {
        counts.notFound += 1;
        console.log(
          `  ${row.workflowId}  MISSING (${response?.status ?? 'no response'}) — skipped`
        );
        return;
      }

      const existing = (workflow.metadata ?? {}) as PlannedMeta;
      if (existing.name) {
        counts.alreadyNamed += 1;
        console.log(`  ${row.workflowId}  already named ("${String(existing.name)}") — skipped`);
        return;
      }

      const candidate = buildMeta(row);
      const additions = Object.fromEntries(
        Object.entries(candidate).filter(([key]) => existing[key] === undefined)
      );
      const metadata = { ...existing, ...additions };

      const tags = workflow.tags ?? [];
      const slug = nameSlug(String(additions.name ?? ''));
      const needsNameTag = !!slug && !tags.some((t) => t.startsWith(NAME_TAG_PREFIX));
      const nextTags = needsNameTag ? [...tags, `${NAME_TAG_PREFIX}${slug}`] : tags;

      counts.planned += 1;
      console.log(
        `  ${row.workflowId}  +{${Object.keys(additions).join(', ')}}` +
          (needsNameTag ? `  +tag ${NAME_TAG_PREFIX}${slug}` : '') +
          `  → "${String(candidate.name)}"`
      );
      if (!execute) return;

      const { error } = await updateWorkflow({
        client,
        path: { workflowId: row.workflowId },
        body: { metadata, tags: nextTags },
      });
      if (error) throw new Error(`updateWorkflow failed: ${JSON.stringify(error)}`);
      counts.updated += 1;
    } catch (err) {
      counts.errors += 1;
      console.error(`  ${row.workflowId}  ERROR: ${err instanceof Error ? err.message : err}`);
    }
  });

  await limitConcurrency(tasks, CONCURRENCY);
}

async function main() {
  console.log(
    `[backfill-training-studio-meta] mode=${execute ? 'EXECUTE' : 'dry-run'}` +
      `${onlyUserId ? ` user=${onlyUserId}` : ''} concurrency=${CONCURRENCY}`
  );

  // String comparison against an ISO cutoff (both sides toISOString-shaped) — avoids a
  // ::timestamptz cast that would abort the whole query on one malformed row.
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const rows = await dbRead.$queryRawUnsafe<CandidateRow[]>(
    `SELECT
       m."userId",
       m.name AS "modelName",
       mv.name AS "versionName",
       mv."trainedWords",
       mv."trainingDetails",
       mf.metadata->'trainingResults'->>'workflowId' AS "workflowId",
       (mf.metadata->>'numImages')::int AS "numImages"
     FROM "ModelVersion" mv
     JOIN "Model" m ON m.id = mv."modelId"
     JOIN "ModelFile" mf ON mf."modelVersionId" = mv.id AND mf.type = 'Training Data'
     WHERE mv."uploadType" = 'Trained'
       AND mf.metadata->'trainingResults'->>'workflowId' IS NOT NULL
       AND mf.metadata->'trainingResults'->>'submittedAt' >= $1
       ${onlyUserId ? 'AND m."userId" = $2' : ''}
     ORDER BY m."userId"`,
    ...(onlyUserId ? [cutoff, onlyUserId] : [cutoff])
  );

  counts.candidates = rows.length;
  const byUser = new Map<number, CandidateRow[]>();
  for (const row of rows) {
    if (!byUser.has(row.userId)) byUser.set(row.userId, []);
    byUser.get(row.userId)!.push(row);
  }
  counts.users = byUser.size;
  console.log(`candidates: ${rows.length} workflow(s) across ${byUser.size} user(s)`);

  for (const [userId, userRows] of byUser) await processUser(userId, userRows);

  console.log('\nsummary:', counts);
  if (!execute) console.log('(dry-run — nothing was written; re-run with --execute to apply)');
}

main()
  .then(() => process.exit(counts.errors > 0 ? 1 : 0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
