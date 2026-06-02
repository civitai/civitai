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
};

const RESULT_COLUMNS: Array<{ header: string; key: keyof ScoredResultRow; width: number }> = [
  { header: 'contentHash', key: 'contentHash', width: 20 },
  { header: 'candidateName', key: 'candidateName', width: 36 },
  { header: 'candidateLabel', key: 'candidateLabel', width: 16 },
  { header: 'candidateThreshold', key: 'candidateThreshold', width: 14 },
  { header: 'policyHash', key: 'policyHash', width: 20 },
  { header: 'score', key: 'score', width: 10 },
  { header: 'triggered', key: 'triggered', width: 10 },
  { header: 'expectedTrigger', key: 'expectedTrigger', width: 14 },
  { header: 'correct', key: 'correct', width: 10 },
  { header: 'verdictCategory', key: 'verdictCategory', width: 18 },
  { header: 'errorMessage', key: 'errorMessage', width: 40 },
  { header: 'runId', key: 'runId', width: 22 },
  { header: 'runAt', key: 'runAt', width: 22 },
  { header: 'candidatePolicy', key: 'candidatePolicy', width: 60 },
];

/**
 * Merge per-row results into the workbook's `Results` sheet.
 *
 * Merge semantics:
 *   - Same (contentHash, policyHash) → row is overwritten
 *   - New (contentHash, policyHash) → appended
 *   - Existing rows whose policyHash isn't in the current `candidates` list
 *     are LEFT ALONE — they're historical evidence the mod wants to see.
 */
export async function appendResultsToWorkbook(
  workbook: ExcelJS.Workbook,
  results: ScoredResultRow[]
): Promise<Buffer> {
  let sheet = workbook.getWorksheet(RESULTS_SHEET);
  if (!sheet) {
    sheet = workbook.addWorksheet(RESULTS_SHEET);
    sheet.columns = RESULT_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  } else {
    // Sheet already exists — make sure columns are aligned (don't reorder
    // existing data, just confirm key→column mapping). If columns is empty,
    // populate from the headers we expect.
    if (!sheet.columns || sheet.columns.length === 0) {
      sheet.columns = RESULT_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
    }
  }

  // Build a fast lookup: existing rowNumber by (contentHash, policyHash) so we
  // can overwrite in place.
  const headerRow = sheet.getRow(1);
  const colIndex: Record<string, number> = {};
  for (let i = 1; i <= sheet.columnCount; i++) {
    const v = headerRow.getCell(i).value;
    if (typeof v === 'string') colIndex[v] = i;
  }
  // Force-add any missing columns (e.g. workbook authored before a new field).
  let nextCol = sheet.columnCount + 1;
  for (const col of RESULT_COLUMNS) {
    if (!colIndex[col.header]) {
      sheet.getRow(1).getCell(nextCol).value = col.header;
      sheet.getRow(1).getCell(nextCol).font = { bold: true };
      const sheetCol = sheet.getColumn(nextCol);
      sheetCol.key = col.key;
      sheetCol.width = col.width;
      colIndex[col.header] = nextCol;
      nextCol++;
    }
  }

  const existingByKey = new Map<string, number>();
  for (let i = 2; i <= sheet.rowCount; i++) {
    const row = sheet.getRow(i);
    if (!row.hasValues) continue;
    const ch = String(row.getCell(colIndex.contentHash).value ?? '');
    const ph = String(row.getCell(colIndex.policyHash).value ?? '');
    if (!ch || !ph) continue;
    existingByKey.set(`${ch}|${ph}`, i);
  }

  for (const r of results) {
    const key = `${r.contentHash}|${r.policyHash}`;
    const targetRow = existingByKey.get(key) ?? sheet.rowCount + 1;
    for (const col of RESULT_COLUMNS) {
      const idx = colIndex[col.header];
      if (!idx) continue;
      const v = (r as unknown as Record<string, unknown>)[col.key];
      sheet.getRow(targetRow).getCell(idx).value =
        v === undefined ? null : (v as ExcelJS.CellValue);
    }
    sheet.getRow(targetRow).commit();
    existingByKey.set(key, targetRow);
  }

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
  return candidates.find((c) => c.status === 'shipped') ?? candidates[0];
}

export const SCANNER_POLICY_SHEETS = {
  INPUT: INPUT_SHEET,
  META: META_SHEET,
  RESULTS: RESULTS_SHEET,
};
