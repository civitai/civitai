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
  recordSharedDataScan,
  resolveSharedDataModerationMode,
  scanCounterKey,
  scanSharedData,
  scheduleSharedDataShadow,
  SHARED_DATA_FULL_AUDIT_BUDGET,
  SHARED_DATA_HIT_PATH_KEY_HASH_CHARS,
  SHARED_DATA_HIT_PATH_MAX_BYTES,
  SHARED_DATA_HIT_TEXT_MAX_BYTES,
  SHARED_DATA_HITS_TABLE,
  sharedDataHitRows,
  structuralLeafPath,
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

const leaf = (raw: string, path = 'x', kind: 'value' | 'key' = 'value') => ({
  raw,
  path,
  segments: path ? path.split('/') : [],
  kind,
});

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
    expect(hits).toContainEqual({
      category: 'minor',
      matched: 'minor',
      label: 'minor',
      leaf: leaf(MINOR, 'y/0'),
    });
    expect(hits.every((h) => h.leaf?.raw === MINOR)).toBe(true);
  });

  it('flags a POI name with the matched name', async () => {
    const hits = await classifySharedTexts([leaf('emma watson')]);
    expect(hits).toContainEqual(
      expect.objectContaining({ category: 'poi', matched: 'emma watson', label: 'emma watson' })
    );
  });

  it('flags green-domain profanity as audit_regex (isGreen semantics)', async () => {
    const hits = await classifySharedTexts([leaf('fuck')]);
    // `matched` is the input's word; `label` is the audit trigger's category (platform-authored).
    expect(hits).toEqual([
      { category: 'audit_regex', matched: 'fuck', label: 'profanity', leaf: leaf('fuck') },
    ]);
  });

  it('🔴 REGRESSION: a term split by a format character is still caught', async () => {
    // Measured: unstripped, `lo\u200Bli` passes includesMinor and the audit, and `fu\u200Bck`
    // passes the audit — so these two fail if the Cf strip is dropped.
    const loli = await classifySharedTexts([leaf('lo\u200Bli')]);
    expect(loli.map((h) => h.category)).toContain('audit_regex');
    const profane = await classifySharedTexts([leaf('fu\u200Bck')]);
    expect(profane.map((h) => h.category)).toEqual(['audit_regex']);
    // ...and the invisibles that are not \p{Cf}: Hangul filler, combining grapheme joiner,
    // variation selectors (BMP and supplementary).
    for (const split of ['fu\u3164ck', 'fu\u034Fck', 'fu\uFE0Fck', 'fu\u{E0100}ck']) {
      const hits = await classifySharedTexts([leaf(split)]);
      expect(hits.map((h) => h.category)).toEqual(['audit_regex']);
    }
    // A KEY leaf goes through the same strip (the walker hands keys over raw, like values).
    const key = await classifySharedTexts([leaf('fu\u200Bck', 'tags/fu\u200Bck', 'key')]);
    expect(key.map((h) => h.category)).toEqual(['audit_regex']);
    // The record keeps the raw leaf, not the stripped copy.
    expect(profane[0].leaf?.raw).toBe('fu\u200Bck');
  });

  it('INVARIANT GUARD: the strip leaves ordinary text and other categories alone', async () => {
    await classifySharedTexts([leaf('plain text, émoji 🙂 and\ttabs')]);
    expect(mockFindBlocked.mock.calls[0][0]).toEqual(['plain text, émoji 🙂 and\ttabs']);
  });

  it('🔴 a single leaf over the audit length ceiling is an OVERFLOW hit — unreviewable, not a content signal', async () => {
    const hits = await classifySharedTexts([leaf('a'.repeat(20_001))]);
    expect(hits).toEqual([
      {
        category: 'overflow',
        matched: 'leaf_length',
        label: 'leaf_length',
        leaf: leaf('a'.repeat(20_001)),
      },
    ]);
    // ...and exactly AT the ceiling it is audited normally (a clean leaf passes).
    await expect(classifySharedTexts([leaf('a '.repeat(10_000))])).resolves.toEqual([]);
  });

  it('a scan carrying a too-long leaf reports the overflow kind', async () => {
    const scan = await scanSharedData({ big: 'a'.repeat(20_001) });
    expect(scan.overflow).toBe('leaf_length');
    expect(blockingHit(scan)?.category).toBe('overflow');
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
      // A pattern's `matched` is the list ENTRY, so it is its own label; a link's is the user's
      // URL, so its label is empty.
      { category: 'pattern', matched: 'scam phrase', label: 'scam phrase', leaf: leaf('zero') },
      {
        category: 'link',
        matched: 'bad.example,worse.example',
        label: '',
        leaf: leaf('one', 'k', 'key'),
      },
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

describe('full-audit budget — only profane-looking leaves spend it', () => {
  it('a profane leaf AFTER many clean ones is still fully audited (clean leaves did not drain the budget)', async () => {
    const DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
    const word = (i: number) => [...String(i)].map((d) => DIGITS[Number(d)]).join(' ');
    const texts = [...Array.from({ length: 500 }, (_, i) => `clean label ${word(i)}`), 'fuck'];
    const scan = await scanSharedData(texts);
    expect(scan.overflow).toBeNull();
    expect(scan.hits).toEqual([
      {
        category: 'audit_regex',
        matched: 'fuck',
        label: 'profanity',
        leaf: { raw: 'fuck', path: '500', segments: [500], kind: 'value' },
      },
    ]);
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
      hits: [{ category: 'overflow', matched: 'depth', label: 'depth', leaf: null }],
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

  it('blockingHit attributes minor/POI first, ahead even of an overflow, then overflow, link, pattern, audit', () => {
    const scan: SharedTextScan = {
      leafCount: 2,
      overflow: 'leaf_length',
      hits: [
        { category: 'audit_regex', matched: 'a', label: 'a', leaf: leaf('a') },
        { category: 'overflow', matched: 'leaf_length', label: 'leaf_length', leaf: leaf('o') },
        { category: 'link', matched: 'l', label: 'l', leaf: leaf('l') },
        { category: 'poi', matched: 'p', label: 'p', leaf: leaf('p') },
      ],
    };
    expect(blockingHit(scan)?.category).toBe('poi');
    expect(
      blockingHit({ ...scan, hits: scan.hits.filter((h) => h.category !== 'poi') })?.category
    ).toBe('overflow');
    expect(blockingHit({ leafCount: 0, overflow: null, hits: [] })).toBeNull();
  });

  it('blockingHit skips a pattern hit unless patterns are enforced — and only that category', () => {
    const scan: SharedTextScan = {
      leafCount: 2,
      overflow: null,
      hits: [
        { category: 'pattern', matched: 'p', label: 'p', leaf: leaf('p') },
        { category: 'audit_regex', matched: 'a', label: 'a', leaf: leaf('a') },
      ],
    };
    expect(blockingHit(scan, { enforcePatterns: true })?.category).toBe('pattern');
    expect(blockingHit(scan, { enforcePatterns: false })?.category).toBe('audit_regex');
    expect(blockingHit({ ...scan, hits: [scan.hits[0]] }, { enforcePatterns: false })).toBeNull();
  });

  it('scheduleSharedDataShadow catches a SYNCHRONOUS throw from the scan thunk', async () => {
    scheduleSharedDataShadow(
      () => {
        throw new SyntaxError('bad json');
      },
      { appBlockId: 'apb_one', rowKey: 'K', surface: 'append' }
    );
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app-blocks-shared-data-moderation-shadow-failed',
        error: 'SyntaxError',
      }),
      'block-audit'
    );
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

  /** Every string column of every row, so an assertion cannot miss a column added later. */
  const stringColumns = (rows: Array<Record<string, unknown>>) =>
    rows.flatMap((r) =>
      Object.entries(r).flatMap(([column, v]) => (typeof v === 'string' ? [[column, v]] : []))
    );
  /** Columns (by name) of `rows` holding any of `texts` as a substring. */
  const columnsCarrying = (rows: Array<Record<string, unknown>>, texts: string[]) =>
    stringColumns(rows)
      .filter(([, v]) => texts.some((t) => v.includes(t)))
      .map(([column]) => column);
  const enforce = { ...ctx, mode: 'enforce' as const, blocked: true };
  const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

  it('🔴 an ENFORCE-mode row carries NO leaf text — hash, label and metadata only', async () => {
    const scan = await scanSharedData({ notes: MINOR });
    const rows = sharedDataHitRows(scan, enforce);
    const row = rows.find((r) => r.category === 'minor')!;
    expect(row).toMatchObject({
      mode: 'enforce',
      blocked: 1,
      matched: 'minor',
      rowKey: '',
      rowKeySha256: sha('ROW1'),
      leafPath: `#${sha('notes').slice(0, SHARED_DATA_HIT_PATH_KEY_HASH_CHARS)}`,
      leafLength: MINOR.length,
      leafSha256: sha(MINOR),
      leafText: '',
    });
    expect(columnsCarrying(rows, [MINOR, 'notes'])).toEqual([]);
    // Control: the SAME scan recorded in shadow mode does carry the text, the key and the path.
    const shadowRow = sharedDataHitRows(scan, ctx).find((r) => r.category === 'minor')!;
    expect(shadowRow).toMatchObject({ leafText: MINOR, leafPath: 'notes', rowKey: 'ROW1' });
  });

  it('🔴 enforce, COUNTER KEY: the flagged key is in no column — rowKey is empty, its hash joins', async () => {
    const key = `playcount:${MINOR}`;
    const scan = await scanCounterKey(key);
    const counterCtx = { ...enforce, rowKey: key, surface: 'counter' as const };
    const rows = sharedDataHitRows(scan, counterCtx);
    expect(rows.length).toBeGreaterThan(0);
    expect(columnsCarrying(rows, [key, MINOR, 'playcount'])).toEqual([]);
    for (const row of rows) {
      expect(row).toMatchObject({ rowKey: '', rowKeySha256: sha(key), leafSha256: sha(key) });
    }
    // Positive control: shadow mode stores the key (rowKey) and the text.
    expect(
      columnsCarrying(sharedDataHitRows(scan, { ...counterCtx, mode: 'shadow' }), [key])
    ).toEqual(expect.arrayContaining(['rowKey', 'leafText']));
  });

  it('🔴 enforce, flagged OBJECT KEY nested in data: no column carries any user-written key', async () => {
    const outer = 'my private bucket';
    const flaggedKey = `tag ${MINOR}`;
    const data = { [outer]: [{ [flaggedKey]: 1 }] };
    const scan = await scanSharedData(data);
    const rows = sharedDataHitRows(scan, enforce);
    const keyRow = rows.find((r) => r.leafKind === 'key' && r.category === 'minor')!;
    expect(keyRow).toBeDefined();
    expect(columnsCarrying(rows, [outer, flaggedKey, MINOR])).toEqual([]);
    // The path keeps its STRUCTURE: hashed key / array index / hashed key.
    const h = (t: string) => `#${sha(t).slice(0, SHARED_DATA_HIT_PATH_KEY_HASH_CHARS)}`;
    expect(keyRow.leafPath).toBe(`${h(outer)}/0/${h(flaggedKey)}`);
    expect(keyRow.leafSha256.startsWith(h(flaggedKey).slice(1))).toBe(true);
    // Positive control: shadow mode carries the raw path and the key text.
    expect(
      sharedDataHitRows(scan, ctx).find((r) => r.leafKind === 'key' && r.category === 'minor')
    ).toMatchObject({ leafPath: `${outer}/0/${flaggedKey}`, leafText: flaggedKey });
  });

  it('🔴 enforce, flagged VALUE under a user-key path: neither the value nor the keys survive', async () => {
    const keyA = 'alpha notebook';
    const keyB = 'zeta 0';
    const value = `${MINOR} at the park`;
    const scan = await scanSharedData({ [keyA]: { [keyB]: [{ note: value }] } });
    const rows = sharedDataHitRows(scan, enforce);
    const valueRow = rows.find((r) => r.leafKind === 'value' && r.category === 'minor')!;
    expect(valueRow).toBeDefined();
    expect(columnsCarrying(rows, [keyA, keyB, value, MINOR, 'note'])).toEqual([]);
    const h = (t: string) => `#${sha(t).slice(0, SHARED_DATA_HIT_PATH_KEY_HASH_CHARS)}`;
    expect(valueRow.leafPath).toBe(`${h(keyA)}/${h(keyB)}/0/${h('note')}`);
    expect(sharedDataHitRows(scan, ctx).find((r) => r.leafKind === 'value')).toMatchObject({
      leafText: value,
      leafPath: `${keyA}/${keyB}/0/note`,
    });
  });

  it('🔴 enforce: a matched term that is a SUBSTRING OF THE LEAF (link, audit) is replaced by its label', async () => {
    const url = 'https://evil.example/path-only-the-user-wrote';
    mockFindBlocked.mockResolvedValue([{ kind: 'link', index: 1, matched: [url] }]);
    const scan = await scanSharedData({ a: 'what the fuck', b: `see ${url}` });
    const rows = sharedDataHitRows(scan, enforce);
    expect(rows.map((r) => [r.category, r.matched]).sort()).toEqual(
      [
        ['audit_regex', 'profanity'],
        ['link', ''],
      ].sort()
    );
    expect(columnsCarrying(rows, [url, 'evil.example', 'fuck'])).toEqual([]);
    // Positive control: shadow stores the detector's own term, which IS user text.
    const shadowRows = sharedDataHitRows(scan, ctx);
    expect(shadowRows.find((r) => r.category === 'link')?.matched).toBe(url);
    expect(shadowRows.find((r) => r.category === 'audit_regex')?.matched).toBe('fuck');
  });

  it('enforce keeps a PLATFORM-authored matched term: the POI list word and a blocklist entry', async () => {
    mockFindBlocked.mockResolvedValue([{ kind: 'pattern', index: 0, matched: 'list entry' }]);
    const scan = await scanSharedData({ a: 'a list entry here', b: 'emma watson' });
    const rows = sharedDataHitRows(scan, enforce);
    expect(rows.find((r) => r.category === 'pattern')?.matched).toBe('list entry');
    expect(rows.find((r) => r.category === 'poi')?.matched).toBe('emma watson');
  });

  it('structuralLeafPath keeps indices, hashes keys, and never confuses key "0" with index 0', () => {
    expect(structuralLeafPath([])).toBe('');
    expect(structuralLeafPath([0, 12])).toBe('0/12');
    expect(structuralLeafPath(['0'])).toBe(
      `#${sha('0').slice(0, SHARED_DATA_HIT_PATH_KEY_HASH_CHARS)}`
    );
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

  it('the leaf path is cut too — it is built from user-authored keys', async () => {
    const key = 'k'.repeat(4000);
    const scan = await scanSharedData({ [key]: MINOR });
    const [row] = sharedDataHitRows(scan, ctx).filter((r) => r.leafKind === 'value');
    expect(Buffer.byteLength(row.leafPath, 'utf8')).toBeLessThanOrEqual(
      SHARED_DATA_HIT_PATH_MAX_BYTES
    );
    expect(key.startsWith(row.leafPath)).toBe(true);
  });

  it('an overflow row carries no leaf', () => {
    const [row] = sharedDataHitRows(
      {
        leafCount: 0,
        overflow: 'leaves',
        hits: [{ category: 'overflow', matched: 'leaves', label: 'leaves', leaf: null }],
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
