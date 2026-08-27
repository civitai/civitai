/**
 * Model VERSION name sweep — the five-phase workbook.
 *
 * Phase 1 runs the curated term list over every model version in the database and writes the
 * matches to an .xlsx. Phase 2 sends those same names to XGuard and fills in the verdict
 * columns beside them, so the rows where the two detectors DISAGREE can be sorted, read and
 * ruled on by a human. Those rulings are how the curated term list is tuned — the live writer
 * is the version-name moderation adapter, not this script.
 *
 * Separate from `model-name-moderation-harness.ts` on purpose: that one answers "which detector
 * is better" over a sample. This one is the production run over the whole table, and its output
 * is a work product someone edits rather than a report they read. Phase 5 applies its verdicts.
 *
 *   # 1 — term sweep, whole table, no network calls
 *   pnpm exec tsx --env-file=.env scripts/oneoffs/model-version-name-sweep.ts \
 *     --terms-file local/model-name-terms.json --out local/version-sweep.xlsx
 *
 *   # 2 — XGuard the matches, filling columns in the same file. Resumable.
 *   pnpm exec tsx --env-file=.env scripts/oneoffs/model-version-name-sweep.ts \
 *     --xguard local/version-sweep.xlsx --actionable-only [--max 2000] [--concurrency 4]
 *
 *   # 3 — collect the disagreements into a Review tab with an action dropdown
 *   pnpm exec tsx --env-file=.env scripts/oneoffs/model-version-name-sweep.ts \
 *     --review local/version-sweep.xlsx
 *
 *   # 4 — random control sample of NON-matching names, XGuard'd into a second tab. Resumable.
 *   pnpm exec tsx --env-file=.env scripts/oneoffs/model-version-name-sweep.ts \
 *     --sample local/version-sweep.xlsx [--sample-size 2000] [--concurrency 4]
 *
 *   # 5 — apply the workbook verdicts to ModelVersion.nsfw. Resumable, idempotent, dry-run
 *   #     unless --confirm. Reuses the phase-2 scans; makes no network calls.
 *   NODE_ENV=development pnpm exec tsx --env-file=.env \
 *     scripts/oneoffs/model-version-name-sweep.ts \
 *     --apply local/version-sweep.xlsx [--batch 500] [--confirm]
 *
 * `--actionable-only` skips rows where flagging the version would change nothing — a model
 * already NSFW, an unpublished version, a system-owned one. On the first full sweep that left
 * 448 actionable rows (see local/model-version-nsfw-WORKING.md §9).
 *
 * Phase 3 is regenerable: decisions already entered are carried across by modelVersionId, so
 * re-running after another XGuard pass adds new disagreements without losing rulings.
 *
 * PHASE 2 IS RESUMABLE AND MUST BE. Every row already carrying a verdict is skipped, and the
 * workbook is saved after each chunk — so a timeout, a rate limit or a Ctrl-C costs the current
 * chunk and nothing else. At one LLM call per name a full pass is hours, and a run that loses
 * its work on failure would never finish.
 *
 * `--max` caps a single run so it can be done in sittings. Re-run the same command to continue.
 *
 * ON THE TERM LIST: supplied at run time from gitignored `local/`, never committed — "these are
 * the words we auto-flag on" is a decision rule, and this repo is public (CLAUDE.md → Security).
 *
 * ⚠️ SYSTEM-OWNED MODELS. Versions under the system account are marked `systemOwned` and must
 * never be flagged: the level derivation has no branch for an unflagged system-owned version, so
 * setting the flag there is a one-way door. A database trigger refuses the write; this column
 * exists so the sweep never presents a row that could not be flagged anyway.
 */
import { readFileSync } from 'fs';
import { parseArgs } from 'node:util';
import ExcelJS from 'exceljs';
import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  MODEL_MODERATION_LEVEL_LABELS,
  MODEL_MODERATION_SCAN_LABELS,
} from '~/server/services/model-moderation.labels';
import {
  collectMatchedTerms,
  triggeredLabelDetails,
  triggeredLabelKeys,
} from '~/server/services/moderation-label-helpers';
import {
  updateModelNsfwLevels,
  updateModelVersionNsfwLevels,
} from '~/server/services/nsfwLevels.service';
import { createXGuardModerationRequest } from '~/server/services/orchestrator/orchestrator.service';
import { matchSpec, type LabelRegexSpec } from '~/server/services/scanner-label-regex';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';

const SHEET = 'Versions';
const REGEX_LABEL = 'curated-name-terms';
const SYSTEM_USER_ID = -1;
const LEVEL_LABELS: ReadonlySet<string> = new Set(MODEL_MODERATION_LEVEL_LABELS);

/**
 * Would flagging this version change anything a viewer can see?
 *
 * No, in three cases: a version under a model already marked NSFW is ALREADY stamped to the
 * NSFW level by the `m.nsfw` branch of the same CASE; an unpublished version renders nowhere;
 * and a system-owned one is refused at the write (§3.5 of the plan).
 *
 * One definition, used by `--actionable-only` to decide what to scan and by the review sheet to
 * decide what needs a ruling. Two copies of this predicate would silently disagree about which
 * rows matter.
 */
function isActionable(row: {
  systemOwned: unknown;
  versionStatus: unknown;
  modelNsfw: unknown;
}): boolean {
  if (row.systemOwned === true) return false;
  if (String(row.versionStatus ?? '') !== 'Published') return false;
  return row.modelNsfw !== true;
}

/**
 * Column order is the review order: identity, then what the term list said, then what XGuard
 * said, then the disagreement, then the human's call. `decision` is the only column a person
 * writes, and it is last so it lands under the cursor after reading the row.
 */
const COLUMNS: Array<{ header: string; key: string; width: number }> = [
  { header: 'modelVersionId', key: 'modelVersionId', width: 16 },
  { header: 'modelId', key: 'modelId', width: 12 },
  { header: 'versionName', key: 'versionName', width: 46 },
  { header: 'modelName', key: 'modelName', width: 46 },
  { header: 'versionStatus', key: 'versionStatus', width: 14 },
  { header: 'modelStatus', key: 'modelStatus', width: 13 },
  { header: 'modelNsfw', key: 'modelNsfw', width: 11 },
  { header: 'systemOwned', key: 'systemOwned', width: 13 },
  { header: 'matchedTerms', key: 'matchedTerms', width: 26 },
  { header: 'xguardTriggered', key: 'xguardTriggered', width: 16 },
  { header: 'xguardTopScore', key: 'xguardTopScore', width: 15 },
  { header: 'xguardLabels', key: 'xguardLabels', width: 40 },
  { header: 'agree', key: 'agree', width: 9 },
  { header: 'decision', key: 'decision', width: 14 },
];

type Row = {
  modelVersionId: number;
  modelId: number;
  versionName: string;
  modelName: string;
  versionStatus: string;
  modelStatus: string;
  modelNsfw: boolean;
  systemOwned: boolean;
  matchedTerms: string;
  xguardTriggered: string;
  xguardTopScore: string;
  xguardLabels: string;
  agree: string;
  decision: string;
};

const { values } = parseArgs({
  options: {
    'terms-file': { type: 'string' },
    out: { type: 'string' },
    xguard: { type: 'string' },
    max: { type: 'string' },
    review: { type: 'string' },
    sample: { type: 'string' },
    'sample-size': { type: 'string', default: '2000' },
    'actionable-only': { type: 'boolean', default: false },
    concurrency: { type: 'string', default: '4' },
    wait: { type: 'string', default: '30' },
    'page-size': { type: 'string', default: '20000' },
    apply: { type: 'string' },
    confirm: { type: 'boolean', default: false },
    batch: { type: 'string', default: '500' },
  },
});

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

const concurrency = Number(values.concurrency);
const wait = Number(values.wait);

// ---------------------------------------------------------------- phase 1

async function sweep() {
  if (!values['terms-file']) fail('--terms-file is required for the sweep');
  if (!values.out) fail('--out <file.xlsx> is required for the sweep');

  let spec: LabelRegexSpec;
  try {
    spec = JSON.parse(readFileSync(values['terms-file'], 'utf-8')) as LabelRegexSpec;
  } catch (e) {
    fail(`could not read --terms-file: ${(e as Error).message}`);
  }
  if (!Array.isArray(spec!.triggers)) fail('--terms-file must contain a `triggers` array');

  const pageSize = Number(values['page-size']);
  if (!Number.isInteger(pageSize) || pageSize < 1) fail('--page-size must be a positive integer');

  const maxId =
    (await dbRead.$queryRaw<{ max: number | null }[]>`SELECT MAX(id) AS max FROM "ModelVersion"`)[0]
      ?.max ?? 0;

  const rows: Row[] = [];
  const termHits = new Map<string, number>();
  let scanned = 0;
  let cursor = 0;

  // Paged by id rather than OFFSET: the table is ~1.2M rows and an offset scan degrades
  // linearly, while `id > cursor` stays an index range whatever the depth.
  while (cursor < maxId) {
    const to = cursor + pageSize;
    const page = await dbRead.$queryRaw<
      {
        id: number;
        name: string;
        modelId: number;
        versionStatus: string;
        modelName: string;
        modelStatus: string;
        modelNsfw: boolean;
        modelUserId: number;
      }[]
    >(Prisma.sql`
      SELECT mv.id, mv.name, mv."modelId",
             mv.status::text AS "versionStatus",
             m.name AS "modelName",
             m.status::text AS "modelStatus",
             m.nsfw AS "modelNsfw",
             m."userId" AS "modelUserId"
      FROM "ModelVersion" mv
      JOIN "Model" m ON m.id = mv."modelId"
      WHERE mv.id > ${cursor} AND mv.id <= ${to}
      ORDER BY mv.id
    `);

    scanned += page.length;
    for (const v of page) {
      const hit = matchSpec(REGEX_LABEL, spec!, v.name ?? '');
      if (!hit.matched) continue;
      for (const t of hit.matchedTerms) termHits.set(t, (termHits.get(t) ?? 0) + 1);
      rows.push({
        modelVersionId: v.id,
        modelId: v.modelId,
        versionName: v.name ?? '',
        modelName: v.modelName ?? '',
        versionStatus: v.versionStatus,
        modelStatus: v.modelStatus,
        modelNsfw: v.modelNsfw,
        systemOwned: v.modelUserId === SYSTEM_USER_ID,
        matchedTerms: hit.matchedTerms.join(', '),
        xguardTriggered: '',
        xguardTopScore: '',
        xguardLabels: '',
        agree: '',
        decision: '',
      });
    }

    cursor = to;
    if (scanned % (pageSize * 10) === 0 || cursor >= maxId)
      console.log(`  scanned ${scanned} versions · ${rows.length} matches · id ≤ ${cursor}`);
  }

  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet(SHEET);
  sheet.columns = COLUMNS;
  sheet.getRow(1).font = { bold: true };
  // Freeze the header so a 20k-row review does not lose its column names on scroll.
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: 'A1', to: { row: 1, column: COLUMNS.length } };
  rows.forEach((r) => sheet.addRow(r));
  await wb.xlsx.writeFile(values.out!);

  const published = rows.filter((r) => r.versionStatus === 'Published').length;
  console.log('');
  console.log({
    scanned,
    matched: rows.length,
    publishedMatches: published,
    systemOwned: rows.filter((r) => r.systemOwned).length,
    alreadyNsfwModel: rows.filter((r) => r.modelNsfw).length,
    wrote: values.out,
  });
  console.log('');
  console.log('term hits (descending):');
  for (const [term, n] of [...termHits].sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(n).padStart(6)}  ${term}`);
}

// ---------------------------------------------------------------- phase 2

/** One XGuard text scan with no side effects: no EntityModeration row, no callback, no audit. */
async function scanName(name: string) {
  try {
    const result = await createXGuardModerationRequest({
      mode: 'text',
      content: name,
      labels: [...MODEL_MODERATION_SCAN_LABELS],
      wait,
      callbackUrl: null,
      recordForReview: false,
    });
    const steps = (result as { steps?: Array<Record<string, unknown>> })?.steps ?? [];
    const output = (steps.find((s) => s.$type === 'xGuardModeration') as { output?: unknown })
      ?.output as Parameters<typeof triggeredLabelKeys>[0];
    if (!output) return { error: 'no xGuardModeration step' };

    const triggered = triggeredLabelKeys(output, { includeScoreThreshold: true });
    const labels = triggeredLabelDetails(output, triggered);
    const levels = labels.filter((l) => LEVEL_LABELS.has(l.label));
    return {
      triggered: levels.length > 0,
      topScore: levels.length ? Math.max(...levels.map((l) => l.score)) : null,
      labels: labels.map((l) => `${l.label}=${l.score.toFixed(2)}`).join(' '),
      terms: collectMatchedTerms(output, triggered),
    };
  } catch (e) {
    // Returned, not thrown: one unreachable orchestrator must not lose the rest of the chunk,
    // and an errored name is not a clean one — it is left blank so a re-run picks it up again.
    return { error: (e as Error).message };
  }
}

async function fillXGuard() {
  const file = values.xguard!;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const sheet = wb.getWorksheet(SHEET);
  if (!sheet) fail(`workbook has no "${SHEET}" sheet — was it produced by the sweep?`);

  const header = sheet!.getRow(1);
  const col: Record<string, number> = {};
  header.eachCell((cell, i) => {
    col[String(cell.value ?? '').trim()] = i;
  });
  for (const need of ['versionName', 'matchedTerms', 'xguardTriggered', 'agree'])
    if (!col[need]) fail(`workbook is missing the "${need}" column`);

  // Only rows with no verdict yet. This is what makes the run resumable — and the reason a
  // failed scan is left blank rather than written as an error.
  //
  // `--actionable-only` drops the rows where flagging the version would change nothing: a
  // version under a model already marked NSFW is ALREADY stamped to the NSFW level by the
  // `m.nsfw` branch of the same CASE, an unpublished version renders nowhere, and a
  // system-owned one is refused at the write. On the first full sweep that was 2,171 of 2,619
  // rows — six times the LLM calls for no decision at the end of them.
  const skip = { alreadyNsfw: 0, unpublished: 0, systemOwned: 0 };
  const pending: number[] = [];
  for (let r = 2; r <= sheet!.rowCount; r++) {
    const row = sheet!.getRow(r);
    const v = row.getCell(col.xguardTriggered).value;
    if (!(v === null || v === undefined || String(v).trim() === '')) continue;

    if (values['actionable-only']) {
      const status = {
        systemOwned: row.getCell(col.systemOwned).value,
        versionStatus: row.getCell(col.versionStatus).value,
        modelNsfw: row.getCell(col.modelNsfw).value,
      };
      if (!isActionable(status)) {
        if (status.systemOwned === true) skip.systemOwned++;
        else if (String(status.versionStatus ?? '') !== 'Published') skip.unpublished++;
        else skip.alreadyNsfw++;
        continue;
      }
    }
    pending.push(r);
  }
  if (values['actionable-only']) console.log('skipped as not actionable:', skip);

  const max = values.max ? Number(values.max) : pending.length;
  if (!Number.isInteger(max) || max < 1) fail('--max must be a positive integer');
  const batch = pending.slice(0, max);

  console.log(
    `${sheet!.rowCount - 1} rows · ${pending.length} without a verdict · scanning ${batch.length}`
  );
  if (!batch.length) return console.log('nothing to do — every row already has a verdict');

  const { done, errors } = await fillVerdicts({
    wb,
    sheet: sheet!,
    col,
    rows: batch,
    file,
    // The term list matched every row in THIS sheet by construction, so agreement is simply
    // whether XGuard also called it.
    verdictColumn: 'agree',
    verdict: (triggered) => (triggered ? 'agree' : 'DISAGREE'),
  });

  let agree = 0;
  let disagree = 0;
  for (let r = 2; r <= sheet!.rowCount; r++) {
    const v = String(sheet!.getRow(r).getCell(col.agree).value ?? '');
    if (v === 'agree') agree++;
    else if (v === 'DISAGREE') disagree++;
  }

  console.log('');
  console.log({
    scannedThisRun: done,
    errors,
    agree,
    disagree,
    stillPending: pending.length - done,
    file,
  });
  console.log('');
  console.log('Filter `agree = DISAGREE` to review the rows the two detectors read differently.');
}

/**
 * The resumable scan loop, shared by the match sheet and the control sample.
 *
 * Saves every chunk rather than once at the end: at one LLM call per name a full pass is hours,
 * and a run that discarded its work on failure would never finish. A failed scan writes nothing,
 * so the row stays pending and the next run picks it up.
 */
async function fillVerdicts({
  wb,
  sheet,
  col,
  rows,
  file,
  verdictColumn,
  verdict,
}: {
  wb: ExcelJS.Workbook;
  sheet: ExcelJS.Worksheet;
  col: Record<string, number>;
  rows: number[];
  file: string;
  verdictColumn: string;
  verdict: (triggered: boolean) => string;
}) {
  const CHUNK = 200;
  let done = 0;
  let errors = 0;

  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    await limitConcurrency(
      slice.map((rowNumber) => async () => {
        const row = sheet.getRow(rowNumber);
        const name = String(row.getCell(col.versionName).value ?? '');
        const res = await scanName(name);
        if ('error' in res && res.error) {
          errors++;
          return;
        }
        const r = res as Exclude<typeof res, { error: string }>;
        row.getCell(col.xguardTriggered).value = r.triggered ? 'yes' : 'no';
        row.getCell(col.xguardTopScore).value = r.topScore ?? '';
        row.getCell(col.xguardLabels).value = r.labels;
        row.getCell(col[verdictColumn]).value = verdict(r.triggered);
        row.commit();
        done++;
      }),
      concurrency
    );

    await wb.xlsx.writeFile(file);
    console.log(`  saved · ${done}/${rows.length} scanned · ${errors} errors`);
  }

  return { done, errors };
}

// ---------------------------------------------------------------- phase 4

const SAMPLE_SHEET = 'Control sample';

const SAMPLE_COLUMNS: Array<{ header: string; key: string; width: number }> = [
  { header: 'modelVersionId', key: 'modelVersionId', width: 16 },
  { header: 'modelId', key: 'modelId', width: 12 },
  { header: 'versionName', key: 'versionName', width: 46 },
  { header: 'modelName', key: 'modelName', width: 46 },
  { header: 'xguardTriggered', key: 'xguardTriggered', width: 16 },
  { header: 'xguardTopScore', key: 'xguardTopScore', width: 15 },
  { header: 'xguardLabels', key: 'xguardLabels', width: 40 },
  { header: 'missedByTerms', key: 'missedByTerms', width: 15 },
];

/**
 * The other half of the measurement: names the term list did NOT match.
 *
 * Every row in the match sheet is a name the list already found, so that sheet can only ever
 * measure how often XGuard confirms the list — its precision. It cannot count what the list
 * MISSES.
 *
 * This is a random sample of ACTIONABLE non-matching versions, scanned by XGuard. Every row
 * XGuard flags is a miss, and the hit rate over the sample extrapolates to the population — so
 * the run reports the population size alongside it.
 *
 * Sampled rather than exhaustive because the population is ~1.2M and this costs one LLM call
 * per name. A sample of a few thousand bounds the miss rate closely enough to decide with.
 */
async function buildSample() {
  const file = values.sample!;
  const size = Number(values['sample-size'] ?? '2000');
  if (!Number.isInteger(size) || size < 1) fail('--sample-size must be a positive integer');

  let spec: LabelRegexSpec | null = null;
  if (values['terms-file']) {
    try {
      spec = JSON.parse(readFileSync(values['terms-file'], 'utf-8')) as LabelRegexSpec;
    } catch (e) {
      fail(`could not read --terms-file: ${(e as Error).message}`);
    }
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  let sheet = wb.getWorksheet(SAMPLE_SHEET);

  if (!sheet) {
    if (!spec) fail('--terms-file is required the first time, to exclude matching names');

    // The denominator, reported so the sample's hit rate can be extrapolated.
    const [{ total }] = await dbRead.$queryRaw<{ total: number }[]>(Prisma.sql`
      SELECT count(*)::int AS total
      FROM "ModelVersion" mv
      JOIN "Model" m ON m.id = mv."modelId"
      WHERE mv.status = 'Published' AND m.nsfw = FALSE AND m."userId" > ${SYSTEM_USER_ID}
    `);

    // Oversampled: the ~0.2% that DO match the term list are dropped below, and a random
    // sample is meaningless if it is the first N by id — those are the oldest models.
    const picked = await dbRead.$queryRaw<
      { id: number; name: string; modelId: number; modelName: string }[]
    >(Prisma.sql`
      SELECT mv.id, mv.name, mv."modelId", m.name AS "modelName"
      FROM "ModelVersion" mv
      JOIN "Model" m ON m.id = mv."modelId"
      WHERE mv.status = 'Published' AND m.nsfw = FALSE AND m."userId" > ${SYSTEM_USER_ID}
      ORDER BY random()
      LIMIT ${Math.ceil(size * 1.1)}
    `);

    const nonMatching = picked
      .filter((v) => !matchSpec(REGEX_LABEL, spec!, v.name ?? '').matched)
      .slice(0, size);

    sheet = wb.addWorksheet(SAMPLE_SHEET);
    sheet.columns = SAMPLE_COLUMNS;
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = { from: 'A1', to: { row: 1, column: SAMPLE_COLUMNS.length } };
    nonMatching.forEach((v) =>
      sheet!.addRow({
        modelVersionId: v.id,
        modelId: v.modelId,
        versionName: v.name ?? '',
        modelName: v.modelName ?? '',
        xguardTriggered: '',
        xguardTopScore: '',
        xguardLabels: '',
        missedByTerms: '',
      })
    );
    await wb.xlsx.writeFile(file);
    console.log(
      `drew ${nonMatching.length} of ${picked.length} random actionable versions ` +
        `(${
          picked.length - nonMatching.length
        } dropped as term matches) from a population of ${total}`
    );
  }

  const col: Record<string, number> = {};
  sheet!.getRow(1).eachCell((cell, i) => {
    col[String(cell.value ?? '').trim()] = i;
  });

  const pending: number[] = [];
  for (let r = 2; r <= sheet!.rowCount; r++) {
    const v = sheet!.getRow(r).getCell(col.xguardTriggered).value;
    if (v === null || v === undefined || String(v).trim() === '') pending.push(r);
  }

  const max = values.max ? Number(values.max) : pending.length;
  const batch = pending.slice(0, max);
  console.log(
    `${sheet!.rowCount - 1} sampled · ${pending.length} unscanned · scanning ${batch.length}`
  );

  const { done, errors } = batch.length
    ? await fillVerdicts({
        wb,
        sheet: sheet!,
        col,
        rows: batch,
        file,
        // Every row here is a name the term list did not match, so an XGuard trigger IS a miss.
        verdictColumn: 'missedByTerms',
        verdict: (triggered) => (triggered ? 'MISS' : 'no'),
      })
    : { done: 0, errors: 0 };

  let scanned = 0;
  let missed = 0;
  for (let r = 2; r <= sheet!.rowCount; r++) {
    const v = String(sheet!.getRow(r).getCell(col.missedByTerms).value ?? '');
    if (v) scanned++;
    if (v === 'MISS') missed++;
  }

  console.log('');
  console.log({
    scannedThisRun: done,
    errors,
    sampleScanned: scanned,
    missed,
    missRate: scanned ? `${((missed / scanned) * 100).toFixed(2)}%` : 'n/a',
    stillPending: pending.length - done,
    file,
  });
  console.log('');
  console.log('Filter `missedByTerms = MISS` for names XGuard flags that the term list does not.');
}

// ---------------------------------------------------------------- phase 3

const REVIEW_SHEET = 'Review';

const REVIEW_COLUMNS: Array<{ header: string; key: string; width: number }> = [
  { header: 'action', key: 'action', width: 10 },
  { header: 'actionable', key: 'actionable', width: 12 },
  { header: 'modelVersionId', key: 'modelVersionId', width: 16 },
  { header: 'modelId', key: 'modelId', width: 12 },
  { header: 'versionName', key: 'versionName', width: 46 },
  { header: 'modelName', key: 'modelName', width: 46 },
  { header: 'matchedTerms', key: 'matchedTerms', width: 24 },
  { header: 'xguardLabels', key: 'xguardLabels', width: 34 },
  { header: 'whyNotActionable', key: 'whyNotActionable', width: 20 },
];

/**
 * The exception list: every row where the term list fired and XGuard did not.
 *
 * The agreeing rows need no review — both detectors called them, and they are the presumed
 * yes-set the update is built from. This sheet is only the rows a person has to rule on.
 *
 * `action` is first, not last, so a reviewer types in column A without scrolling past the
 * evidence each time. Blank means leave the version alone; `nsfw` means flag it.
 *
 * Regenerating is safe: actions already entered are carried across by modelVersionId, so this
 * can be re-run after another XGuard pass without losing decisions.
 */
async function buildReview() {
  const file = values.review!;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const src = wb.getWorksheet(SHEET);
  if (!src) fail(`workbook has no "${SHEET}" sheet — was it produced by the sweep?`);

  const col: Record<string, number> = {};
  src!.getRow(1).eachCell((cell, i) => {
    col[String(cell.value ?? '').trim()] = i;
  });
  if (!col.agree) fail('workbook has no "agree" column — run the --xguard phase first');

  // Carry over anything already decided before the sheet is replaced.
  const existing = new Map<number, string>();
  const prior = wb.getWorksheet(REVIEW_SHEET);
  if (prior) {
    const pcol: Record<string, number> = {};
    prior.getRow(1).eachCell((cell, i) => {
      pcol[String(cell.value ?? '').trim()] = i;
    });
    if (pcol.modelVersionId && pcol.action)
      for (let r = 2; r <= prior.rowCount; r++) {
        const id = Number(prior.getRow(r).getCell(pcol.modelVersionId).value);
        const action = String(prior.getRow(r).getCell(pcol.action).value ?? '').trim();
        if (id && action) existing.set(id, action);
      }
    wb.removeWorksheet(prior.id);
  }

  const rows: Record<string, unknown>[] = [];
  for (let r = 2; r <= src!.rowCount; r++) {
    const row = src!.getRow(r);
    if (String(row.getCell(col.agree).value ?? '') !== 'DISAGREE') continue;
    const id = Number(row.getCell(col.modelVersionId).value);
    const status = {
      systemOwned: row.getCell(col.systemOwned).value,
      versionStatus: row.getCell(col.versionStatus).value,
      modelNsfw: row.getCell(col.modelNsfw).value,
    };
    const actionable = isActionable(status);
    rows.push({
      action: existing.get(id) ?? '',
      actionable: actionable ? 'yes' : 'no',
      modelVersionId: id,
      modelId: row.getCell(col.modelId).value,
      versionName: row.getCell(col.versionName).value,
      modelName: row.getCell(col.modelName).value,
      matchedTerms: row.getCell(col.matchedTerms).value,
      xguardLabels: row.getCell(col.xguardLabels).value || '(nothing triggered)',
      // Why a row needs no ruling, so "actionable = no" is a statement rather than a shrug.
      whyNotActionable: actionable
        ? ''
        : status.systemOwned === true
        ? 'system-owned'
        : String(status.versionStatus ?? '') !== 'Published'
        ? 'not published'
        : 'model already nsfw',
    });
  }

  const sheet = wb.addWorksheet(REVIEW_SHEET);
  sheet.columns = REVIEW_COLUMNS;
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: 1 }];
  sheet.autoFilter = { from: 'A1', to: { row: 1, column: REVIEW_COLUMNS.length } };
  rows.forEach((r) => sheet.addRow(r));

  // A dropdown rather than free text: this column is read back to build a SQL UPDATE, so a
  // typo is a version silently not flagged.
  //
  // `skip` exists so a decision NOT to flag is recordable. Blank would do the same thing to the
  // SQL, but blank cannot tell "ruled on, leave it" from "nobody has looked yet" — and only the
  // former should survive a regeneration.
  for (let r = 2; r <= rows.length + 1; r++) {
    sheet.getCell(r, 1).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: ['"nsfw,skip"'],
      showErrorMessage: true,
      errorTitle: 'Use the dropdown',
      error: 'nsfw to flag the version, skip to rule it out. Blank means undecided.',
    };
  }

  await wb.xlsx.writeFile(file);
  console.log({
    disagreements: rows.length,
    carriedOverDecisions: [...existing.keys()].filter((id) =>
      rows.some((r) => r.modelVersionId === id)
    ).length,
    sheet: REVIEW_SHEET,
    file,
  });
  console.log('');
  console.log('Column A is a dropdown: `nsfw` to flag the version, blank to leave it alone.');
  console.log('The agreeing rows are not here — they are the presumed yes-set.');
}

// ---------------------------------------------------------------- phase 5

/**
 * Apply the workbook's verdicts to `ModelVersion.nsfw`.
 *
 * The live path flags on create and rename only, so it never reaches a version nobody has saved
 * since the feature shipped. This is how the existing corpus gets flagged, and it reuses the
 * scans already in the workbook rather than paying for them twice — every row carries an XGuard
 * verdict from phase 2.
 *
 * The yes-set is the same one the live path would produce: a term matched AND the scan did not
 * overturn it. Phase 3's Review tab overrides that per row for the disagreements a human ruled
 * on — `nsfw` in its action column flags anyway, blank leaves it alone.
 *
 * Resumable and idempotent: each row gets an `applied` stamp, and a re-run considers only blank
 * ones. The workbook saves after every batch, so an interrupted run resumes where it stopped.
 */
async function applyFlags() {
  const file = values.apply!;
  const batchSize = Number(values.batch);
  if (!Number.isInteger(batchSize) || batchSize < 1) fail('--batch must be a positive integer');

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const sheet = wb.getWorksheet(SHEET);
  if (!sheet) fail(`workbook has no "${SHEET}" sheet — was it produced by the sweep?`);

  const header = sheet.getRow(1);
  const col: Record<string, number> = {};
  header.eachCell((cell, i) => {
    col[String(cell.value ?? '').trim()] = i;
  });
  for (const need of ['modelVersionId', 'modelId', 'agree', 'systemOwned'])
    if (!col[need]) fail(`workbook is missing the "${need}" column`);

  // Added on first apply rather than by the sweep, so an older workbook still works.
  let appliedCol = col.applied;
  if (!appliedCol) {
    appliedCol = header.cellCount + 1;
    header.getCell(appliedCol).value = 'applied';
    header.commit();
  }

  // Phase 3's rulings win over the presumed yes-set. A disagreement a human left blank was
  // ruled DO NOT FLAG — that is a decision, not a missing value, so it has to beat `agree`.
  const reviewed = new Map<number, boolean>();
  const review = wb.getWorksheet('Review');
  if (review) {
    const rHeader = review.getRow(1);
    const rCol: Record<string, number> = {};
    rHeader.eachCell((cell, i) => {
      rCol[String(cell.value ?? '').trim()] = i;
    });
    if (rCol.modelVersionId && rCol.action)
      for (let r = 2; r <= review.rowCount; r++) {
        const id = Number(review.getRow(r).getCell(rCol.modelVersionId).value);
        if (!Number.isInteger(id)) continue;
        const action = String(review.getRow(r).getCell(rCol.action).value ?? '')
          .trim()
          .toLowerCase();
        reviewed.set(id, action === 'nsfw');
      }
  }

  type Pending = { row: number; versionId: number; modelId: number };
  const flag: Pending[] = [];
  const skip = { alreadyApplied: 0, systemOwned: 0, overturned: 0, reviewedNo: 0 };

  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const stamped = String(row.getCell(appliedCol).value ?? '').trim();
    if (stamped) {
      skip.alreadyApplied++;
      continue;
    }

    const versionId = Number(row.getCell(col.modelVersionId).value);
    const modelId = Number(row.getCell(col.modelId).value);
    if (!Number.isInteger(versionId) || !Number.isInteger(modelId)) continue;

    // A database trigger refuses the write, and clearing it later is a one-way door — the level
    // derivation has no branch for an unflagged system-owned version.
    if (row.getCell(col.systemOwned).value === true) {
      skip.systemOwned++;
      row.getCell(appliedCol).value = 'skipped:system-owned';
      continue;
    }

    const ruling = reviewed.get(versionId);
    if (ruling === false) {
      skip.reviewedNo++;
      row.getCell(appliedCol).value = 'skipped:reviewed-no';
      continue;
    }

    const agrees = String(row.getCell(col.agree).value ?? '').trim() === 'agree';
    if (!ruling && !agrees) {
      skip.overturned++;
      row.getCell(appliedCol).value = 'skipped:overturned';
      continue;
    }

    flag.push({ row: r, versionId, modelId });
  }

  console.log({ toFlag: flag.length, ...skip });

  if (!values.confirm) {
    console.log('DRY RUN — pass --confirm to write. The workbook was not modified.');
    return;
  }

  let flipped = 0;
  for (let i = 0; i < flag.length; i += batchSize) {
    const chunk = flag.slice(i, i + batchSize);
    const versionIds = chunk.map((c) => c.versionId);

    // The same guards as the live writer, in the same statement: system-owned models excluded,
    // a moderator's ruling left alone, and the flag only ever moved from FALSE so a re-run
    // cannot double-count. This path does NOT go through `writeVersionNameFlag`, so the guard
    // has to be repeated here rather than inherited.
    const count = await dbWrite.$executeRaw`
      UPDATE "ModelVersion" mv
      SET nsfw = TRUE
      FROM "Model" m
      WHERE mv.id IN (${Prisma.join(versionIds)})
        AND m.id = mv."modelId"
        AND m."userId" > ${SYSTEM_USER_ID}
        AND mv.nsfw = FALSE
        AND mv.meta -> 'nsfwDecision' IS NULL
    `;
    flipped += count;

    // `nsfw` is an INPUT to the derived level, so the write alone changes nothing anyone reads.
    // These also queue the search index and bust the caches that embed the level.
    await updateModelVersionNsfwLevels(versionIds);
    await updateModelNsfwLevels([...new Set(chunk.map((c) => c.modelId))]);

    const stamp = new Date().toISOString();
    for (const c of chunk) sheet.getRow(c.row).getCell(appliedCol).value = stamp;
    await wb.xlsx.writeFile(file);

    console.log(`  ${Math.min(i + batchSize, flag.length)}/${flag.length} (${flipped} flipped)`);
  }

  console.log({ flipped, rows: flag.length });
  console.log('Rows already at nsfw=true count as applied — the stamp records the decision.');
}

// ----------------------------------------------------------------

async function main() {
  if (values.apply) return applyFlags();
  if (values.sample) return buildSample();
  if (values.review) return buildReview();
  if (values.xguard && values['terms-file'])
    fail('run one phase at a time — --xguard reads a workbook the sweep already wrote');
  if (values.xguard) await fillXGuard();
  else await sweep();
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
