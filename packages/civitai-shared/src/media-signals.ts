import { createHash } from 'node:crypto';

/**
 * The signals that decide whether a moderator without the CSAM grant may see an image, read outside
 * Postgres: the scanner's ClickHouse labels and the private `Image.blockedFor` patterns. Server
 * only.
 */

export type ScannerVerdict = 'hit' | 'clear' | 'none';

/** The `contentHash` a scanner_label_results row is keyed by: the first 16 hex of sha256(input). */
export const scannerContentHash = (input: string) =>
  createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 16);

/** The `contentHash` an image's scan rows are written under. */
export const imageAuditContentHash = (imageId: number) => scannerContentHash(`image:${imageId}`);

/**
 * Per image, whether its scanner rows mark CSAM (`csamHit`). The audit write is best-effort and lands
 * after the verdict, so an image may have no rows at all (`scannerCsamVerdict` reads it as `none`).
 * Every scan writes at least its `nsfw_level` row.
 */
export const SCANNER_HITS_SQL = `
  SELECT contentHash, max(label = 'csam' AND triggered = 1) AS csamHit
  FROM scanner_label_results
  WHERE contentHash IN {hashes:Array(String)}
  GROUP BY contentHash
`;
/** The part of a ClickHouse client the scanner reader calls. */
export type ScannerClient = {
  query(args: {
    query: string;
    query_params: Record<string, unknown>;
    format: 'JSONEachRow';
    abort_signal?: AbortSignal;
    clickhouse_settings?: { max_execution_time?: number };
  }): Promise<{ json<T>(): Promise<T[]> }>;
};

const SCANNER_TIMEOUT_SECONDS = 3;

/**
 * The scanner's CSAM verdicts for each app's ClickHouse client: one image's, or many in one read.
 * Null when the client is missing or cannot answer in time; `onError` hears why. `deadline` makes
 * the client-side abort signal for a read, so each app can apply its own timeout switch.
 */
export function createScannerReader(
  getClient: () => ScannerClient | null | undefined,
  {
    onError,
    deadline,
  }: { onError: (e: unknown) => void; deadline: (ms: number) => AbortSignal | undefined }
) {
  type Row = { contentHash: string; csamHit?: number | boolean | string };
  async function readRows(imageIds: number[]): Promise<Row[] | null> {
    const client = getClient();
    if (!client) return null;
    try {
      const result = await client.query({
        query: SCANNER_HITS_SQL,
        query_params: { hashes: imageIds.map(imageAuditContentHash) },
        format: 'JSONEachRow',
        abort_signal: deadline((SCANNER_TIMEOUT_SECONDS + 1) * 1000),
        clickhouse_settings: { max_execution_time: SCANNER_TIMEOUT_SECONDS },
      });
      return await result.json<Row>();
    } catch (e) {
      onError(e);
      return null;
    }
  }
  return {
    async readScannerCsamVerdict(imageId: number) {
      const rows = await readRows([imageId]);
      return rows ? scannerCsamVerdict(imageId, rows) : null;
    },
    async readScannerCsamVerdicts(imageIds: number[]) {
      if (!imageIds.length) return new Map<number, ScannerVerdict>();
      const rows = await readRows(imageIds);
      return rows
        ? new Map(imageIds.map((id) => [id, scannerCsamVerdict(id, rows)] as const))
        : null;
    },
  };
}

/** One image's CSAM verdict from `SCANNER_HITS_SQL` rows: the CSAM label alone, for media access,
 *  where a minor label does not restrict a moderator. 'none' when the scanner has no rows for it. */
export function scannerCsamVerdict(
  id: number,
  rows: readonly { contentHash: string; csamHit?: number | boolean | string }[]
): ScannerVerdict {
  const row = rows.find((r) => r.contentHash === imageAuditContentHash(id));
  if (!row) return 'none';
  // A row without the column refuses: it cannot show the label is absent.
  if (row.csamHit === undefined) return 'hit';
  return Number(row.csamHit) === 1 || row.csamHit === true ? 'hit' : 'clear';
}

export type BlockedForPatterns = {
  signal: RegExp[];
  nonMinor: RegExp[];
  /** Minor-only reasons: a minor flag alone does not keep media from a moderator. Absent: none. */
  minor?: RegExp[];
};

const ALWAYS_NON_MINOR = new Set(['moderated', 'tos', 'ainotverified']);

/**
 * The private `Image.blockedFor` patterns: regex lines under a `# signal`, `# known-non-minor` or
 * `# minor` header; other `#` lines are comments. Null when absent, when a pattern sits
 * under no header, when one does not compile, or when it has no signal patterns:
 * the caller then reads every non-trivial value as a signal.
 */
export function parseBlockedForPatterns(raw: string | null | undefined): BlockedForPatterns | null {
  if (!raw?.trim()) return null;
  const patterns = { signal: [] as RegExp[], nonMinor: [] as RegExp[], minor: [] as RegExp[] };
  let section: RegExp[] | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    if (text === '# signal') section = patterns.signal;
    else if (text === '# known-non-minor') section = patterns.nonMinor;
    else if (text === '# minor') section = patterns.minor;
    else if (text.startsWith('#')) continue;
    else if (!section) return null;
    else
      try {
        section.push(new RegExp(text, 'u'));
      } catch {
        return null;
      }
  }
  // A list without its signals is damaged, whatever else it names.
  return patterns.signal.length ? patterns : null;
}

/** The private patterns read through `getRaw`, parsed once per value it returns. */
export function cachedBlockedForPatterns(getRaw: () => string | undefined) {
  let raw: string | undefined;
  let patterns: BlockedForPatterns | null = null;
  return () => {
    const next = getRaw();
    if (next !== raw) {
      raw = next;
      patterns = parseBlockedForPatterns(next);
    }
    return patterns;
  };
}

const normalizeBlockedForValue = (value: string) => value.normalize('NFKC').toLowerCase().trim();

/**
 * Whether `Image.blockedFor` keeps media to moderators cleared for CSAM review. It is free text, a
 * comma list of reasons, so the rule is an allowlist: a value is clean only if it matches no signal
 * pattern and is a known non-minor reason, a known-non-minor pattern, or a minor pattern (a minor
 * reason alone does not restrict). Anything else, including any value when the patterns are
 * missing, is a signal.
 */
export function blockedForSignal(
  blockedFor: string | null | undefined,
  patterns: BlockedForPatterns | null
): boolean {
  if (blockedFor == null) return false;
  const values = blockedFor.split(',').map(normalizeBlockedForValue).filter(Boolean);
  if (!values.length) return true;
  return values.some((value) => {
    if (patterns?.signal.some((re) => re.test(value))) return true;
    if (ALWAYS_NON_MINOR.has(value)) return false;
    const clean = [...(patterns?.nonMinor ?? []), ...(patterns?.minor ?? [])];
    return !clean.some((re) => re.test(value));
  });
}
