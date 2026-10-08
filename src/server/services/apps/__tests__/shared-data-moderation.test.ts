import { createHash } from 'node:crypto';
import type * as FliptClientModule from '~/server/flipt/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BlockedContentHit } from '~/server/services/blocklist.service';

/**
 * The classifier and the recorder behind shared-storage `data` / counter-key moderation. The
 * detectors (`includesMinor`, `includesPoi`, `auditPromptEnriched`) run FOR REAL; only the
 * redis-backed list reads (blocklists, benign phrases), Flipt, ClickHouse and Axiom are mocked.
 */

const { mockFindBlocked, mockIsFlipt, mockInsert } = vi.hoisted(() => ({
  mockFindBlocked: vi.fn<
    (values: unknown, opts?: { exemptFromPatterns?: boolean }) => Promise<BlockedContentHit[]>
  >(async () => []),
  mockIsFlipt: vi.fn<(flag: string, entityId?: string, context?: unknown) => Promise<boolean>>(
    async () => false
  ),
  mockInsert: vi.fn<(args: { table: string; values: unknown[]; format: string }) => Promise<void>>(
    async () => undefined
  ),
}));

vi.mock('~/server/services/blocklist.service', () => ({
  findBlockedUserContent: (values: unknown, opts?: { exemptFromPatterns?: boolean }) =>
    mockFindBlocked(values, opts),
  // Identity: no moderator-declared benign phrase applies to these fixtures.
  stripBenignPhrases: async (text: string) => text,
}));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClientModule>()),
  isFlipt: (flag: string, entityId?: string, context?: unknown) =>
    mockIsFlipt(flag, entityId, context),
}));
const clickhouseBox = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock('~/server/clickhouse/client', () => ({
  get clickhouse() {
    return clickhouseBox.client;
  },
}));

import {
  blockingHit,
  classifySharedTexts,
  clickhouseDateTime64,
  recordSharedDataScan,
  resolveSharedDataModerationMode,
  scanCounterKey,
  scanSharedData,
  scheduleSharedDataShadow,
  SHARED_DATA_FULL_AUDIT_BUDGET,
  SHARED_DATA_HIT_TEXT_MAX_BYTES,
  SHARED_DATA_HITS_TABLE,
  sharedDataHitRows,
  truncateUtf8,
  type SharedTextScan,
} from '../shared-data-moderation';
import { auditPromptEnriched } from '~/utils/metadata/audit';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { normalizeText } from '~/utils/normalize-text';

// `~/server/logging/client` has a canonical mock registered globally (docs/testing/shared-module-mocks.md).
const mockLog = loggingMock.logToAxiom;

const SHADOW = 'app-blocks-shared-data-moderation';
const ENFORCE = 'app-blocks-shared-data-moderation-enforce';
const MINOR = '13 year old girl';

const leaf = (raw: string, path = 'x', kind: 'value' | 'key' = 'value') => ({ raw, path, kind });

beforeEach(() => {
  vi.clearAllMocks();
  mockFindBlocked.mockResolvedValue([]);
  mockIsFlipt.mockResolvedValue(false);
  clickhouseBox.client = { insert: mockInsert };
});

describe('resolveSharedDataModerationMode — two flags, enforce implies scan', () => {
  it.each([
    [false, false, 'off'],
    [true, false, 'shadow'],
    [false, true, 'enforce'],
    [true, true, 'enforce'],
  ] as const)('shadow=%s enforce=%s → %s', async (shadow, enforce, expected) => {
    mockIsFlipt.mockImplementation(async (flag) => (flag === SHADOW ? shadow : enforce));
    await expect(resolveSharedDataModerationMode('apb_one')).resolves.toBe(expected);
  });

  it('evaluates both flags PER APP: entityId = app block id, and NO context', async () => {
    await resolveSharedDataModerationMode('apb_one');
    expect(mockIsFlipt.mock.calls).toEqual([
      [SHADOW, 'apb_one', undefined],
      [ENFORCE, 'apb_one', undefined],
    ]);
  });
});

describe('classifySharedTexts — the local checks, one leaf at a time', () => {
  it('a clean leaf produces no hit', async () => {
    await expect(classifySharedTexts([leaf('a perfectly ordinary label')])).resolves.toEqual([]);
  });

  it('flags a minor term, with the leaf it came from', async () => {
    const hits = await classifySharedTexts([leaf('fine'), leaf(MINOR, 'y/0')]);
    expect(hits).toContainEqual({ category: 'minor', matched: 'minor', leaf: leaf(MINOR, 'y/0') });
    expect(hits.every((h) => h.leaf?.raw === MINOR)).toBe(true);
  });

  it('flags a POI name with the matched name', async () => {
    const hits = await classifySharedTexts([leaf('emma watson')]);
    expect(hits).toContainEqual(
      expect.objectContaining({ category: 'poi', matched: 'emma watson' })
    );
  });

  it('flags green-domain profanity as audit_regex (isGreen semantics)', async () => {
    const hits = await classifySharedTexts([leaf('fuck')]);
    expect(hits).toEqual([{ category: 'audit_regex', matched: 'fuck', leaf: leaf('fuck') }]);
  });

  it('🔴 REGRESSION: a term split by a format character is still caught', async () => {
    // Measured: unstripped, `lo\u200Bli` passes includesMinor and the audit, and `fu\u200Bck`
    // passes the audit — so these two fail if the Cf strip is dropped.
    const loli = await classifySharedTexts([leaf('lo\u200Bli')]);
    expect(loli.map((h) => h.category)).toContain('audit_regex');
    const profane = await classifySharedTexts([leaf('fu\u200Bck')]);
    expect(profane.map((h) => h.category)).toEqual(['audit_regex']);
    // The record keeps the raw leaf, not the stripped copy.
    expect(profane[0].leaf?.raw).toBe('fu\u200Bck');
  });

  it('🔴 a single leaf over the audit length ceiling is a hit, whatever the triggers say', async () => {
    const hits = await classifySharedTexts([leaf('a'.repeat(20_001))]);
    expect(hits.map((h) => h.category)).toEqual(['audit_regex']);
  });

  it('INVARIANT GUARD: the blocklist gets ONE call with the leaves as separate entries (never joined)', async () => {
    await classifySharedTexts([leaf('first leaf'), leaf('second\u200B leaf', 'y', 'key')]);
    expect(mockFindBlocked).toHaveBeenCalledTimes(1);
    expect(mockFindBlocked.mock.calls[0][0]).toEqual(['first leaf', 'second leaf']);
  });

  it('maps blocklist hits back to their leaf by index', async () => {
    mockFindBlocked.mockResolvedValue([
      { kind: 'link', index: 1, matched: ['bad.example', 'worse.example'] },
      { kind: 'pattern', index: 0, matched: 'scam phrase' },
    ]);
    const hits = await classifySharedTexts([leaf('zero'), leaf('one', 'k', 'key')]);
    expect(hits).toEqual([
      { category: 'pattern', matched: 'scam phrase', leaf: leaf('zero') },
      { category: 'link', matched: 'bad.example,worse.example', leaf: leaf('one', 'k', 'key') },
    ]);
  });

  it('exempts moderators from the PATTERN list only, as the title/body belt does', async () => {
    await classifySharedTexts([leaf('x')], { isModerator: true });
    expect(mockFindBlocked.mock.calls[0][1]).toEqual({ exemptFromPatterns: true });
    await classifySharedTexts([leaf('x')]);
    expect(mockFindBlocked.mock.calls[1][1]).toEqual({ exemptFromPatterns: false });
  });

  it('makes no blocklist read at all for an empty set', async () => {
    await expect(classifySharedTexts([])).resolves.toEqual([]);
    expect(mockFindBlocked).not.toHaveBeenCalled();
  });
});

describe('the profanity prefilter never changes the audit verdict', () => {
  // The fast path only asks the audit for its profanity step when the cached matcher already sees
  // profanity. Pinned over a corpus that includes the booru-tag cases the audit itself excuses.
  const corpus = [
    'fuck',
    'what the fuck',
    'shit happens',
    'assassin',
    'Scunthorpe',
    'cocktail party',
    'rating_explicit',
    'score_9, rating_explicit, 1girl',
    'rating_explicit, fuck',
    'source_anime',
    'bitch',
    'b1tch',
    'f u c k',
    'a calm landscape at dusk',
    'pussy cat',
    'dick van dyke',
  ];
  it.each(corpus)('%s', async (text) => {
    const full = auditPromptEnriched(normalizeText(text), undefined, true).success === false;
    const hits = await classifySharedTexts([leaf(text)]);
    expect(hits.some((h) => h.category === 'audit_regex')).toBe(full);
  });

  it('positive control: the corpus contains both verdicts', () => {
    const verdicts = corpus.map(
      (t) => auditPromptEnriched(normalizeText(t), undefined, true).success
    );
    expect(verdicts).toContain(true);
    expect(verdicts).toContain(false);
  });
});

describe('full-audit budget', () => {
  it(`audits the first ${SHARED_DATA_FULL_AUDIT_BUDGET} profane leaves fully, then reports overflow rather than passing the rest`, async () => {
    const texts = Array.from(
      { length: SHARED_DATA_FULL_AUDIT_BUDGET + 3 },
      (_, i) => `fuck number ${i}`
    );
    const scan = await scanSharedData(texts);
    const audited = scan.hits.filter((h) => h.category === 'audit_regex');
    const over = scan.hits.filter((h) => h.category === 'overflow');
    expect(audited).toHaveLength(SHARED_DATA_FULL_AUDIT_BUDGET);
    expect(over).toHaveLength(3);
    expect(over[0]).toMatchObject({
      matched: 'audit_budget',
      leaf: { raw: texts[SHARED_DATA_FULL_AUDIT_BUDGET] },
    });
    expect(scan.overflow).toBe('audit_budget');
    expect(blockingHit(scan)?.category).toBe('overflow');
  });

  it('clean leaves never spend the budget', async () => {
    // Spelled-out digits: green-domain profanity reads leetspeak (`455`) and consonant skeletons
    // (`prn`), so both of those spellings are genuine hits, not clean fixtures.
    const DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
    const word = (i: number) => [...String(i)].map((d) => DIGITS[Number(d)]).join(' ');
    const texts = Array.from({ length: 500 }, (_, i) => `clean label ${word(i)}`);
    const scan = await scanSharedData(texts);
    expect(scan).toEqual({ leafCount: 500, overflow: null, hits: [] });
  });
});

describe('scanSharedData / scanCounterKey', () => {
  it('reads keys, nested values and arrays 20 deep', async () => {
    let deep: unknown = MINOR;
    for (let i = 0; i < 20; i++) deep = [deep];
    const scan = await scanSharedData({ [MINOR]: 1, a: { b: deep } });
    const paths = scan.hits
      .filter((h) => h.category === 'minor')
      .map((h) => [h.leaf?.kind, h.leaf?.path]);
    // One distinct string → one leaf, attributed to its first occurrence: the key.
    expect(paths).toEqual([['key', MINOR]]);
    expect(scan.leafCount).toBe(3);
  });

  it('an over-cap blob is ONE overflow hit and no leaf is classified', async () => {
    let deep: unknown = 'x';
    for (let i = 0; i < 33; i++) deep = [deep];
    const scan = await scanSharedData(deep);
    expect(scan).toEqual({
      leafCount: 0,
      overflow: 'depth',
      hits: [{ category: 'overflow', matched: 'depth', leaf: null }],
    });
    expect(mockFindBlocked).not.toHaveBeenCalled();
  });

  it('no data → nothing read, nothing flagged', async () => {
    await expect(scanSharedData(undefined)).resolves.toEqual({
      leafCount: 0,
      overflow: null,
      hits: [],
    });
    expect(mockFindBlocked).not.toHaveBeenCalled();
  });

  it('a counter key is a single key leaf', async () => {
    const scan = await scanCounterKey(`playcount:${MINOR}`);
    expect(scan.leafCount).toBe(1);
    expect(scan.hits[0]).toMatchObject({ category: 'minor', leaf: { kind: 'key', path: '' } });
  });

  it('blockingHit picks the title/body priority: overflow, minor, poi, link, pattern, audit', () => {
    const scan: SharedTextScan = {
      leafCount: 2,
      overflow: null,
      hits: [
        { category: 'audit_regex', matched: 'a', leaf: leaf('a') },
        { category: 'link', matched: 'l', leaf: leaf('l') },
        { category: 'poi', matched: 'p', leaf: leaf('p') },
      ],
    };
    expect(blockingHit(scan)?.category).toBe('poi');
    expect(blockingHit({ leafCount: 0, overflow: null, hits: [] })).toBeNull();
  });
});

describe('recording', () => {
  const ctx = {
    appBlockId: 'apb_one',
    rowKey: 'ROW1',
    surface: 'append' as const,
    mode: 'shadow' as const,
    blocked: false,
  };

  it('writes one row per hit with the reviewable fields, text cut to 1 KB on a code point', async () => {
    const long = `${MINOR} ${'é'.repeat(800)}`;
    const scan = await scanSharedData({ notes: long });
    await recordSharedDataScan(scan, ctx);
    expect(mockInsert).toHaveBeenCalledTimes(1);
    const { table, values, format } = mockInsert.mock.calls[0][0];
    expect(table).toBe(SHARED_DATA_HITS_TABLE);
    expect(format).toBe('JSONEachRow');
    const row = (values as Array<Record<string, unknown>>).find((r) => r.category === 'minor')!;
    expect(row).toMatchObject({
      appBlockId: 'apb_one',
      rowKey: 'ROW1',
      surface: 'append',
      mode: 'shadow',
      blocked: 0,
      leafPath: 'notes',
      leafKind: 'value',
      leafLength: long.length,
      leafSha256: createHash('sha256').update(long, 'utf8').digest('hex'),
    });
    expect(Buffer.byteLength(String(row.leafText), 'utf8')).toBeLessThanOrEqual(
      SHARED_DATA_HIT_TEXT_MAX_BYTES
    );
    expect(long.startsWith(String(row.leafText))).toBe(true);
    expect(String(row.time)).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}$/);
  });

  it('emits ONE count-only denominator event — no leaf text and no matched term', async () => {
    const scan = await scanSharedData({ a: MINOR, b: 'emma watson', c: 'clean' });
    await recordSharedDataScan(scan, ctx);
    const scanEvents = mockLog.mock.calls.filter(
      ([p]) => (p as { name?: string }).name === 'app-blocks-shared-data-moderation-scan'
    );
    expect(scanEvents).toHaveLength(1);
    const [payload, stream] = scanEvents[0];
    expect(stream).toBe('block-audit');
    expect(payload).toMatchObject({ leafCount: 6, hitCount: scan.hits.length, minor: 1, poi: 1 });
    const serialized = JSON.stringify(payload);
    for (const text of [MINOR, 'emma watson', 'clean']) expect(serialized).not.toContain(text);
  });

  it('a scan with no hits still emits the denominator, and writes no rows', async () => {
    await recordSharedDataScan({ leafCount: 4, overflow: null, hits: [] }, ctx);
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app-blocks-shared-data-moderation-scan',
        leafCount: 4,
        hitCount: 0,
      }),
      'block-audit'
    );
  });

  it('with no ClickHouse client the rows are DROPPED — the text is never re-routed to a log', async () => {
    clickhouseBox.client = undefined;
    const scan = await scanSharedData({ a: MINOR });
    await recordSharedDataScan(scan, ctx);
    expect(JSON.stringify(mockLog.mock.calls)).not.toContain(MINOR);
  });

  it('an insert failure is swallowed and logged without the text', async () => {
    mockInsert.mockRejectedValueOnce(new Error('table missing'));
    const scan = await scanSharedData({ a: MINOR });
    await expect(recordSharedDataScan(scan, ctx)).resolves.toBeUndefined();
    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'app-blocks-shared-data-moderation-record-failed' }),
      'block-audit'
    );
    expect(JSON.stringify(mockLog.mock.calls)).not.toContain(MINOR);
  });

  it('an overflow row carries no leaf', () => {
    const [row] = sharedDataHitRows(
      {
        leafCount: 0,
        overflow: 'leaves',
        hits: [{ category: 'overflow', matched: 'leaves', leaf: null }],
      },
      ctx,
      new Date('2026-10-08T01:02:03.456Z')
    );
    expect(row).toMatchObject({
      time: '2026-10-08 01:02:03.456',
      leafText: '',
      leafSha256: '',
      leafPath: '',
    });
  });

  it('truncateUtf8 never splits a code point', () => {
    expect(truncateUtf8('aé', 2)).toBe('a');
    expect(truncateUtf8('🙂🙂', 5)).toBe('🙂');
    expect(truncateUtf8('short', 1024)).toBe('short');
    expect(clickhouseDateTime64(new Date('2026-01-02T03:04:05.006Z'))).toBe(
      '2026-01-02 03:04:05.006'
    );
  });
});

describe('scheduleSharedDataShadow', () => {
  it('INVARIANT GUARD: returns before the scan even starts — nothing runs on the caller’s tick', async () => {
    const run = vi.fn(async () => ({ leafCount: 0, overflow: null, hits: [] } as SharedTextScan));
    scheduleSharedDataShadow(run, { appBlockId: 'apb_one', rowKey: 'K', surface: 'append' });
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
    await new Promise((resolve) => setImmediate(resolve));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a failing scan is swallowed and logged', async () => {
    const run = vi.fn(async () => {
      throw new Error('boom');
    });
    scheduleSharedDataShadow(run, { appBlockId: 'apb_one', rowKey: 'K', surface: 'counter' });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app-blocks-shared-data-moderation-shadow-failed',
        surface: 'counter',
      }),
      'block-audit'
    );
  });
});
