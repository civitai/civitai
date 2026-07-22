import { suggestedFeePerImage } from '$lib/monetization/fee';
import type { CsvVersionRow } from '$lib/server/models';

// CSV round-trip for bulk licensing-fee editing (early-access 2.2). The creator downloads their versions, edits a
// single per-image `fee` column in Excel/Sheets, and re-uploads. `versionId` is the immutable join key; the `fee`
// column is pre-filled with the current fee so untouched rows are no-ops and a blanked cell means "turn off".
const COLUMNS = [
  'versionId',
  'model',
  'version',
  'baseModel',
  'type',
  'recommendedFee',
  'fee',
] as const;

// UTF-8 BOM so Excel opens non-ASCII model names correctly.
const BOM = '﻿';

const csvCell = (v: string | number) => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function buildFeeCsv(rows: CsvVersionRow[]): string {
  const lines = [COLUMNS.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.versionId,
        r.modelName,
        r.versionName,
        r.baseModel,
        r.modelType,
        suggestedFeePerImage(r.modelType),
        r.licensingFee ?? '',
      ]
        .map(csvCell)
        .join(',')
    );
  }
  return BOM + lines.join('\r\n');
}

// Minimal RFC-4180 tokenizer: handles quoted fields, escaped "" quotes, and CRLF/LF line breaks.
function tokenize(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export type ParsedFeeEntry = { versionId: number; fee: number | null; row: number };
export type ParsedFeeCsv =
  | { ok: false; error: string }
  | { ok: true; rows: ParsedFeeEntry[]; errors: { row: number; reason: string }[] };

export function parseFeeCsv(text: string): ParsedFeeCsv {
  const grid = tokenize(text.replace(/^﻿/, ''));
  if (grid.length < 2) return { ok: false, error: 'The file has no data rows.' };
  const header = grid[0].map((h) => h.trim().toLowerCase());
  const idIdx = header.indexOf('versionid');
  const feeIdx = header.indexOf('fee');
  if (idIdx === -1 || feeIdx === -1)
    return {
      ok: false,
      error: 'The file must have "versionId" and "fee" columns — use the downloaded template.',
    };

  const rows: ParsedFeeEntry[] = [];
  const errors: { row: number; reason: string }[] = [];
  for (let i = 1; i < grid.length; i++) {
    const cells = grid[i];
    if (cells.every((c) => c.trim() === '')) continue;
    const rowNo = i + 1; // 1-based line number (the header is line 1)
    const idRaw = (cells[idIdx] ?? '').trim();
    const versionId = Number(idRaw);
    if (!Number.isInteger(versionId) || versionId <= 0) {
      errors.push({ row: rowNo, reason: `invalid versionId "${idRaw}"` });
      continue;
    }
    const feeRaw = (cells[feeIdx] ?? '').trim();
    let fee: number | null = null;
    if (feeRaw !== '') {
      const n = Number(feeRaw);
      if (!Number.isFinite(n)) {
        errors.push({ row: rowNo, reason: `invalid fee "${feeRaw}"` });
        continue;
      }
      fee = n === 0 ? null : n;
    }
    rows.push({ versionId, fee, row: rowNo });
  }
  return { ok: true, rows, errors };
}
