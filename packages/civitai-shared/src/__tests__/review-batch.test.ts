import { describe, expect, it, vi } from 'vitest';
import {
  blockedForSignal,
  cachedBlockedForPatterns,
  createScannerReader,
  imageAuditContentHash,
  parseBlockedForPatterns,
  SCANNER_HITS_SQL,
  scannerCsamVerdict,
  type ScannerClient,
} from '../media-signals';
import { isReviewBatchId, newReviewBatchId, parseReviewBatchRecord } from '../review-batch';

// Wire contract: ClickHouse already holds scan rows under these hashes. Changing the function
// orphans every stored row, and each image then reads as unscanned.
describe('imageAuditContentHash', () => {
  it('matches the hashes stored scan rows are keyed by', () => {
    expect(imageAuditContentHash(1)).toBe('d958978c84fa167c');
    expect(imageAuditContentHash(123)).toBe('5eaacd96ca0060b2');
    expect(imageAuditContentHash(2147483647)).toBe('984ec8d802c32865');
  });
});

describe('scannerCsamVerdict', () => {
  it('reads the CSAM label alone: a minor-only hit is clear, no rows is none', () => {
    const rows = [
      { contentHash: imageAuditContentHash(1), csamHit: 1 },
      { contentHash: imageAuditContentHash(2), csamHit: 0 },
    ];
    expect(scannerCsamVerdict(1, rows)).toBe('hit');
    expect(scannerCsamVerdict(2, rows)).toBe('clear');
    expect(scannerCsamVerdict(3, rows)).toBe('none');
  });

  it('refuses a row read without the CSAM column', () => {
    expect(scannerCsamVerdict(1, [{ contentHash: imageAuditContentHash(1) }])).toBe('hit');
    expect(SCANNER_HITS_SQL).toMatch(/AS csamHit/);
  });
});

// Placeholder patterns: the real list is private and never in the repo.
const PATTERNS = parseBlockedForPatterns(
  '# header comment\n# signal\n^sig.*$\n# known-non-minor\n^benign$\n^bene.*$\n'
)!;

describe('blockedForSignal', () => {
  it('no blockedFor is no signal', () => {
    expect(blockedForSignal(null, PATTERNS)).toBe(false);
  });

  it('the fixed non-minor reasons and known-non-minor patterns are clean', () => {
    expect(blockedForSignal('moderated', PATTERNS)).toBe(false);
    expect(blockedForSignal('TOS', PATTERNS)).toBe(false);
    expect(blockedForSignal('AiNotVerified', PATTERNS)).toBe(false);
    expect(blockedForSignal(' Benign , moderated', PATTERNS)).toBe(false);
  });

  it('an unknown value, a signal value, or one bad value in a list is a signal', () => {
    expect(blockedForSignal('CSAM', PATTERNS)).toBe(true);
    expect(blockedForSignal('never seen', PATTERNS)).toBe(true);
    expect(blockedForSignal('benign,signal word', PATTERNS)).toBe(true);
    expect(blockedForSignal('', PATTERNS)).toBe(true);
  });

  it('a signal pattern wins over a known-non-minor one', () => {
    const both = parseBlockedForPatterns('# signal\n^bene$\n# known-non-minor\n^bene$')!;
    expect(blockedForSignal('bene', both)).toBe(true);
  });

  it('a minor-only reason is clean, unless a signal pattern also matches it', () => {
    const minor = parseBlockedForPatterns('# signal\n^sig.*$\n# minor\n^minor-.*$\n^sig-minor$')!;
    expect(blockedForSignal('minor-a', minor)).toBe(false);
    expect(blockedForSignal('minor-a, moderated', minor)).toBe(false);
    expect(blockedForSignal('sig-minor', minor)).toBe(true);
    expect(blockedForSignal('minor-a,never seen', minor)).toBe(true);
  });

  it('a minor-only reason is a signal while the patterns have no minor section', () => {
    expect(blockedForSignal('minor-a', PATTERNS)).toBe(true);
  });

  it('without patterns, every value but the fixed reasons is a signal', () => {
    expect(blockedForSignal('benign', null)).toBe(true);
    expect(blockedForSignal('moderated', null)).toBe(false);
  });

  it('refuses a pattern list it cannot read, so the caller fails closed', () => {
    expect(parseBlockedForPatterns(undefined)).toBeNull();
    expect(parseBlockedForPatterns('^no header$')).toBeNull();
    expect(parseBlockedForPatterns('# signal\n(unclosed')).toBeNull();
  });
});

describe('review batch ids and records', () => {
  it('a new id is 22 base64url characters and two are not equal', () => {
    const id = newReviewBatchId();
    expect(isReviewBatchId(id)).toBe(true);
    expect(id).not.toBe(newReviewBatchId());
    expect(isReviewBatchId(`${id}x`)).toBe(false);
  });

  const record = {
    ids: [1, 2],
    tier: 'general',
    declared: false,
    viewer: 5,
    createdBy: 6,
    keyId: 7,
    seat: null,
    createdAt: 1,
  };

  it('reads a well-formed record and refuses a damaged one', () => {
    expect(parseReviewBatchRecord(JSON.stringify(record))).toEqual(record);
    expect(parseReviewBatchRecord(JSON.stringify({ ...record, tier: 'other' }))).toBeNull();
    expect(parseReviewBatchRecord(JSON.stringify({ ...record, ids: [] }))).toBeNull();
    expect(parseReviewBatchRecord(JSON.stringify({ ...record, ids: [1.5] }))).toBeNull();
    expect(parseReviewBatchRecord(JSON.stringify({ ...record, declared: 'no' }))).toBeNull();
    expect(parseReviewBatchRecord('{')).toBeNull();
    expect(parseReviewBatchRecord(null)).toBeNull();
  });
});

describe('cachedBlockedForPatterns', () => {
  it('parses once per value, and again when the value changes', () => {
    let raw = '# signal\n^a$';
    const read = cachedBlockedForPatterns(() => raw);
    const first = read();
    expect(read()).toBe(first);
    raw = '# signal\n^b$';
    expect(read()).not.toBe(first);
    expect(read()?.signal[0].source).toBe('^b$');
  });
});

describe('createScannerReader', () => {
  const rowsFor = (hits: Record<number, number>) =>
    Object.entries(hits).map(([id, csamHit]) => ({
      contentHash: imageAuditContentHash(Number(id)),
      csamHit,
    }));
  const client = (rows: unknown[] | Error) => {
    const query = vi.fn(async () => {
      if (rows instanceof Error) throw rows;
      return { json: async () => rows };
    });
    return { client: { query } as unknown as ScannerClient, query };
  };

  it('reads each verdict in one bounded query, telling a hit, a clear and no rows apart', async () => {
    const { client: c, query } = client(rowsFor({ 1: 1, 2: 0 }));
    const deadline = vi.fn(() => undefined);
    const reader = createScannerReader(() => c, { onError: vi.fn(), deadline });
    expect(await reader.readScannerCsamVerdicts([1, 2, 3])).toEqual(
      new Map([
        [1, 'hit'],
        [2, 'clear'],
        [3, 'none'],
      ])
    );
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({ clickhouse_settings: { max_execution_time: 3 } })
    );
    expect(deadline).toHaveBeenCalledWith(4000);
  });

  it('answers null, never a verdict, when the client is missing or fails', async () => {
    const onError = vi.fn();
    const failing = client(new Error('timeout'));
    const reader = createScannerReader(() => failing.client, {
      onError,
      deadline: () => undefined,
    });
    expect(await reader.readScannerCsamVerdict(1)).toBeNull();
    expect(await reader.readScannerCsamVerdicts([1])).toBeNull();
    expect(onError).toHaveBeenCalled();
    const missing = createScannerReader(() => undefined, { onError, deadline: () => undefined });
    expect(await missing.readScannerCsamVerdict(1)).toBeNull();
  });

  it('sends no query for no images', async () => {
    const { client: c, query } = client([]);
    const reader = createScannerReader(() => c, { onError: vi.fn(), deadline: () => undefined });
    expect(await reader.readScannerCsamVerdicts([])).toEqual(new Map());
    expect(query).not.toHaveBeenCalled();
  });
});
