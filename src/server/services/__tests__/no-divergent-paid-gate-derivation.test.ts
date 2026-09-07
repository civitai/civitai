import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * The model feed and the model search index derive the SAME card badge from the SAME table. They held
 * two near-identical copies of that query until 868m1r2u7, which is the shape where a change lands in
 * one and not the other: the badge is right in the feed, missing in search, both look correct alone,
 * and nothing fails.
 *
 * HALF OF THIS FILE IS EXISTENCE CHECKS, ON PURPOSE. An earlier version was prohibitions only — no
 * second copy, no unimported deriver — and every one of those passes vacuously once the feature is
 * gone. Deleting the derivation from both surfaces left the whole guard green, because a rule about
 * what must not appear says nothing about what must. The `produces` block below is the other half.
 *
 * WHAT THIS DOES NOT COVER, deliberately: the feed's paid-access FILTER —
 * `getActiveEarlyAccessModelIds` and `getPermanentPaidAccessModelIds` in `model.service.ts`, and the
 * inline EXISTS clauses in `getModelsRaw`. Those answer a different question (which models to return,
 * unbounded, no id list) and folding them into the batched helper would be wrong. They remain a second
 * statement of when a gate is live, so the filter and the badge CAN still disagree. That is known and
 * out of scope here rather than covered — do not read a green run as parity between them.
 */

const repoRoot = path.resolve(__dirname, '../../../..');
const HELPER = 'src/server/services/paid-access.service.ts';
const INDEX = 'src/server/search-index/models.search-index.ts';
const FEED = 'src/server/services/model.service.ts';
const CARD = 'src/components/Cards/ModelCard.tsx';
const TRANSFORM = 'src/shared/search/models-transform.ts';
const CONTRACT = 'packages/civitai-buzz/src/paid-access.ts';

const MODEL_JOIN = 'JOIN "ModelVersion" mv ON mv.id = pa."entityId"';
// The two pre-existing feed-filter copies. Counted rather than excused by filename: excluding the
// whole file would excuse a third copy added to the one file the badge derivation used to live in.
const FEED_JOIN_COUNT = 2;

function walk(dir: string, out: string[] = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

const sourceFiles = walk(path.join(repoRoot, 'src'))
  .map((full) => ({
    rel: path.relative(repoRoot, full).split(path.sep).join('/'),
    text: readFileSync(full, 'utf8'),
  }))
  // Tests quote the SQL and the field names they pin — including this file, which named itself on its
  // first run.
  .filter((f) => !/(^|\/)__tests__(\/|$)/.test(f.rel) && !/\.(browser\.)?test\.tsx?$/.test(f.rel));

const helperText = read(HELPER);

describe('the paid-gate badge is actually produced', () => {
  it('the search index emits hasActivePaidAccess on every document', () => {
    expect(
      read(INDEX),
      'models.search-index must set hasActivePaidAccess on the indexed document — allowlisting the ' +
        'key while emitting nothing leaves search cards unbadged with every prohibition here green.'
    ).toMatch(/hasActivePaidAccess:\s*paidAccessGates/);
  });

  it('the feed sets hasActivePaidAccess from the gate map', () => {
    expect(
      read(FEED),
      'getModelsRaw must assign hasActivePaidAccess from the gate map. A constant, or dropping the ' +
        'assignment, unbadges every feed card and no prohibition in this file can see it.'
    ).toMatch(/model\.hasActivePaidAccess\s*=\s*gate\?\.gated/);
  });

  it('the card reads the flag', () => {
    expect(
      read(CARD),
      'ModelCard must read data.hasActivePaidAccess — without it the server work is inert.'
    ).toMatch(/data\.hasActivePaidAccess/);
  });
});

describe('paid-gate badge derivation lives in exactly one place', () => {
  it('no other module derives model-level gate state from PaidAccess', () => {
    const offenders = sourceFiles
      .filter((f) => f.rel !== HELPER && f.rel !== FEED)
      .filter((f) => f.text.includes(MODEL_JOIN))
      .map((f) => f.rel);

    expect(
      offenders,
      `These files join PaidAccess to ModelVersion themselves instead of calling ` +
        `getModelPaidAccessGates(). The feed and the search index must not each carry a copy — that ` +
        `is how the badge ends up correct on one surface and missing on the other, with nothing failing.`
    ).toEqual([]);
  });

  it('model.service.ts still carries exactly the two filter copies, and no more', () => {
    const count = read(FEED).split(MODEL_JOIN).length - 1;

    expect(
      count,
      `model.service.ts holds ${FEED_JOIN_COUNT} known PaidAccess->ModelVersion joins, both for the ` +
        `feed FILTER (getActiveEarlyAccessModelIds, getPermanentPaidAccessModelIds). A third is a new ` +
        `copy of the badge rule in the file it used to live in. If you legitimately added or removed ` +
        `a filter, update FEED_JOIN_COUNT and say so.`
    ).toBe(FEED_JOIN_COUNT);
  });

  it('every file that sets hasActivePaidAccess imports the helper from the owning module', () => {
    // Matches the object-literal key, a plain assignment, and shorthand — the three ways to write it.
    const setsField = /hasActivePaidAccess\s*[:=]|\{\s*hasActivePaidAccess\s*[,}]/;
    // The module path matters: importing a same-named function from a local copy is the divergence
    // this guard exists to stop, and a name-only check waves it through.
    const importsHelper =
      /import \{[^}]*getModelPaidAccessGates[^}]*\} from '~\/server\/services\/paid-access\.service'/s;

    const offenders = sourceFiles
      .filter((f) => f.rel !== HELPER && f.rel !== CARD)
      .filter((f) => setsField.test(f.text))
      .filter((f) => !importsHelper.test(f.text))
      .map((f) => f.rel);

    expect(
      offenders,
      `These files build a hasActivePaidAccess value without importing getModelPaidAccessGates from ` +
        `~/server/services/paid-access.service.`
    ).toEqual([]);
  });
});

describe('the derivation says what it means', () => {
  it('the row predicate is exactly isPaidAccessActive, with nothing narrowing it', () => {
    // Anchored WHERE..GROUP BY rather than `toContain`, because `toContain` is satisfied while an
    // EXTRA conjunct narrows the result. `AND timeframeDays IS NULL` re-introduces the exact bug this
    // guard's own history is about — the 36 published versions whose timed gate was never
    // materialized, paywalled and unbadged — and a substring check cannot see it.
    const where = helperText.match(/WHERE pa\."entityType"[\s\S]*?GROUP BY/);

    expect(
      where?.[0],
      'getModelPaidAccessGates has no recognisable WHERE..GROUP BY block'
    ).toBeTruthy();
    expect(
      where?.[0],
      'The predicate must be entityType + isPaidAccessActive + Published + the id list, and nothing ' +
        'else. An added conjunct silently narrows which gates get a badge.'
    ).toBe(
      `WHERE pa."entityType" = 'ModelVersion'\n` +
        `      AND (pa."endsAt" IS NULL OR pa."endsAt" > NOW())\n` +
        `      AND mv.status = 'Published'::"ModelStatus"\n` +
        `      AND mv."modelId" IN (\${Prisma.join(modelIds)})\n` +
        `    GROUP BY`
    );
  });

  it('the SQL predicate still matches the TypeScript contract it claims to translate', () => {
    // `isPaidAccessActive` lives in packages/, which this guard's walk() cannot reach — so the same
    // rule is stated on both sides of a package boundary with nothing holding them together. Change
    // the TS and the SQL diverges silently.
    expect(
      read(CONTRACT),
      'isPaidAccessActive changed shape. The SQL in getModelPaidAccessGates is a hand translation of ' +
        'it — re-check `(endsAt IS NULL OR endsAt > NOW())` against the new definition, then update ' +
        'this assertion.'
    ).toMatch(/isPaidAccessActive[\s\S]{0,200}row\.endsAt == null \|\| row\.endsAt > now/);
  });
});

describe('the badge reaches the search surface', () => {
  it('hasActivePaidAccess is inside the models index displayedAttributes array', () => {
    const indexText = read(INDEX);
    // Slice the array literal rather than matching across the file: an unbounded `[\s\S]*` is
    // satisfied by the key appearing in any LATER array (filterableAttributes is built in the same
    // function), which would pass while Meilisearch strips the field.
    const block = indexText.match(/const displayedAttributes = \[([\s\S]*?)\];/);

    expect(block?.[1], 'displayedAttributes is no longer a literal array here').toBeTruthy();
    expect(
      block?.[1],
      `'hasActivePaidAccess' must be in displayedAttributes, or Meilisearch strips it and the badge ` +
        `silently disappears from search while remaining correct in the feed.`
    ).toContain("'hasActivePaidAccess'");
  });

  it('earlyAccessDeadline is coerced to a Date on the search path', () => {
    // Meili returns dates as ISO strings. The type says Date, so nothing else catches this: the card
    // compares `deadline > new Date()`, and string > Date is NaN — false forever, so the Early Access
    // badge simply never renders on /search/models.
    expect(
      read(TRANSFORM),
      'transformModelHits must coerce earlyAccessDeadline — the type claims Date while Meili returns ' +
        'a string, and the card silently stops showing Early Access in search.'
    ).toMatch(/earlyAccessDeadline:[\s\S]{0,120}new Date\(item\.earlyAccessDeadline\)/);
  });
});
