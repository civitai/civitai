import ExcelJS from 'exceljs';
import {
  testCaseRowSchema,
  type ScannerPolicyCandidate,
  type ScannerPolicyMode,
  type TestCaseRow,
} from '~/server/schema/scanner-policies.schema';

/**
 * Scanner-policies test bench — xlsx workbook io.
 *
 * Two-phase round trip:
 *   1. exportDataset → `buildInputWorkbook`: server creates the input workbook
 *      with one Test Cases sheet and a hidden _meta sheet. User downloads it
 *      from S3.
 *   2. runTests → `parseInputWorkbook` + `appendResultsToWorkbook`: server reads
 *      the same workbook back (rows + the dataset hash from _meta), scores all
 *      active candidates against every row, then merges the per-row results
 *      into a single Results sheet keyed by (contentHash, policyHash).
 *
 * The Results sheet is a merge — re-running with edited policies appends new
 * (policyHash) rows alongside existing ones, so the workbook accumulates
 * iteration history.
 */

const INPUT_SHEET = 'Test Cases';
const META_SHEET = '_meta';
const RESULTS_SHEET = 'Results';

const INPUT_COLUMNS: Array<{ header: string; key: keyof TestCaseRow; width: number }> = [
  { header: 'contentHash', key: 'contentHash', width: 20 },
  { header: 'label', key: 'label', width: 18 },
  { header: 'verdict', key: 'verdict', width: 10 },
  { header: 'expectedTrigger', key: 'expectedTrigger', width: 14 },
  { header: 'modCount', key: 'modCount', width: 10 },
  { header: 'agreementCount', key: 'agreementCount', width: 14 },
  { header: 'positivePrompt', key: 'positivePrompt', width: 80 },
  { header: 'negativePrompt', key: 'negativePrompt', width: 60 },
];

type InputWorkbookMeta = {
  datasetId: string;
  exportedAt: string;
  mode: ScannerPolicyMode;
  label: string;
  rowCount: number;
};

export async function buildInputWorkbook(
  rows: TestCaseRow[],
  meta: InputWorkbookMeta
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Civitai Scanner Policies';
  wb.created = new Date(meta.exportedAt);

  const sheet = wb.addWorksheet(INPUT_SHEET);
  sheet.columns = INPUT_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  for (const r of rows) sheet.addRow(r);

  // Hidden metadata sheet — survives a workbook round-trip and lets us reject
  // mismatched uploads (e.g. mod uploads a Young workbook to a Suggestive run).
  const m = wb.addWorksheet(META_SHEET, { state: 'hidden' });
  m.addRow(['datasetId', meta.datasetId]);
  m.addRow(['exportedAt', meta.exportedAt]);
  m.addRow(['mode', meta.mode]);
  m.addRow(['label', meta.label]);
  m.addRow(['rowCount', meta.rowCount]);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

export type ParsedInputWorkbook = {
  rows: TestCaseRow[];
  meta: Partial<InputWorkbookMeta>;
  /** Original buffer kept around so we can re-emit the workbook with a Results sheet. */
  workbook: ExcelJS.Workbook;
};

export async function parseInputWorkbook(buffer: Buffer): Promise<ParsedInputWorkbook> {
  const wb = new ExcelJS.Workbook();
  // exceljs' Buffer type is the older shape; the newer Node Buffer type is a
  // structural superset. The bytes are identical — cast is safe.
  await wb.xlsx.load(buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);

  const sheet = wb.getWorksheet(INPUT_SHEET);
  if (!sheet) {
    throw new Error(`Uploaded workbook is missing the "${INPUT_SHEET}" sheet`);
  }

  // Map header → column index so we don't have to assume a fixed column order.
  const headerRow = sheet.getRow(1);
  const colIndex: Record<string, number> = {};
  for (let i = 1; i <= sheet.columnCount; i++) {
    const v = headerRow.getCell(i).value;
    if (typeof v === 'string') colIndex[v] = i;
  }
  for (const c of INPUT_COLUMNS) {
    if (c.key === 'modCount' || c.key === 'agreementCount' || c.key === 'negativePrompt') continue;
    if (!colIndex[c.header]) {
      throw new Error(`Uploaded workbook missing required column "${c.header}"`);
    }
  }

  const rows: TestCaseRow[] = [];
  for (let rowIdx = 2; rowIdx <= sheet.rowCount; rowIdx++) {
    const row = sheet.getRow(rowIdx);
    if (!row.hasValues) continue;
    const get = (header: string) => {
      const idx = colIndex[header];
      if (!idx) return undefined;
      const v = row.getCell(idx).value;
      if (v === null || v === undefined) return undefined;
      if (typeof v === 'object' && 'text' in v) return String((v as { text: unknown }).text);
      return v;
    };
    const raw = {
      contentHash: String(get('contentHash') ?? ''),
      label: String(get('label') ?? ''),
      verdict: String(get('verdict') ?? ''),
      expectedTrigger:
        String(get('expectedTrigger') ?? '')
          .toLowerCase()
          .trim() === 'true',
      modCount: get('modCount') != null ? Number(get('modCount')) : undefined,
      agreementCount: get('agreementCount') != null ? Number(get('agreementCount')) : undefined,
      positivePrompt: String(get('positivePrompt') ?? ''),
      negativePrompt: get('negativePrompt') != null ? String(get('negativePrompt')) : undefined,
    };
    const parsed = testCaseRowSchema.safeParse(raw);
    if (parsed.success) rows.push(parsed.data);
  }

  // Read hidden _meta sheet (best-effort — may be missing for hand-edited files).
  const meta: Partial<InputWorkbookMeta> = {};
  const metaSheet = wb.getWorksheet(META_SHEET);
  if (metaSheet) {
    for (let i = 1; i <= metaSheet.rowCount; i++) {
      const row = metaSheet.getRow(i);
      const k = String(row.getCell(1).value ?? '');
      const v = row.getCell(2).value;
      if (!k) continue;
      if (k === 'rowCount' && v != null) meta.rowCount = Number(v);
      else if (k === 'mode' && v === 'prompt') meta.mode = 'prompt';
      else if (k === 'mode' && v === 'text') meta.mode = 'text';
      else if (k === 'label' && v != null) meta.label = String(v);
      else if (k === 'datasetId' && v != null) meta.datasetId = String(v);
      else if (k === 'exportedAt' && v != null) meta.exportedAt = String(v);
    }
  }

  return { rows, meta, workbook: wb };
}

export type ScoredResultRow = {
  contentHash: string;
  candidateId: string;
  candidateName: string;
  candidateMode: ScannerPolicyMode;
  candidateLabel: string;
  candidateThreshold: number;
  candidatePolicy: string;
  policyHash: string;
  score: number | null;
  triggered: boolean | null;
  expectedTrigger: boolean;
  correct: boolean | null;
  verdictCategory:
    | 'agree-trigger'
    | 'agree-secure'
    | 'fpFixed'
    | 'tpDropped'
    | 'tpRecovered'
    | 'tnNewlyFiring'
    | 'no-baseline'
    | 'error';
  errorMessage?: string;
  runId: string;
  runAt: string;
  /** Orchestrator workflow that produced this result. Null when the row is an
   *  early error (submit failed before a workflow was minted, or the callback
   *  arrived without a workflowId). Surfaced in the per-policy detail sheet so
   *  moderators can paste it into the orchestrator console for debugging. */
  workflowId: string | null;
};

const SUMMARY_SHEET = 'Summary';
const LEGEND_SHEET = 'Legend';

const SUMMARY_COLUMNS = [
  { header: 'policyName', width: 36 },
  { header: 'sheet', width: 24 },
  { header: 'policyHash', width: 24 },
  { header: 'label', width: 14 },
  { header: 'threshold', width: 10 },
  { header: 'testCases', width: 10 },
  { header: 'tp', width: 6 },
  { header: 'fp', width: 6 },
  { header: 'tn', width: 6 },
  { header: 'fn', width: 6 },
  { header: 'recall', width: 10 },
  { header: 'fpRate', width: 10 },
  { header: 'accuracy', width: 10 },
  { header: 'fpFixed', width: 9 },
  { header: 'tpDropped', width: 10 },
  { header: 'tpRecovered', width: 12 },
  { header: 'tnNewlyFiring', width: 14 },
  { header: 'errors', width: 8 },
  { header: 'runId', width: 22 },
  { header: 'runAt', width: 22 },
];

const POLICY_HEADER_ROWS = 6; // metadata rows at top of each policy sheet
const POLICY_DATA_HEADER_ROW = POLICY_HEADER_ROWS + 1;

const POLICY_DATA_COLUMNS = [
  { header: 'contentHash', width: 20 },
  { header: 'workflowId', width: 28 },
  { header: 'score', width: 10 },
  { header: 'triggered', width: 10 },
  { header: 'expectedTrigger', width: 14 },
  { header: 'correct', width: 10 },
  { header: 'verdictCategory', width: 18 },
  { header: 'errorMessage', width: 40 },
];

const ILLEGAL_SHEET_NAME_CHARS = /[:/\\?*[\]]/g;
const MAX_SHEET_NAME_LEN = 31;

type SummaryStats = {
  policyName: string;
  policyHash: string;
  label: string;
  threshold: number;
  testCases: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  errors: number;
  fpFixed: number;
  tpDropped: number;
  tpRecovered: number;
  tnNewlyFiring: number;
  runId: string;
  runAt: string;
};

function computeStatsForPolicy(rows: ScoredResultRow[]): Omit<
  SummaryStats,
  'policyName' | 'policyHash' | 'label' | 'threshold' | 'runId' | 'runAt'
> {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  let errors = 0;
  let fpFixed = 0;
  let tpDropped = 0;
  let tpRecovered = 0;
  let tnNewlyFiring = 0;
  for (const r of rows) {
    if (r.verdictCategory === 'error') {
      errors++;
      continue;
    }
    if (r.expectedTrigger && r.triggered === true) tp++;
    else if (r.expectedTrigger && r.triggered === false) fn++;
    else if (!r.expectedTrigger && r.triggered === true) fp++;
    else if (!r.expectedTrigger && r.triggered === false) tn++;
    if (r.verdictCategory === 'fpFixed') fpFixed++;
    else if (r.verdictCategory === 'tpDropped') tpDropped++;
    else if (r.verdictCategory === 'tpRecovered') tpRecovered++;
    else if (r.verdictCategory === 'tnNewlyFiring') tnNewlyFiring++;
  }
  return { testCases: rows.length, tp, fp, tn, fn, errors, fpFixed, tpDropped, tpRecovered, tnNewlyFiring };
}

function sanitizeSheetName(name: string, fallback: string): string {
  const cleaned = name.replace(ILLEGAL_SHEET_NAME_CHARS, '').trim();
  if (!cleaned) return fallback;
  return cleaned.slice(0, MAX_SHEET_NAME_LEN);
}

/** Locate an existing per-policy sheet by its embedded hash (cell B2). */
function findSheetByHash(workbook: ExcelJS.Workbook, policyHash: string): ExcelJS.Worksheet | null {
  const reserved = new Set([INPUT_SHEET, META_SHEET, SUMMARY_SHEET, LEGEND_SHEET, RESULTS_SHEET]);
  let found: ExcelJS.Worksheet | null = null;
  workbook.eachSheet((sheet) => {
    if (found) return;
    if (reserved.has(sheet.name)) return;
    const v = sheet.getCell('B2').value;
    if (typeof v === 'string' && v === policyHash) found = sheet;
  });
  return found;
}

function pickSheetName(
  workbook: ExcelJS.Workbook,
  policyName: string,
  policyHash: string,
  preserveSheet: ExcelJS.Worksheet | null
): string {
  // If we already have a sheet for this hash, reuse its name (no rename).
  if (preserveSheet) return preserveSheet.name;

  const base = sanitizeSheetName(policyName, `policy-${policyHash.slice(0, 8)}`);
  // If the candidate name collides with an existing sheet, suffix with a hash.
  const exists = (n: string) => !!workbook.getWorksheet(n);
  if (!exists(base)) return base;
  const suffix = `_${policyHash.slice(0, 6)}`;
  const room = MAX_SHEET_NAME_LEN - suffix.length;
  const trimmed = base.slice(0, room).trim();
  return `${trimmed}${suffix}`;
}

function writePolicyDetailSheet(args: {
  workbook: ExcelJS.Workbook;
  policyName: string;
  policyHash: string;
  label: string;
  threshold: number;
  policyText: string;
  runId: string;
  runAt: string;
  rows: ScoredResultRow[];
}): string {
  const existing = findSheetByHash(args.workbook, args.policyHash);
  const sheetName = pickSheetName(args.workbook, args.policyName, args.policyHash, existing);

  if (existing) args.workbook.removeWorksheet(existing.id);

  const sheet = args.workbook.addWorksheet(sheetName);

  // Header block — clearly identifies which policy this sheet belongs to.
  sheet.getCell('A1').value = 'Policy';
  sheet.getCell('A1').font = { bold: true };
  sheet.getCell('B1').value = args.policyName;
  sheet.getCell('A2').value = 'Hash';
  sheet.getCell('A2').font = { bold: true };
  sheet.getCell('B2').value = args.policyHash;
  sheet.getCell('A3').value = 'Label';
  sheet.getCell('A3').font = { bold: true };
  sheet.getCell('B3').value = args.label;
  sheet.getCell('A4').value = 'Threshold';
  sheet.getCell('A4').font = { bold: true };
  sheet.getCell('B4').value = args.threshold;
  sheet.getCell('A5').value = 'Run';
  sheet.getCell('A5').font = { bold: true };
  sheet.getCell('B5').value = `${args.runId} @ ${args.runAt}`;
  // Row 6 is intentionally left blank as a visual separator before the data table.

  // Set column widths
  for (let i = 0; i < POLICY_DATA_COLUMNS.length; i++) {
    sheet.getColumn(i + 1).width = POLICY_DATA_COLUMNS[i].width;
  }

  // Data header row
  const headerRow = sheet.getRow(POLICY_DATA_HEADER_ROW);
  for (let i = 0; i < POLICY_DATA_COLUMNS.length; i++) {
    headerRow.getCell(i + 1).value = POLICY_DATA_COLUMNS[i].header;
  }
  headerRow.font = { bold: true };

  // Data rows
  const sortedRows = [...args.rows].sort((a, b) => a.contentHash.localeCompare(b.contentHash));
  for (let i = 0; i < sortedRows.length; i++) {
    const r = sortedRows[i];
    const row = sheet.getRow(POLICY_DATA_HEADER_ROW + 1 + i);
    row.getCell(1).value = r.contentHash;
    row.getCell(2).value = r.workflowId ?? null;
    row.getCell(3).value = r.score;
    row.getCell(4).value = r.triggered;
    row.getCell(5).value = r.expectedTrigger;
    row.getCell(6).value = r.correct;
    row.getCell(7).value = r.verdictCategory;
    row.getCell(8).value = r.errorMessage ?? null;
  }

  // Freeze the metadata header + the data header row.
  sheet.views = [{ state: 'frozen', ySplit: POLICY_DATA_HEADER_ROW }];

  return sheetName;
}

/**
 * Write a fresh Legend sheet describing every column on the Summary and
 * per-policy detail sheets, plus the verdictCategory values and a quick
 * decision shortcut for "should I ship this candidate". Removes any
 * existing Legend sheet first so column changes never go stale.
 */
function writeLegendSheet(workbook: ExcelJS.Workbook): void {
  const existing = workbook.getWorksheet(LEGEND_SHEET);
  if (existing) workbook.removeWorksheet(existing.id);

  const sheet = workbook.addWorksheet(LEGEND_SHEET);
  sheet.getColumn(1).width = 22;
  sheet.getColumn(2).width = 110;

  let row = 1;
  const writeHeader = (text: string) => {
    sheet.getCell(row, 1).value = text;
    sheet.getCell(row, 1).font = { bold: true, size: 13 };
    sheet.mergeCells(row, 1, row, 2);
    row++;
  };
  const writeSubheader = (text: string) => {
    sheet.getCell(row, 1).value = text;
    sheet.getCell(row, 1).font = { bold: true };
    sheet.mergeCells(row, 1, row, 2);
    row++;
  };
  const writeKV = (key: string, value: string) => {
    sheet.getCell(row, 1).value = key;
    sheet.getCell(row, 1).font = { bold: true };
    sheet.getCell(row, 2).value = value;
    sheet.getCell(row, 2).alignment = { wrapText: true, vertical: 'top' };
    row++;
  };
  const blank = () => {
    row++;
  };

  writeHeader('Scanner Policies — workbook legend');
  blank();

  writeSubheader('Summary sheet columns');
  writeKV('policyName', 'Candidate name as shown in the moderator UI. Same value as the per-policy sheet\'s B1 cell.');
  writeKV('sheet', 'Name of this candidate\'s detail tab in this workbook (long names may get a hash suffix).');
  writeKV('policyHash', 'sha256(mode + label + threshold + policy text). Editing any of those mints a new hash → new Summary row.');
  writeKV('label', 'XGuard label this candidate targets (Young, Suggestive, Explicit, etc.). All rows share the dataset\'s label.');
  writeKV('threshold', 'Cutoff applied to score. triggered = (score >= threshold).');
  writeKV('testCases', 'Total rows scored. Equals input row count minus rows the orchestrator never returned a result for.');
  writeKV('tp', 'True positives — expectedTrigger=true AND triggered=true. Errors excluded.');
  writeKV('fp', 'False positives — expectedTrigger=false AND triggered=true. Cost.');
  writeKV('tn', 'True negatives — expectedTrigger=false AND triggered=false.');
  writeKV('fn', 'False negatives — expectedTrigger=true AND triggered=false. Cost.');
  writeKV('recall', 'tp / (tp + fn). Fraction of real triggers the policy catches. Higher = catches more.');
  writeKV('fpRate', 'fp / (fp + tn). Fraction of safe content that wrongly triggers. Lower = quieter.');
  writeKV('accuracy', '(tp + tn) / (testCases - errors). Overall correctness. Misleading on imbalanced data — use with recall + fpRate.');
  writeKV('fpFixed', 'vs baseline: baseline fired wrongly (FP) but this candidate did not. WIN.');
  writeKV('tpDropped', 'vs baseline: baseline caught correctly (TP) but this candidate missed. LOSS.');
  writeKV('tpRecovered', 'vs baseline: baseline missed (FN) but this candidate caught. WIN.');
  writeKV('tnNewlyFiring', 'vs baseline: baseline correctly did not fire (TN) but this candidate fired wrongly. LOSS.');
  writeKV('errors', 'Rows where scoring failed (orchestrator timeout, parse error, etc.). Excluded from tp/fp/tn/fn and the rates.');
  writeKV('runId', 'Which scoring run produced these numbers. Re-running against the same dataset overwrites this row.');
  writeKV('runAt', 'ISO timestamp the run started.');
  blank();

  writeSubheader('Per-policy detail sheet columns');
  writeKV('contentHash', 'Identifier joining back to the Test Cases sheet. XLOOKUP / VLOOKUP on Test Cases.contentHash.');
  writeKV('workflowId', 'Orchestrator workflow that produced this row. Paste into the orchestrator console to inspect.');
  writeKV('score', 'Raw probability returned by XGuard for this label.');
  writeKV('triggered', 'score >= threshold.');
  writeKV('expectedTrigger', 'Ground truth from the moderator-verdict majority for this contentHash.');
  writeKV('correct', 'triggered === expectedTrigger.');
  writeKV('verdictCategory', 'See verdictCategory table below.');
  writeKV('errorMessage', 'When verdictCategory=error: what went wrong. Often the label name the orchestrator returned vs the one we asked for.');
  blank();

  writeSubheader('verdictCategory values');
  writeKV('agree-trigger', 'Baseline and this candidate both triggered, and the row was a real positive. Win for both.');
  writeKV('agree-secure', 'Baseline and this candidate both did NOT trigger, and the row was a real negative. Win for both.');
  writeKV('fpFixed', 'Baseline fired wrongly here; this candidate correctly did not. New rule WIN.');
  writeKV('tpDropped', 'Baseline correctly fired here; this candidate missed it. New rule LOSS.');
  writeKV('tpRecovered', 'Baseline missed; this candidate caught. New rule WIN.');
  writeKV('tnNewlyFiring', 'Baseline correctly stayed silent; this candidate fired wrongly. New rule LOSS.');
  writeKV('no-baseline', 'Row was scored without a baseline in this run (only one candidate active). No vs-baseline comparison.');
  writeKV('error', 'Scoring failed for this row. See errorMessage. Excluded from all summary stats.');
  blank();

  writeSubheader('Quick decision rule for "should I ship this candidate?"');
  writeKV('Recall', 'Within ~3 points of baseline recall.');
  writeKV('fpRate', 'Improves by 5+ points vs baseline.');
  writeKV('TP costs', 'tpDropped ≤ 2 AND tpRecovered ≥ 3, OR fpFixed dominates the diff.');
  writeKV('Spot-check', 'Open this candidate\'s detail sheet, filter to fpFixed and tpRecovered rows, eyeball the prompts.');
  writeKV('Baseline', 'The first candidate in the active set (typically Live). The four vs-baseline columns are zero for the baseline itself.');
  blank();

  writeSubheader('Sheet roles');
  writeKV('Test Cases', 'Input rows + ground truth (contentHash, label, verdict, expectedTrigger, prompts). Built when the dataset was exported.');
  writeKV('Summary', 'One row per policyHash. Per-policy aggregates + vs-baseline deltas. Re-running updates rows in place.');
  writeKV('Legend', 'This sheet. Rewritten every run.');
  writeKV('<policy name>', 'Per-policy detail sheet. Header rows 1-5 identify the policy; row 7+ is the per-contentHash score table.');
  writeKV('_meta (hidden)', 'datasetId, mode, label, exportedAt. Used to reject mismatched uploads in older flows; safe to ignore.');

  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

function upsertSummarySheet(
  workbook: ExcelJS.Workbook,
  newRows: Array<SummaryStats & { sheetName: string }>
): void {
  let sheet = workbook.getWorksheet(SUMMARY_SHEET);
  if (!sheet) {
    sheet = workbook.addWorksheet(SUMMARY_SHEET);
    for (let i = 0; i < SUMMARY_COLUMNS.length; i++) {
      sheet.getColumn(i + 1).width = SUMMARY_COLUMNS[i].width;
    }
    const header = sheet.getRow(1);
    for (let i = 0; i < SUMMARY_COLUMNS.length; i++) {
      header.getCell(i + 1).value = SUMMARY_COLUMNS[i].header;
    }
    header.font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  }

  // Build column index from current header row (tolerates added/removed columns).
  const colIndex: Record<string, number> = {};
  const headerRow = sheet.getRow(1);
  for (let i = 1; i <= sheet.columnCount; i++) {
    const v = headerRow.getCell(i).value;
    if (typeof v === 'string') colIndex[v] = i;
  }

  // Map existing rows by policyHash so we update in place.
  const hashCol = colIndex.policyHash;
  const existingByHash = new Map<string, number>();
  if (hashCol) {
    for (let i = 2; i <= sheet.rowCount; i++) {
      const r = sheet.getRow(i);
      if (!r.hasValues) continue;
      const ph = String(r.getCell(hashCol).value ?? '');
      if (ph) existingByHash.set(ph, i);
    }
  }

  for (const s of newRows) {
    const targetRow = existingByHash.get(s.policyHash) ?? sheet.rowCount + 1;
    const accuracy = s.testCases - s.errors > 0 ? (s.tp + s.tn) / (s.testCases - s.errors) : 0;
    const recall = s.tp + s.fn > 0 ? s.tp / (s.tp + s.fn) : 0;
    const fpRate = s.fp + s.tn > 0 ? s.fp / (s.fp + s.tn) : 0;
    const values: Record<string, ExcelJS.CellValue> = {
      policyName: s.policyName,
      sheet: s.sheetName,
      policyHash: s.policyHash,
      label: s.label,
      threshold: s.threshold,
      testCases: s.testCases,
      tp: s.tp,
      fp: s.fp,
      tn: s.tn,
      fn: s.fn,
      recall: Number(recall.toFixed(4)),
      fpRate: Number(fpRate.toFixed(4)),
      accuracy: Number(accuracy.toFixed(4)),
      fpFixed: s.fpFixed,
      tpDropped: s.tpDropped,
      tpRecovered: s.tpRecovered,
      tnNewlyFiring: s.tnNewlyFiring,
      errors: s.errors,
      runId: s.runId,
      runAt: s.runAt,
    };
    for (const [k, v] of Object.entries(values)) {
      const idx = colIndex[k];
      if (idx) sheet.getRow(targetRow).getCell(idx).value = v;
    }
    sheet.getRow(targetRow).commit();
    existingByHash.set(s.policyHash, targetRow);
  }
}

/**
 * Write run results into the workbook as:
 *   - Summary: one row per policyHash (re-running a hash updates its row;
 *     new hashes append; historical hashes are left alone unless the
 *     candidate is archived — see `archivedPolicyHashes`).
 *   - One detail sheet per policy, headered with policy name / hash / label
 *     / threshold / run, then a contentHash-keyed per-row results table.
 *
 * `archivedPolicyHashes` (optional): hashes of candidates the moderator has
 * archived. Existing sheets and Summary rows for these hashes are removed
 * from the workbook during the merge, and any incoming results for them are
 * filtered out. This keeps an active workbook focused on the policies still
 * under active consideration.
 *
 * The legacy single "Results" sheet (from earlier runs) is removed when this
 * function fires so workbooks don't keep a stale view.
 */
export async function appendResultsToWorkbook(
  workbook: ExcelJS.Workbook,
  results: ScoredResultRow[],
  archivedPolicyHashes: Set<string> = new Set()
): Promise<Buffer> {
  // Drop the legacy single-sheet view from previous runs, if present.
  const legacy = workbook.getWorksheet(RESULTS_SHEET);
  if (legacy) workbook.removeWorksheet(legacy.id);

  // Always write a fresh Legend sheet describing every column in the workbook.
  // Cheap to regenerate each run so it stays in sync with the column set.
  writeLegendSheet(workbook);

  // Prune existing per-policy sheets whose policyHash has been archived.
  if (archivedPolicyHashes.size > 0) {
    const sheetsToRemove: number[] = [];
    const reserved = new Set([INPUT_SHEET, META_SHEET, SUMMARY_SHEET, LEGEND_SHEET, RESULTS_SHEET]);
    workbook.eachSheet((sheet) => {
      if (reserved.has(sheet.name)) return;
      const v = sheet.getCell('B2').value;
      if (typeof v === 'string' && archivedPolicyHashes.has(v)) {
        sheetsToRemove.push(sheet.id);
      }
    });
    for (const id of sheetsToRemove) workbook.removeWorksheet(id);

    // Prune Summary rows for archived hashes.
    const summarySheet = workbook.getWorksheet(SUMMARY_SHEET);
    if (summarySheet) {
      const headerRow = summarySheet.getRow(1);
      let hashCol = 0;
      for (let i = 1; i <= summarySheet.columnCount; i++) {
        if (headerRow.getCell(i).value === 'policyHash') {
          hashCol = i;
          break;
        }
      }
      if (hashCol) {
        // Walk bottom-up so row deletion doesn't shift indices we still need.
        for (let i = summarySheet.rowCount; i >= 2; i--) {
          const ph = String(summarySheet.getRow(i).getCell(hashCol).value ?? '');
          if (ph && archivedPolicyHashes.has(ph)) {
            summarySheet.spliceRows(i, 1);
          }
        }
      }
    }
  }

  // Filter the incoming results too — defensive in case an archived candidate
  // somehow made it into the run (shouldn't, but cheap guard).
  const liveResults =
    archivedPolicyHashes.size > 0
      ? results.filter((r) => !archivedPolicyHashes.has(r.policyHash))
      : results;

  // Group results by policyHash. Multiple rows in a run can share a hash
  // (one per contentHash); we use the first row's metadata for the policy
  // header (they're all the same for a given hash).
  const byHash = new Map<string, ScoredResultRow[]>();
  for (const r of liveResults) {
    if (!byHash.has(r.policyHash)) byHash.set(r.policyHash, []);
    byHash.get(r.policyHash)!.push(r);
  }

  const summaries: Array<SummaryStats & { sheetName: string }> = [];

  for (const [policyHash, rows] of byHash.entries()) {
    const first = rows[0];
    const sheetName = writePolicyDetailSheet({
      workbook,
      policyName: first.candidateName,
      policyHash,
      label: first.candidateLabel,
      threshold: first.candidateThreshold,
      policyText: first.candidatePolicy,
      runId: first.runId,
      runAt: first.runAt,
      rows,
    });

    const stats = computeStatsForPolicy(rows);
    summaries.push({
      ...stats,
      policyName: first.candidateName,
      policyHash,
      label: first.candidateLabel,
      threshold: first.candidateThreshold,
      runId: first.runId,
      runAt: first.runAt,
      sheetName,
    });
  }

  upsertSummarySheet(workbook, summaries);

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export function categorizeFlip(args: {
  expectedTrigger: boolean;
  candidateTriggered: boolean | null;
  baselineTriggered: boolean | null;
}): ScoredResultRow['verdictCategory'] {
  const { expectedTrigger, candidateTriggered, baselineTriggered } = args;
  if (candidateTriggered === null) return 'error';
  if (baselineTriggered === null) {
    if (candidateTriggered === expectedTrigger) {
      return expectedTrigger ? 'agree-trigger' : 'agree-secure';
    }
    return 'no-baseline';
  }
  if (candidateTriggered === baselineTriggered) {
    return candidateTriggered === expectedTrigger
      ? expectedTrigger
        ? 'agree-trigger'
        : 'agree-secure'
      : candidateTriggered
      ? 'no-baseline' // both wrongly fire — not a flip; logged as no-baseline-fix
      : 'no-baseline';
  }
  // Diverged from baseline. Classify by what the truth says.
  if (expectedTrigger) {
    return baselineTriggered ? 'tpDropped' : 'tpRecovered';
  }
  return baselineTriggered ? 'fpFixed' : 'tnNewlyFiring';
}

/**
 * Pick which candidate in a run plays the "baseline" role for verdictCategory.
 * Convention: the shipped candidate (if present and active OR present at all).
 * Falls back to the first candidate in the run.
 */
export function pickBaselineCandidate(
  candidates: ScannerPolicyCandidate[]
): ScannerPolicyCandidate | null {
  if (candidates.length === 0) return null;
  // Baseline is the first candidate in the run order (typically the live
  // policy if seeded first, otherwise just whatever's first). The vsBaseline
  // diff is meaningful only relative to that choice.
  return candidates[0] ?? null;
}

export const SCANNER_POLICY_SHEETS = {
  INPUT: INPUT_SHEET,
  META: META_SHEET,
  RESULTS: RESULTS_SHEET,
};
