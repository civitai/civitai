import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * LEDGER for `LISTING_RECOMMEND_PCT_MIN_REVIEWS`: the "how many reviews before we show a
 * recommend percentage" rule lives in `recommendRollup` and nowhere else.
 *
 * The server withholds `recommendPct` below the threshold; every client branches on
 * `recommendPct == null` and `reviewCount === 0`, never on the number itself. A second copy
 * of the threshold in a client (`reviewCount < 5`) would let the card, the detail rail and
 * the header chip disagree about the same listing the moment one of them is changed.
 *
 * Two checks, because one is blind to what the other catches:
 *   1. the set of files that NAME the constant is exactly the rollup's file (fails when the
 *      set grows or shrinks);
 *   2. no listing-rollup consumer compares a review count against a literal of 2 or more.
 *      A copy does not import the constant, so (1) cannot see it.
 *
 * Scope: non-test `.ts`/`.tsx` under `src/` (no `apps/` or `packages/` file reads the
 * listing rollup). Comparisons against 0 or 1 are "are there any" checks and stay allowed.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const SRC = path.join(REPO_ROOT, 'src');
const ROLLUP_FILE = 'src/server/services/blocks/app-listing.service.ts';
const CONSTANT = 'LISTING_RECOMMEND_PCT_MIN_REVIEWS';

/** A file that reads the listing recommend rollup (the DTO type, its formatter, or the field). */
const ROLLUP_CONSUMER =
  /\b(?:ListingRecommendRollup|getRecommendLabel|recommendRollup)\b|\.recommend\b/;

/** A review count compared, either way round, with a relational operator to a literal ≥ 2. */
const COUNT = String.raw`\b(?:reviewCount|recommendedCount|notRecommendedCount|thumbsUpCount|thumbsDownCount)\b`;
const LITERAL = String.raw`(?:[2-9]|[1-9]\d+)\b`;
const COUNT_VS_LITERAL = new RegExp(
  String.raw`${COUNT}\s*(?:<=?|>=?)\s*${LITERAL}|\b${LITERAL}\s*(?:<=?|>=?)\s*(?:[\w$]+\??\.)*${COUNT}`
);

type SourceFile = { rel: string; text: string };

function sourceFiles(): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push({
          rel: path.relative(REPO_ROOT, full).split(path.sep).join('/'),
          text: fs.readFileSync(full, 'utf8'),
        });
      }
    }
  };
  walk(SRC);
  return out;
}

const FILES = sourceFiles();

describe(`${CONSTANT} — one rule, one place`, () => {
  it('only the rollup file names the constant', () => {
    const naming = FILES.filter((f) => new RegExp(`\\b${CONSTANT}\\b`).test(f.text)).map(
      (f) => f.rel
    );
    expect(naming).toEqual([ROLLUP_FILE]);
  });

  it('POSITIVE CONTROL: the consumer scan finds the known renderers of the rollup', () => {
    const consumers = FILES.filter((f) => ROLLUP_CONSUMER.test(f.text)).map((f) => f.rel);
    expect(consumers).toEqual(
      expect.arrayContaining([
        ROLLUP_FILE,
        'src/components/Apps/appListingCardView.ts',
        'src/components/Apps/appListingStatChips.ts',
        'src/components/Apps/appListingDetailRows.ts',
        'src/components/Apps/AppListingCard.tsx',
        'src/components/AppBlocks/AppNameCrumb.tsx',
      ])
    );
  });

  it('the matcher catches a copied threshold and allows "are there any" checks', () => {
    expect('if (detail.reviewCount < 5) return x;').toMatch(COUNT_VS_LITERAL);
    expect('recommendedCount + notRecommendedCount >= 10').toMatch(COUNT_VS_LITERAL);
    expect('5 > card.reviewCount').toMatch(COUNT_VS_LITERAL);
    expect('if (detail.reviewCount === 0) return x;').not.toMatch(COUNT_VS_LITERAL);
    expect('reviewCount > 0').not.toMatch(COUNT_VS_LITERAL);
    expect('recommendedCount === 1 ? a : b').not.toMatch(COUNT_VS_LITERAL);
  });

  it('no rollup consumer compares a review count against a threshold of its own', () => {
    const offenders = FILES.filter((f) => ROLLUP_CONSUMER.test(f.text))
      .flatMap((f) =>
        f.text
          .split('\n')
          .map((line, i) => ({ line, at: `${f.rel}:${i + 1}` }))
          .filter(({ line }) => COUNT_VS_LITERAL.test(line))
      )
      .map(({ at, line }) => `${at}  ${line.trim()}`);
    expect(offenders).toEqual([]);
  });
});
