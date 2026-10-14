import { describe, expect, it } from 'vitest';
import {
  composeUserText,
  MIN_SEGMENT_CHARS,
  segmentUserText,
} from '~/server/services/text-scan/segment';
import type { TextScanSubject } from '~/server/services/text-scan/types';

const subject = (fields: TextScanSubject['fields']): TextScanSubject => ({ fields, declared: {} });
const OPTS = { budget: 1000, maxSegments: 10 };
/** `w0000 w0001 …`: 5-char words, one space apart, every word unique. */
const words = (count: number) =>
  Array.from({ length: count }, (_, i) => `w${String(i).padStart(4, '0')}`).join(' ');
/** `0123…699` with no whitespace; long substrings are unique. */
const digits = Array.from({ length: 700 }, (_, i) => String(i)).join('');
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// Verbatim copy of #5856's composeFullText; the dedup and appeal hashes depend on composeUserText matching it.
const legacyCompose = (s: TextScanSubject) =>
  s.fields
    .filter((field) => field.text?.trim())
    .map((field) => `## ${field.heading}\n${field.text!.trim()}`)
    .join('\n\n');

/** The pieces of one split field cover its body in order with no gap. */
function expectCovers(body: string, prefix: string, segments: string[]) {
  let covered = 0;
  let from = 0;
  for (const segment of segments) {
    expect(segment.startsWith(prefix)).toBe(true);
    const piece = segment.slice(prefix.length);
    const at = body.indexOf(piece, from);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThanOrEqual(covered);
    covered = at + piece.length;
    from = at + 1;
  }
  expect(covered).toBe(body.length);
}

describe('composeUserText', () => {
  it.each([
    [
      'blank, null and padded fields',
      [
        { heading: 'Name', text: '  My LoRA ' },
        { heading: 'Description', text: '' },
        { heading: 'Trained words', text: null },
        { heading: 'Notes', text: '   ' },
        { heading: 'Version', text: 'v1\n\nnotes\n' },
      ],
    ],
    ['astral characters', [{ heading: 'Bio', text: 'hi 😀 there 𠀋' }]],
    ['no fields', []],
  ])('matches the #5856 composition byte for byte: %s', (_name, fields) => {
    const s = subject(fields);
    expect(composeUserText(s)).toBe(legacyCompose(s));
  });
});

describe('segmentUserText', () => {
  it('returns text within the budget whole, as the one segment', () => {
    const s = subject([
      { heading: 'Name', text: 'My LoRA' },
      { heading: 'Body', text: 'x'.repeat(970) },
    ]);
    const text = legacyCompose(s);
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(segmentUserText(s, OPTS)).toEqual({
      text,
      segments: [text],
      inputChars: text.length,
      scannedChars: text.length,
      inputCut: false,
    });
  });

  it('keeps text of exactly the budget in one segment', () => {
    const s = subject([{ heading: 'B', text: 'x'.repeat(1000 - '## B\n'.length) }]);
    expect(segmentUserText(s, OPTS).segments).toHaveLength(1);
  });

  it('never uses a budget below MIN_SEGMENT_CHARS', () => {
    const s = subject([{ heading: 'Body', text: 'x'.repeat(MIN_SEGMENT_CHARS - 20) }]);
    expect(segmentUserText(s, { budget: 5, maxSegments: 10 }).segments).toHaveLength(1);
  });

  it('splits between fields first, one field per segment', () => {
    const s = subject(
      ['A', 'B', 'C'].map((h) => ({ heading: h, text: h.toLowerCase().repeat(600) }))
    );
    expect(segmentUserText(s, OPTS)).toMatchObject({
      segments: [
        '## A\n' + 'a'.repeat(600),
        '## B\n' + 'b'.repeat(600),
        '## C\n' + 'c'.repeat(600),
      ],
      inputCut: false,
    });
  });

  it('packs small fields together before starting a new segment', () => {
    const s = subject([
      { heading: 'S1', text: 's'.repeat(100) },
      { heading: 'S2', text: 't'.repeat(100) },
      { heading: 'Big', text: 'b'.repeat(900) },
    ]);
    expect(segmentUserText(s, OPTS).segments).toEqual([
      '## S1\n' + 's'.repeat(100) + '\n\n## S2\n' + 't'.repeat(100),
      '## Big\n' + 'b'.repeat(900),
    ]);
  });

  it('cuts an oversize field after a paragraph break', () => {
    const body = Array.from({ length: 6 }, (_, i) => String(i).repeat(299)).join('\n\n');
    const { segments } = segmentUserText(subject([{ heading: 'Body', text: body }]), OPTS);
    expect(segments).toEqual(['## Body\n' + body.slice(0, 903), '## Body\n' + body.slice(903)]);
  });

  it('falls back to a line break', () => {
    const body = Array.from({ length: 6 }, (_, i) => String(i).repeat(299)).join('\n');
    const { segments } = segmentUserText(subject([{ heading: 'Body', text: body }]), OPTS);
    expect(segments).toEqual(['## Body\n' + body.slice(0, 900), '## Body\n' + body.slice(900)]);
  });

  it('falls back to whitespace and overlaps the continuation from a word start', () => {
    const body = words(300);
    const { segments } = segmentUserText(subject([{ heading: 'Body', text: body }]), OPTS);
    // Cut after the last space that fits (990); the continuation starts at the first word after
    // cut − 100, so 96 characters are scanned twice.
    expect(segments).toEqual(['## Body\n' + body.slice(0, 990), '## Body\n' + body.slice(894)]);
    expectCovers(body, '## Body\n', segments);
  });

  it('hard-cuts a body with no whitespace and still makes progress', () => {
    const { segments } = segmentUserText(subject([{ heading: 'Body', text: digits }]), OPTS);
    expect(segments).toEqual([
      '## Body\n' + digits.slice(0, 992),
      '## Body\n' + digits.slice(892, 1884),
      '## Body\n' + digits.slice(1784),
    ]);
    expectCovers(digits, '## Body\n', segments);
  });

  it('never leaves a lone surrogate at a hard cut', () => {
    // '## Bio\n' is 7 characters, so the most body that fits (993) ends inside a pair.
    const { segments } = segmentUserText(
      subject([{ heading: 'Bio', text: '😀'.repeat(1000) }]),
      OPTS
    );
    expect(segments[0]).toBe('## Bio\n' + '😀'.repeat(496));
    expect(segments.some((s) => LONE_SURROGATE.test(s))).toBe(false);
  });

  it('never leaves a lone surrogate at an overlap start', () => {
    // The pairs start at odd offsets, so cut (992) − overlap (100) lands between a pair's halves.
    const body = 'q' + '😀'.repeat(450) + 'z'.repeat(1100);
    const { segments } = segmentUserText(subject([{ heading: 'Body', text: body }]), OPTS);
    expect(segments[1].startsWith('## Body\n' + body.slice(893, 900))).toBe(true);
    expect(segments.some((s) => LONE_SURROGATE.test(s))).toBe(false);
  });

  it('repeats the heading on every continuation and keeps every segment within the budget', () => {
    const s = subject([
      { heading: 'Intro', text: 'i'.repeat(300) },
      { heading: 'Story', text: words(700) },
      { heading: 'Code', text: digits },
    ]);
    const { segments } = segmentUserText(s, OPTS);
    for (const segment of segments) {
      expect(segment.length).toBeLessThanOrEqual(1000);
      expect(segment.startsWith('## ')).toBe(true);
    }
    expect(segments.filter((x) => x.includes('## Story\n')).length).toBeGreaterThan(1);
  });

  it('starts an oversize field in the open segment when a quarter of it is still free', () => {
    const body = words(300);
    const { segments } = segmentUserText(
      subject([
        { heading: 'Intro', text: 'i'.repeat(100) },
        { heading: 'Body', text: body },
      ]),
      OPTS
    );
    expect(segments[0]).toBe('## Intro\n' + 'i'.repeat(100) + '\n\n## Body\n' + body.slice(0, 876));
  });

  it('closes the open segment first when less than a quarter is free', () => {
    const { segments } = segmentUserText(
      subject([
        { heading: 'Intro', text: 'i'.repeat(800) },
        { heading: 'Body', text: words(300) },
      ]),
      OPTS
    );
    expect(segments[0]).toBe('## Intro\n' + 'i'.repeat(800));
  });

  it('stops at maxSegments and reports what was not scanned', () => {
    const s = subject(
      ['A', 'B', 'C', 'D', 'E'].map((h) => ({ heading: h, text: h.toLowerCase().repeat(600) }))
    );
    const result = segmentUserText(s, { budget: 1000, maxSegments: 2 });
    expect(result.segments).toHaveLength(2);
    expect(result).toMatchObject({
      inputChars: 5 * 605 + 4 * 2,
      scannedChars: 605 + 2 + 605,
      inputCut: true,
    });
  });

  it('skips blank fields when splitting and scans everything when under the ceiling', () => {
    const s = subject([
      { heading: 'Empty', text: '  ' },
      { heading: 'A', text: 'a'.repeat(600) },
      { heading: 'Null', text: null },
      { heading: 'B', text: 'b'.repeat(600) },
    ]);
    const result = segmentUserText(s, OPTS);
    expect(result.segments).toEqual(['## A\n' + 'a'.repeat(600), '## B\n' + 'b'.repeat(600)]);
    expect(result).toMatchObject({ scannedChars: result.inputChars, inputCut: false });
  });

  it('splits a production-sized text into budget-sized segments', () => {
    const body = words(80_000);
    const result = segmentUserText(subject([{ heading: 'Comment', text: body }]), {
      budget: 200_000,
      maxSegments: 10,
    });
    expect(result.segments).toHaveLength(3);
    expect(result.segments.every((s) => s.length <= 200_000)).toBe(true);
    expect(result.inputCut).toBe(false);
    expectCovers(body, '## Comment\n', result.segments);
  });
});

describe('segmentUserText over seeded random subjects', () => {
  /** mulberry32: a fixed seed replays the same subjects on every run. */
  function prng(seed: number) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('stays within budget and maxSegments, covers what it scanned, and never splits a pair', () => {
    const random = prng(5862);
    const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
    let next = 0;
    // `t<n>x` tokens are unique and never a substring of one another.
    const token = () => (random() < 0.1 ? `t${next++}\u{1F600}x` : `t${next++}x`);
    const body = () => {
      const parts: string[] = [];
      for (let i = int(0, 400); i > 0; i--) {
        const roll = random();
        if (roll < 0.03) parts.push('ab\u{1F600}'.repeat(int(100, 900)));
        else if (roll < 0.08) parts.push('\n\n');
        else if (roll < 0.12) parts.push('\n');
        else parts.push(token());
      }
      return parts.join(' ');
    };

    for (let run = 0; run < 300; run++) {
      const budget = int(MIN_SEGMENT_CHARS, 4000);
      const maxSegments = int(1, 20);
      const fields = Array.from({ length: int(1, 6) }, () => ({
        heading: random() < 0.15 ? 'H'.repeat(int(budget + 1, budget * 2)) : `F${int(0, 99)}`,
        text: random() < 0.1 ? '   ' : body(),
      }));
      const s = subject(fields);
      const result = segmentUserText(s, { budget, maxSegments });

      expect(result.text).toBe(composeUserText(s));
      expect(result.segments.length).toBeLessThanOrEqual(maxSegments);
      for (const segment of result.segments) {
        expect(segment.length).toBeLessThanOrEqual(budget);
        expect(segment).not.toMatch(LONE_SURROGATE);
      }
      expect(result.scannedChars).toBeLessThanOrEqual(result.inputChars);
      expect(result.inputCut).toBe(result.scannedChars < result.inputChars);
      if (result.text.length <= budget) expect(result.segments).toEqual([result.text]);

      const scanned = result.segments.join('\n');
      for (const match of result.text.matchAll(/t\d+\u{1F600}?x/gu)) {
        if (match.index + match[0].length > result.scannedChars) break;
        expect(scanned).toContain(match[0]);
      }
    }
  });
});

describe('segmentUserText with a heading too long to repeat', () => {
  const budget = 1000;
  const opts = { budget, maxSegments: 20 };
  const repeatedPrefix = (segment: string) => segment.slice(0, segment.indexOf('\n') + 1);

  it('caps the repeated heading so each continuation still advances most of a budget', () => {
    const body = words(1200);
    const { segments } = segmentUserText(
      subject([{ heading: 'H'.repeat(2 * budget), text: body }]),
      opts
    );
    const prefix = repeatedPrefix(segments[0]);
    expect(prefix.length).toBeGreaterThan(3);
    expect(prefix.length).toBeLessThanOrEqual(budget / 4);
    expectCovers(body, prefix, segments);
    const starts = segments.map((segment) => body.indexOf(segment.slice(prefix.length)));
    for (let i = 1; i < starts.length; i++)
      expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(budget / 2);
  });

  it('cuts the capped heading before a surrogate pair, keeping its newline', () => {
    const heading = `${'H'.repeat(245)}\u{1F600}${'H'.repeat(2 * budget)}`;
    const { segments } = segmentUserText(subject([{ heading, text: words(1200) }]), opts);
    const prefix = repeatedPrefix(segments[0]);
    expect(prefix).toBe(`## ${'H'.repeat(245)}\n`);
    for (const segment of segments) expect(segment).not.toMatch(LONE_SURROGATE);
  });
});
