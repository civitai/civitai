/**
 * The archive's file and manifest shapes, and the CSV encoding. Kept free of I/O so the column
 * policy and the counts can be tested without a database or a bucket.
 */

export type ExportSource = 'postgres' | 'clickhouse' | 'mongo' | 'stripe';

export type ManifestFile = {
  file: string;
  source: ExportSource;
  /** Records written to `file`, counted as they were written. */
  rows: number;
  description: string;
  /** `partial`: a cap or a time limit stopped the read; `unavailable`: the read failed or was skipped. */
  status: 'complete' | 'partial' | 'unavailable';
  /** Columns written, in order (CSV files). */
  columns?: string[];
};

export type ManifestCount = { name: string; source: ExportSource; count: number | null };

export type Manifest = {
  exportId: number;
  generatedAt: string;
  files: ManifestFile[];
  /** Activity counted by type rather than exported row by row. */
  activityCounts: ManifestCount[];
  /**
   * Categories of data that are not in the archive, and why. The same list for every account, with no
   * counts: what is listed must not tell the reader anything about their own account.
   */
  excluded: { category: string; reason: string }[];
  lines: string[];
};

/** Something a source writes a file into: the zip in production, a map in tests. */
export interface ExportWriter {
  addFile(name: string, content: AsyncIterable<string> | string): Promise<void>;
}

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s: string;
  if (value instanceof Date) s = value.toISOString();
  else if (typeof value === 'bigint') s = value.toString();
  else if (typeof value === 'object') s = JSON.stringify(value);
  else s = String(value);
  // Text starting =, +, - or @ is a formula in a spreadsheet: prefix it so the file opens as data.
  // Numbers are left alone, so -5 stays -5.
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvLine = (values: readonly unknown[]) => values.map(csvCell).join(',') + '\r\n';

/**
 * A CSV file as a stream of lines: the header, then every row of every page in order. `onRow` runs
 * once per row as it is written, which is what the manifest's count is.
 */
export async function* csvFile(
  columns: readonly string[],
  pages: AsyncIterable<readonly Record<string, unknown>[]>,
  onRow: () => void
): AsyncIterable<string> {
  yield csvLine(columns);
  for await (const page of pages) {
    let chunk = '';
    for (const row of page) {
      chunk += csvLine(columns.map((c) => row[c]));
      onRow();
    }
    if (chunk) yield chunk;
  }
}

/** A JSON Lines file, one record per line, counted the same way. */
export async function* jsonLinesFile(
  records: AsyncIterable<unknown>,
  onRow: () => void
): AsyncIterable<string> {
  for await (const record of records) {
    onRow();
    yield JSON.stringify(record) + '\n';
  }
}
