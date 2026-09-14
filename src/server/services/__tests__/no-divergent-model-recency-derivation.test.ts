import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { getModelRecency } from '~/components/Cards/model-card.utils';

/**
 * "Is this model New or Updated" decided three card surfaces, and each one restated the rule:
 * ModelCard, ResourceSelectCard and ModelCategoryCard — the last with its own module-scope `aDayAgo`
 * beside it. When #4678 put a paid badge in ModelCard's single status slot, only that copy learned
 * about it, so a paid model published minutes ago read "Paid" on the feed and "New" in the resource
 * picker at the same moment, and lost its New badge entirely on the feed.
 *
 * Two properties are guarded here, because fixing only the first is what makes a consolidation
 * decorative:
 *   1. the RULE has one definition — nobody restates the cutoff comparison or the updated-window math
 *   2. the CUTOFF has one definition — nobody grows a second `aDayAgo`
 *
 * And one property that is not textual at all: the helper still answers correctly. A guard built only
 * from prohibitions passes after the feature is deleted.
 */

const repoRoot = path.resolve(__dirname, '../../../..');
const HELPER_MODULE = 'src/components/Cards/model-card.utils.ts';
const CUTOFF_MODULE = 'src/utils/date-helpers.ts';

// One exact path each, not a directory or a filename pattern. A whole-file exemption is what let the
// third copy of the paid-gate predicate be written unseen; the lengths are asserted below so that
// widening either list is a change a reviewer sees rather than a line that blends in.
const RULE_ALLOWLIST = [HELPER_MODULE] as const;
const CUTOFF_ALLOWLIST = [CUTOFF_MODULE, HELPER_MODULE] as const;

function walk(dir: string, out: string[] = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const sourceFiles = walk(path.join(repoRoot, 'src'))
  .map((full) => ({
    rel: path.relative(repoRoot, full).split(path.sep).join('/'),
    text: readFileSync(full, 'utf8'),
  }))
  // Tests quote the rule they pin, including this file.
  .filter((f) => !/(^|\/)__tests__(\/|$)/.test(f.rel) && !/\.(browser\.)?test\.tsx?$/.test(f.rel));

describe('the New/Updated rule has exactly one definition', () => {
  it('the allowlists are one and two files — widening either must be a visible change', () => {
    expect(RULE_ALLOWLIST).toHaveLength(1);
    expect(CUTOFF_ALLOWLIST).toHaveLength(2);
  });

  it('no other module derives the updated-model window', () => {
    // `timeCutOffs.updatedModel` is the half of the rule a fourth copy cannot express without naming,
    // which makes it the marker that survives renaming `isNew` or reshaping the comparison.
    const offenders = sourceFiles
      .filter((f) => !RULE_ALLOWLIST.includes(f.rel as (typeof RULE_ALLOWLIST)[number]))
      .filter((f) => f.text.includes('timeCutOffs.updatedModel'))
      .map((f) => f.rel);

    expect(
      offenders,
      `These files derive the Updated window instead of calling getModelRecency. Every hand-written ` +
        `copy is one the next badge edit can miss — which is how one card came to show "Paid" while ` +
        `another showed "New" for the same model.`
    ).toEqual([]);
  });

  it('no other module compares publishedAt against a day-old cutoff by hand', () => {
    const offenders = sourceFiles
      .filter((f) => !RULE_ALLOWLIST.includes(f.rel as (typeof RULE_ALLOWLIST)[number]))
      .filter((f) => /publishedAt\s*>\s*aDayAgo/.test(f.text))
      .map((f) => f.rel);

    expect(offenders, 'Call getModelRecency instead of restating the comparison.').toEqual([]);
  });

  it('nobody grows a second day-old cutoff', () => {
    // ModelCategoryCard had exactly this line. Consolidating the rule while leaving a private cutoff
    // behind yields three call sites into one helper, one of which still computes a different answer.
    const offenders = sourceFiles
      .filter((f) => !CUTOFF_ALLOWLIST.includes(f.rel as (typeof CUTOFF_ALLOWLIST)[number]))
      .filter((f) => /\baDayAgo\s*=/.test(f.text))
      .map((f) => f.rel);

    expect(
      offenders,
      'Import aDayAgo from ~/utils/date-helpers rather than defining another one.'
    ).toEqual([]);
  });
});

describe('the New badge is not in the same slot as the money badge', () => {
  // The bug itself, pinned where it happened. This is textual and therefore weak on its own — the
  // assertion that a new+paid card renders BOTH badges lives in ModelCard.browser.test.tsx, which is
  // the one that can actually see a render. This catches the cheaper regression: someone folding the
  // two chips back into one ternary.
  const modelCard = readFileSync(path.join(repoRoot, 'src/components/Cards/ModelCard.tsx'), 'utf8');

  it('renders two distinguishable status badges', () => {
    expect(modelCard).toContain('data-status-badge="recency"');
    expect(modelCard).toContain('data-status-badge="access"');
  });

  it('the recency badge does not consult the paid or early-access state', () => {
    const condition = modelCard.match(/\{\(isNew \|\| isUpdated(?<rest>[^)]*)\)/);
    expect(condition, 'the recency badge is no longer gated on (isNew || isUpdated)').toBeTruthy();
    expect(condition?.groups?.rest ?? '').toBe('');
  });
});

describe('the helper answers correctly', () => {
  // Without these every assertion above is a prohibition, and deleting getModelRecency outright
  // would leave the file green.
  const cutoff = new Date('2026-09-14T00:00:00.000Z');
  const after = (ms: number) => new Date(cutoff.getTime() + ms);
  const before = (ms: number) => new Date(cutoff.getTime() - ms);
  const twoHours = 2 * 60 * 60 * 1000;

  it('is New when published after the cutoff', () => {
    expect(getModelRecency({ publishedAt: after(1), lastVersionAt: after(1) }, cutoff).isNew).toBe(
      true
    );
  });

  it('is not New when published before the cutoff', () => {
    expect(getModelRecency({ publishedAt: before(1), lastVersionAt: null }, cutoff).isNew).toBe(
      false
    );
  });

  it('is not New with no publishedAt at all', () => {
    expect(getModelRecency({ publishedAt: null, lastVersionAt: after(1) }, cutoff).isNew).toBe(
      false
    );
  });

  it('is Updated only when the new version lands more than the window after publish', () => {
    const publishedAt = after(1);
    expect(
      getModelRecency(
        { publishedAt, lastVersionAt: new Date(publishedAt.getTime() + twoHours + 1) },
        cutoff
      ).isUpdated
    ).toBe(true);
    // Exactly the window is not over it — pinned because the comparison is `>`, and a `>=` slip is
    // invisible to any fixture that is merely "much later".
    expect(
      getModelRecency(
        { publishedAt, lastVersionAt: new Date(publishedAt.getTime() + twoHours) },
        cutoff
      ).isUpdated
    ).toBe(false);
  });

  it('New and Updated are independent answers, not a chain', () => {
    // The card picks one to render; the helper must not make that choice for it.
    const publishedAt = after(1);
    const recency = getModelRecency(
      { publishedAt, lastVersionAt: new Date(publishedAt.getTime() + twoHours + 1) },
      cutoff
    );
    expect(recency).toEqual({ isNew: true, isUpdated: true });
  });
});
