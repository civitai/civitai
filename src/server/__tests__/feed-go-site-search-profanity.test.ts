/**
 * feed-go's port of the site-search profanity check (apps/feed-go/internal/profanity), held to the
 * real Node check from both ends.
 *
 * 1. Its data (apps/feed-go/internal/profanity/data.json) is the live Node data: the shipped lists,
 *    LIBRARY_OVERMATCH_TOKENS, the word-rules constants, obscenity's English dataset (each raw pattern
 *    parsed by obscenity's own parser), and the matcher's two transformer chains probed on every ASCII
 *    character through the real SimpleProfanityFilter's matcher.
 * 2. Every literal case of the shared fixture (apps/feed-go/testdata/profanity/parity.json) answers
 *    its `node` verdict through the real `profaneSearchCheck`, with only the flag and the two blocklist
 *    rows answered from the fixture. feed-go's parity_test.go holds Go to the same file: never clean
 *    where `node` is profane.
 * 3. The generated corpus (src/__tests__/feed-go-profanity-corpus.ts, built the same way in Go) gets
 *    exactly the recorded verdicts from the real filter under three list configurations.
 *
 * On a mismatch the message carries `GOLDEN-ACTUAL <json>`: the fixture's verdicts are only ever set
 * from this test's output, never from Go's.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { englishDataset, parseRawPattern } from 'obscenity';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { blockedWords, whitelistWords } from '@civitai/mod-utils/profanity/lists';
import {
  cleanWord,
  isValidWord,
  managedProfanityEntries,
  MIN_DATASET_WORD_LENGTH,
  MIN_MANAGED_PROFANITY_ENTRIES,
  MIN_UNBOUNDED_LETTERS,
} from '@civitai/mod-utils/profanity/word-rules';
import { corpusDigest, corpusInputs, synthetic } from '~/__tests__/feed-go-profanity-corpus';
import { createProfanityFilter, LIBRARY_OVERMATCH_TOKENS } from '~/libs/profanity-simple';
import type * as FliptClient from '~/server/flipt/client';

const h = vi.hoisted(() => ({ flagOn: false }));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: async () => h.flagOn,
}));

import {
  createProfanityListReader,
  profaneSearchCheck,
  setProfanityListReaderForTests,
} from '~/server/services/profanity-list.service';

const DATA = join(process.cwd(), 'apps/feed-go/internal/profanity/data.json');
const FIXTURE = join(process.cwd(), 'apps/feed-go/testdata/profanity/parity.json');

type Chain = { map: number[]; collapse: Record<string, number>; default: number };
type Data = {
  blockedWords: string[];
  whitelistWords: string[];
  overmatchTokens: string[];
  minManagedEntries: number;
  minDatasetWordLength: number;
  minUnboundedLetters: number;
  english: { word: string; patterns: string[]; whitelistedTerms: string[] }[];
  blacklist: Chain;
  whitelist: Chain;
};
type Row = { raw?: string; id?: number; data?: string[]; synthetic?: number };
type Case = {
  name: string;
  flag: 'on' | 'off' | 'unknown';
  rows: Record<string, Row>;
  queries: string[];
  node: 'clean' | 'profane' | null;
  go: 'clean' | 'profane' | 'handback';
};
type Fixture = {
  cases: Case[];
  corpus: { count: number; sha256: string; verdicts: Record<string, string> };
};

const data = JSON.parse(readFileSync(DATA, 'utf8')) as Data;
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture;

// obscenity keeps these private; the any-term prefilter reads the same ones.
type Matcher = {
  applyTransformers(input: string, transformers: unknown): [number[], string];
  blacklistMatcherTransformers: unknown;
  whitelistMatcherTransformers: unknown;
};
type Container = {
  patterns: unknown[];
  whitelistedTerms: string[];
  metadata?: { originalWord: string };
};
const containers = (englishDataset as unknown as { containers: Container[] }).containers;

describe('feed-go profanity data.json is the live Node data', () => {
  it('the shipped lists, the overmatch tokens and the word-rules constants', () => {
    expect(data.blockedWords).toEqual(blockedWords);
    expect(data.whitelistWords).toEqual(whitelistWords);
    expect(data.overmatchTokens).toEqual([...LIBRARY_OVERMATCH_TOKENS]);
    expect(data.minManagedEntries).toBe(MIN_MANAGED_PROFANITY_ENTRIES);
    expect(data.minDatasetWordLength).toBe(MIN_DATASET_WORD_LENGTH);
    expect(data.minUnboundedLetters).toBe(MIN_UNBOUNDED_LETTERS);
  });

  it("obscenity's English dataset, each raw pattern parsed by obscenity's parser", () => {
    expect(containers.length).toBeGreaterThan(50);
    expect(data.english.length).toBe(containers.length);
    containers.forEach((c, i) => {
      const mine = data.english[i];
      expect(mine.word).toBe(c.metadata?.originalWord);
      expect(mine.patterns.map((raw) => parseRawPattern(raw))).toEqual(c.patterns);
      expect(mine.whitelistedTerms).toEqual(c.whitelistedTerms);
    });
  });

  // Every ASCII character through the real filter's chains: one character gives the per-character
  // map (none of them drops one), a run of eight its collapse threshold (-1: never collapsed).
  it.each([
    ['blacklist', 'blacklistMatcherTransformers'],
    ['whitelist', 'whitelistMatcherTransformers'],
  ] as const)('the %s transformer chain', (name, key) => {
    for (const filter of [
      createProfanityFilter(),
      createProfanityFilter({ moderatorBlocklist: managedProfanityEntries(blockedWords).usable }),
    ]) {
      const matcher = (filter as unknown as { matcher: Matcher }).matcher;
      const chain = data[name];
      const threshold = (c: number) => chain.collapse[String.fromCharCode(c)] ?? chain.default;
      const RUN = 8;
      for (let c = 0; c < 128; c++) {
        const ch = String.fromCharCode(c);
        const [, one] = matcher.applyTransformers(ch, matcher[key]);
        expect([c, one]).toEqual([c, String.fromCharCode(chain.map[c])]);
        const [, run] = matcher.applyTransformers(ch.repeat(RUN), matcher[key]);
        const t = threshold(chain.map[c]);
        expect([c, run.length]).toEqual([c, t < 0 ? RUN : Math.min(t, RUN)]);
      }
    }
  });
});

// The rows the list service reads, as readBlocklistWithSource returns them: a fixture row absent
// from the cache is a database read of no row (feed-go hands that case back: it never reads the
// database).
let rows: Record<string, Row> = {};
function readRow(type: string) {
  const spec = rows[type];
  if (!spec) return Promise.resolve({ dto: { type, data: [] as string[] }, source: 'db' as const });
  if (spec.raw !== undefined) {
    const parsed = JSON.parse(spec.raw);
    return Promise.resolve({
      dto: { ...parsed, data: parsed.data ?? [] },
      source: 'cache' as const,
    });
  }
  const dto: { id?: number; type: string; data: string[] } = {
    type,
    data: [...synthetic(spec.synthetic ?? 0), ...(spec.data ?? [])],
  };
  if (spec.id !== undefined) dto.id = spec.id;
  return Promise.resolve({ dto, source: 'cache' as const });
}

describe('feed-go site-search profanity parity: the literal cases', () => {
  beforeEach(() => {
    setProfanityListReaderForTests(createProfanityListReader({ readRow: readRow as never }));
  });
  afterAll(() => setProfanityListReaderForTests());

  it('the fixture exercises every verdict, and never asks Go for clean where Node refuses', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(50);
    for (const verdict of ['clean', 'profane'] as const)
      expect(fixture.cases.filter((c) => c.node === verdict).length).toBeGreaterThanOrEqual(10);
    for (const c of fixture.cases)
      if (c.node === 'profane') expect([c.name, c.go]).not.toEqual([c.name, 'clean']);
  });

  const run = fixture.cases.filter((c) => c.node !== null);
  it.each(run.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    h.flagOn = c.flag === 'on';
    rows = c.rows;
    const got = await profaneSearchCheck(c.queries);
    expect(got, `GOLDEN-ACTUAL ${JSON.stringify({ name: c.name, node: got })}`).toBe(c.node);
  });
});

describe('feed-go site-search profanity parity: the corpus', () => {
  const inputs = corpusInputs({
    blockedWords,
    whitelistWords,
    english: containers.map((c) => ({
      word: c.metadata?.originalWord ?? '',
      whitelistedTerms: c.whitelistedTerms,
    })),
    cleanWord,
    isValidWord,
  });

  it('is the corpus the fixture records', () => {
    expect({ count: inputs.length, sha256: corpusDigest(inputs) }).toEqual({
      count: fixture.corpus.count,
      sha256: fixture.corpus.sha256,
    });
  });

  it('gets exactly the recorded verdicts from the real filter', () => {
    const managed = managedProfanityEntries(blockedWords);
    expect(managed.enforced).toBe(true);
    const configs = {
      shipped: createProfanityFilter(),
      emptyAllow: createProfanityFilter({ moderatorWhitelist: [] }),
      managedShipped: createProfanityFilter({ moderatorBlocklist: managed.usable }),
    };
    const verdicts = Object.fromEntries(
      Object.entries(configs).map(([name, f]) => [
        name,
        inputs.map((t) => (f.analyze(t).isProfane ? '1' : '0')).join(''),
      ])
    );
    expect(verdicts, `GOLDEN-ACTUAL ${JSON.stringify({ verdicts })}`).toEqual(
      fixture.corpus.verdicts
    );
  });
});
