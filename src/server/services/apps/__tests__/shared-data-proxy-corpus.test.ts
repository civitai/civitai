import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { redisMock } from '~/__tests__/mocks/redis.mock';
import { BlocklistType } from '~/server/common/enums';
import { REDIS_KEYS } from '~/server/redis/client';
import { newUlid } from '~/server/utils/app-block-ids';
import {
  blockingHit,
  scanCounterKey,
  scanSharedData,
  type SharedDataHitCategory,
  type SharedTextScan,
} from '../shared-data-moderation';
import {
  generateKind,
  PROXY_CORPUS_KINDS,
  type ProxyCorpusKind,
  type ProxyCorpusSurface,
} from './shared-data-proxy-corpus';

/**
 * FALSE-POSITIVE MEASUREMENT of shared-storage local moderation over a synthetic benign corpus
 * (`shared-data-proxy-corpus.ts`).
 *
 * Every string goes through the LIVE entry point for where it would be stored — `scanSharedData`
 * for a `data` value or object key, `scanCounterKey` for a counter key — so no detector, cap or
 * budget is re-implemented here. A string is FLAGGED when its scan records any hit (what a shadow
 * scan would write), and WOULD BLOCK when `blockingHit` returns one with patterns enforced (the
 * strictest enforce configuration).
 *
 * Which lists are real:
 * - minor, POI and the green-domain audit (profanity included) run on the lists BUNDLED in this
 *   repo — the same code and lists production runs.
 * - The link-domain and message-pattern blocklists, and the moderator benign-phrase list, live in
 *   Redis/the database at runtime. Here they are FIXTURES served through the canonical redis mock,
 *   so the real `findBlockedUserContent` and `stripBenignPhrases` run over them. A link/pattern
 *   count from this file is therefore a claim about the matching logic over plausibly shaped
 *   entries, not about the live lists. The benign-phrase fixture is EMPTY, so the audit gets no
 *   moderator relief: its counts here are an upper bound on what production would flag.
 *
 * The positive controls run through the SAME `measure` function as the corpus. A zero over the
 * corpus means nothing unless that function is also seen to count a hit.
 *
 * Write the per-kind table to a file with `SHARED_DATA_PROXY_REPORT=<absolute path>`.
 */

/** Change it and the measurement must be re-taken. */
const SEED = 20261012;
const PER_KIND = 300;

/** First 16 hex of sha256 over each kind's strings joined by `\n`, at `SEED` / `PER_KIND`. */
const CORPUS_DIGESTS: Record<ProxyCorpusKind, string> = {
  ulid: 'c155b94c91e5e0e5',
  uuid: '8e215eff92d16bc7',
  sha1_hex: '9f66c3726980891a',
  sha256_hex: '4cf47acf4bba2eae',
  numeric_id: '5cb6b205f4d62202',
  counter_key: 'f5a7b9107d14ffe0',
  platform_url: 'a3413955366f56fd',
  model_name: '3e1b41f8f68f9c5d',
  tag_word: '0982c14cb947bdc9',
  english_title: '7cd1c96a2e62e905',
  english_sentence: '5db589644469be21',
  json_key: '001e90dc37f62c3f',
};

/**
 * The gate, per kind. A kind is either held to ZERO flagged strings, or declared a known NOISE
 * CLASS: then its strings may be flagged, but only by the categories named and only below
 * `NOISE_TRIPWIRE`.
 *
 * Identifier-shaped strings — random base32/hex runs, alone or inside a counter key — are a
 * reproducible noise class: random letter/digit runs produce incidental matches. They are
 * declared rather than given a count because this repository is public and a measured
 * false-positive rate is not committed here (root `CLAUDE.md`, "Security"). The measured per-kind
 * counts for this seed are produced by the reporter below and kept with the moderation soak's
 * private records.
 *
 * What the declaration still catches: any hit from a category outside the class (a link, pattern,
 * POI or overflow hit on an id is a new defect), ANY flagged string in a zero kind, and — through
 * `NOISE_TRIPWIRE` — a wholesale break that flags half of a noise kind. What it cannot catch: a
 * rise in an already-declared category's rate that stays under that tripwire.
 */
const IDENTIFIER_NOISE: ReadonlyArray<SharedDataHitCategory> = ['minor', 'audit_regex'];
const GATE: Record<ProxyCorpusKind, 'zero' | ReadonlyArray<SharedDataHitCategory>> = {
  ulid: IDENTIFIER_NOISE,
  uuid: IDENTIFIER_NOISE,
  sha1_hex: IDENTIFIER_NOISE,
  sha256_hex: IDENTIFIER_NOISE,
  numeric_id: 'zero',
  counter_key: IDENTIFIER_NOISE,
  platform_url: 'zero',
  model_name: 'zero',
  tag_word: 'zero',
  english_title: 'zero',
  english_sentence: 'zero',
  json_key: 'zero',
};

/**
 * A noise kind fails outright when at least this share of it is flagged. A structural tripwire for a
 * detector that has started matching identifiers wholesale, NOT a measured rate or a tolerance.
 */
const NOISE_TRIPWIRE = 0.5;

/** The flagged strings that BREAK a kind's gate — empty means the kind passes. */
function gateViolations(
  kind: ProxyCorpusKind,
  flagged: FlaggedString[],
  n: number
): FlaggedString[] {
  const gate = GATE[kind];
  if (gate === 'zero') return flagged;
  if (flagged.length >= n * NOISE_TRIPWIRE) return flagged;
  return flagged.filter((f) => f.hits.some((h) => !gate.includes(h.category)));
}

// ── Blocklist fixtures ─────────────────────────────────────────────────────────
// Synthetic, in the shapes the live lists hold: bare hosts (exact match) and short multi-word
// phrases (substring match). Reserved TLDs only, so no entry names a real site.
const FIXTURE_LINK_DOMAINS = [
  ...[
    'free-credits',
    'prize-claim',
    'gift-portal',
    'wallet-verify',
    'fast-loans',
    'crypto-bonus',
  ].flatMap((name) => [`${name}.example`, `${name}.test`, `www.${name}.example`]),
  'short.invalid',
  'redirect.invalid',
  'click-here.test',
  // NEAR-MISS DECOYS of the corpus's own hosts. Matching is exact on the host, so none may fire on
  // a platform URL; a matcher broadened to substring/suffix/subdomain matching fires on every one,
  // which is what gives the `platform_url` zero something to catch.
  'notcivitai.com',
  'civitai.com.example',
  'civitai.green.test',
  // ...and a PARENT of a corpus host, for the other broadening: suffix/subdomain matching.
  'green',
];
const FIXTURE_PATTERNS = [
  'claim your free',
  'verify your wallet',
  'limited time giveaway',
  'send me a dm for',
  'free buzz generator',
  'double your crypto',
  'join my telegram',
  'add me on whatsapp',
  'work from home and earn',
  'click the link in my bio',
  // NEAR-MISS DECOYS: each shares leading words or a token with corpus strings, but no corpus
  // string contains the whole phrase. A matcher loosened to per-word or prefix matching fires.
  'great work on the giveaway page',
  'thanks for playing, now claim',
  'workshop crypto airdrop',
];
const FIXTURE_LISTS: Partial<Record<BlocklistType, string[]>> = {
  [BlocklistType.LinkDomain]: FIXTURE_LINK_DOMAINS,
  [BlocklistType.MessagePattern]: FIXTURE_PATTERNS,
  [BlocklistType.PromptBenignPhrase]: [],
};

function serveFixtureLists() {
  redisMock.redis.get.mockImplementation(async (key: string) => {
    const prefix = `${REDIS_KEYS.SYSTEM.BLOCKLIST}:`;
    if (!key.startsWith(prefix)) return null;
    const type = key.slice(prefix.length) as BlocklistType;
    const data = FIXTURE_LISTS[type];
    return data ? JSON.stringify({ id: 1, type, data }) : null;
  });
}

// ── Measurement ────────────────────────────────────────────────────────────────

interface FlaggedString {
  text: string;
  /**
   * `matched` is the detector's own term (for the audit, the token of the input it matched); it is
   * printed by the opt-in reporter only, never by an assertion, so a CI log carries none of it.
   */
  hits: Array<{ category: SharedDataHitCategory; label: string; matched: string }>;
  wouldBlock: boolean;
}

interface KindMeasurement {
  n: number;
  flagged: FlaggedString[];
}

function scanFor(surface: ProxyCorpusSurface, text: string): Promise<SharedTextScan> {
  if (surface === 'counter') return scanCounterKey(text);
  if (surface === 'key') return scanSharedData({ [text]: 1 });
  return scanSharedData({ v: text });
}

/**
 * The leaf under test, out of a scan that may also carry the wrapper's own `v` key. Filtering on
 * the leaf keeps the wrapper from ever being counted — and an overflow (no leaf) is kept.
 */
const hitsOn = (scan: SharedTextScan, text: string) =>
  scan.hits.filter((h) => h.leaf === null || h.leaf.raw === text);

async function measure(surface: ProxyCorpusSurface, texts: string[]): Promise<KindMeasurement> {
  const flagged: FlaggedString[] = [];
  for (const text of texts) {
    const scan = await scanFor(surface, text);
    const hits = hitsOn(scan, text);
    if (!hits.length) continue;
    flagged.push({
      text,
      hits: hits.map((h) => ({ category: h.category, label: h.label, matched: h.matched })),
      wouldBlock: blockingHit({ ...scan, hits }, { enforcePatterns: true }) !== null,
    });
  }
  return { n: texts.length, flagged };
}

/**
 * The per-kind table and every flagged string with the detector, label and term that fired.
 * OPT-IN (`SHARED_DATA_PROXY_REPORT=<path>`) and written to that file only: it is the measurement,
 * which belongs with the soak's private records, not in a CI log of a public repository.
 */
function reportTable(results: Map<ProxyCorpusKind, KindMeasurement>): string {
  const lines = [
    `seed ${SEED}, ${PER_KIND} per kind`,
    '| kind | surface | n | flagged | per 1,000 | would block (enforce) | gate | triggers |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const [kind, { n, flagged }] of results) {
    const triggers = [
      ...new Set(flagged.flatMap((f) => f.hits.map((h) => `${h.category}:${h.label}`))),
    ];
    const gate = GATE[kind];
    lines.push(
      `| ${kind} | ${PROXY_CORPUS_KINDS[kind].surface} | ${n} | ${flagged.length} | ` +
        `${((flagged.length / n) * 1000).toFixed(1)} | ` +
        `${flagged.filter((f) => f.wouldBlock).length} | ` +
        `${gate === 'zero' ? '0' : `noise: ${gate.join('+')}`} | ${triggers.join(', ') || '—'} |`
    );
  }
  lines.push('', 'flagged strings (category:label "term"):');
  for (const [kind, { flagged }] of results) {
    for (const f of flagged) {
      const detail = f.hits.map((h) => `${h.category}:${h.label} "${h.matched}"`).join(', ');
      lines.push(`- ${kind}: \`${f.text}\` → ${detail}${f.wouldBlock ? ' (would block)' : ''}`);
    }
  }
  return lines.join('\n');
}

const KINDS = Object.keys(PROXY_CORPUS_KINDS) as ProxyCorpusKind[];

beforeEach(() => {
  serveFixtureLists();
});

describe('shared-data moderation — false positives on a benign proxy corpus', () => {
  const results = new Map<ProxyCorpusKind, KindMeasurement>();

  beforeAll(async () => {
    serveFixtureLists();
    for (const kind of KINDS) {
      const texts = generateKind(kind, SEED, PER_KIND);
      results.set(kind, await measure(PROXY_CORPUS_KINDS[kind].surface, texts));
    }
    // A FILE, not console output: vitest does not reliably surface a passing file's stdout.
    const reportPath = process.env.SHARED_DATA_PROXY_REPORT;
    if (reportPath) writeFileSync(reportPath, `${reportTable(results)}\n`);
  }, 120_000);

  it(`every kind has ${PER_KIND} distinct strings`, () => {
    for (const kind of KINDS) expect([kind, results.get(kind)?.n]).toEqual([kind, PER_KIND]);
  });

  it('the corpus is deterministic: the same seed gives the same strings', () => {
    for (const kind of KINDS) {
      expect(generateKind(kind, SEED, PER_KIND)).toEqual(generateKind(kind, SEED, PER_KIND));
    }
    // Control: a different seed moves it, so the equality above is not a constant generator.
    expect(generateKind('ulid', SEED + 1, PER_KIND)).not.toEqual(
      generateKind('ulid', SEED, PER_KIND)
    );
  });

  it('the corpus is PINNED: a generator or PRNG change cannot move it silently', () => {
    // The private measurement is bound to exactly these strings. Changing a generator is fine —
    // re-take the measurement and update the digest in the same change.
    const digests = Object.fromEntries(
      KINDS.map((kind) => [
        kind,
        createHash('sha256')
          .update(generateKind(kind, SEED, PER_KIND).join('\n'))
          .digest('hex')
          .slice(0, 16),
      ])
    );
    expect(digests).toEqual(CORPUS_DIGESTS);
  });

  it('INVARIANT GUARD: corpus ULIDs have the shape of a real `newUlid()`', () => {
    // The ULID generator is a seeded copy of `newUlid`'s layout (that one reads the clock and real
    // randomness), so tie the two together: same length, same alphabet.
    const shape = /^[0-9A-HJKMNP-TV-Z]{26}$/;
    expect(newUlid()).toMatch(shape);
    for (const id of generateKind('ulid', SEED, PER_KIND)) expect(id).toMatch(shape);
  });

  it.each(KINDS)('%s: nothing flagged outside its gate', (kind) => {
    const { n, flagged } = results.get(kind)!;
    // The violating strings are the assertion's subject, so a failure names each one and the
    // category that fired — never the matched term.
    expect(
      gateViolations(kind, flagged, n).map((f) => [f.text, f.hits.map((h) => h.category)])
    ).toEqual([]);
  });
});

describe('the gate itself', () => {
  const flaggedBy = (...categories: SharedDataHitCategory[]): FlaggedString => ({
    text: 'x',
    hits: categories.map((category) => ({ category, label: category, matched: category })),
    wouldBlock: true,
  });

  it('a zero kind fails on ANY flagged string', () => {
    expect(gateViolations('english_sentence', [flaggedBy('audit_regex')], 300)).toHaveLength(1);
  });

  it('a noise kind passes its declared categories and fails on any other', () => {
    const ok = [flaggedBy('audit_regex'), flaggedBy('minor')];
    expect(gateViolations('ulid', ok, 300)).toEqual([]);
    for (const other of ['poi', 'link', 'pattern', 'overflow'] as const) {
      expect(gateViolations('ulid', [flaggedBy(other)], 300)).toHaveLength(1);
      // ...including alongside a declared one: the declaration never excuses a second category.
      expect(gateViolations('ulid', [flaggedBy('audit_regex', other)], 300)).toHaveLength(1);
    }
  });

  it('a noise kind fails at the tripwire even when every hit is a declared category', () => {
    const declaredOnly = (count: number) => Array.from({ length: count }, () => flaggedBy('minor'));
    expect(gateViolations('ulid', declaredOnly(149), 300)).toEqual([]);
    expect(gateViolations('ulid', declaredOnly(150), 300)).toHaveLength(150);
  });
});

describe('positive control — the same harness DOES count a hit, per detector category', () => {
  // Every category the scan can emit. The minor, POI and profanity strings are the same fixtures
  // `shared-data-moderation.test.ts` uses; the link and pattern ones hit the fixture lists above.
  const CONTROLS: Array<[SharedDataHitCategory, ProxyCorpusSurface, string]> = [
    ['minor', 'value', '13 year old girl'],
    ['poi', 'value', 'emma watson'],
    ['audit_regex', 'value', 'fuck'],
    ['link', 'value', 'see https://prize-claim.example/now'],
    ['pattern', 'value', 'Claim your free reward today'],
    ['overflow', 'value', 'a'.repeat(20_001)],
    // The other two surfaces, each with an in-process detector AND a list-backed one, so a surface
    // that silently skipped either half would show here.
    ['minor', 'key', '13 year old girl'],
    ['audit_regex', 'key', 'fuck'],
    ['link', 'key', 'https://prize-claim.example/now'],
    ['minor', 'counter', 'playcount:13 year old girl'],
    ['audit_regex', 'counter', 'playcount:fuck'],
    ['pattern', 'counter', 'votes:claim your free'],
  ];

  it.each(CONTROLS)(
    '%s on a %s leaf is flagged and would block',
    async (category, surface, text) => {
      const { n, flagged } = await measure(surface, [text]);
      expect(n).toBe(1);
      expect(flagged).toHaveLength(1);
      expect(flagged[0].hits.map((h) => h.category)).toContain(category);
      expect(flagged[0].wouldBlock).toBe(true);
    }
  );

  it('every hit category is covered by a control', () => {
    const covered = new Set(CONTROLS.map(([category]) => category));
    const all: SharedDataHitCategory[] = [
      'minor',
      'poi',
      'link',
      'pattern',
      'audit_regex',
      'overflow',
    ];
    expect([...covered].sort()).toEqual([...all].sort());
  });

  it('a benign string next to the controls is NOT flagged (the harness is not flagging everything)', async () => {
    const { flagged } = await measure('value', ['a quiet harbor at dawn']);
    expect(flagged).toEqual([]);
  });
});
