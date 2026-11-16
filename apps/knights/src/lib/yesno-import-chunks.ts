// Temporary: remove after the Knights v2 launch import

/** Rows per request. About 750 bytes a row puts a chunk near 300 KB, under the node adapter's 512 KB body limit. */
export const CHUNK_ROWS = 400;
/** The byte cap guards the limit when a file has unusually long questions. */
export const CHUNK_BYTES = 256 * 1024;

export type CsvChunk = { csv: string; rows: number };

const encoder = new TextEncoder();

/** Raw text of each record: a newline ends one only outside quotes. Empty lines are dropped, as the parser does. */
function recordsOf(text: string): string[] {
  const records: string[] = [];
  let start = 0;
  let quoted = false;
  const end = (to: number) => {
    const record = text.slice(start, to).replace(/\r$/, '');
    if (record !== '') records.push(record);
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (c === '\n' && !quoted) {
      end(i);
      start = i + 1;
    }
  }
  if (quoted) throw new Error('The file has an unterminated quote; fix it before importing.');
  end(text.length);
  return records;
}

/** Splits a CSV into chunks of at most `maxRows` records and `maxBytes` bytes, each starting with the header row. */
export function splitCsv(
  text: string,
  { maxRows = CHUNK_ROWS, maxBytes = CHUNK_BYTES }: { maxRows?: number; maxBytes?: number }
): { chunks: CsvChunk[]; rows: number } {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const [header, ...records] = recordsOf(source);
  if (header === undefined || records.length === 0) return { chunks: [], rows: 0 };

  const chunks: CsvChunk[] = [];
  let current: string[] = [];
  let bytes = encoder.encode(header).length;
  const flush = () => {
    if (current.length > 0)
      chunks.push({ csv: [header, ...current].join('\n'), rows: current.length });
    current = [];
    bytes = encoder.encode(header).length;
  };
  for (const record of records) {
    const size = encoder.encode(record).length + 1;
    if (current.length > 0 && (current.length >= maxRows || bytes + size > maxBytes)) flush();
    current.push(record);
    bytes += size;
  }
  flush();
  return { chunks, rows: records.length };
}

const RESULT_KEYS = [
  'inserted',
  'updated',
  'unchanged',
  'refused',
  'moderated',
  'retired',
] as const;
type ResultKey = (typeof RESULT_KEYS)[number];

/** One chunk's answer from `POST /admin/yesno-import`; `result` is absent on a dry run. */
export type ChunkResponse = {
  read: number;
  toImport: number;
  skipped: Record<string, number>;
  result?: Partial<Record<ResultKey, number>>;
};

export type ImportTotals = {
  read: number;
  toImport: number;
  skipped: Record<string, number>;
} & Record<ResultKey, number>;

export const emptyTotals = (): ImportTotals => ({
  read: 0,
  toImport: 0,
  inserted: 0,
  updated: 0,
  unchanged: 0,
  refused: 0,
  moderated: 0,
  retired: 0,
  skipped: {},
});

export function addChunk(totals: ImportTotals, chunk: ChunkResponse): ImportTotals {
  const next: ImportTotals = {
    ...totals,
    read: totals.read + chunk.read,
    toImport: totals.toImport + chunk.toImport,
    skipped: { ...totals.skipped },
  };
  for (const key of RESULT_KEYS) next[key] += chunk.result?.[key] ?? 0;
  for (const [reason, n] of Object.entries(chunk.skipped))
    next.skipped[reason] = (next.skipped[reason] ?? 0) + n;
  return next;
}

/** The order `toYesNoRows` declares its skip reasons in; a reason it adds later goes last. */
const SKIP_ORDER = [
  'inactive',
  'bad-id',
  'bad-image',
  'bad-axis',
  'bad-kind',
  'bad-question',
  'duplicate',
];
const rank = (reason: string) => {
  const at = SKIP_ORDER.indexOf(reason);
  return at === -1 ? SKIP_ORDER.length : at;
};

/** "9 (inactive 2, bad-image 4, ...)", or "0" when nothing was skipped. */
export function skippedText(skipped: Record<string, number>): string {
  const reasons = Object.entries(skipped)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => rank(a) - rank(b));
  const total = reasons.reduce((sum, [, n]) => sum + n, 0);
  return total === 0 ? '0' : `${total} (${reasons.map(([r, n]) => `${r} ${n}`).join(', ')})`;
}
