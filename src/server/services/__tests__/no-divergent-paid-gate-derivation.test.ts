import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * The model feed and the model search index derive the SAME card badge from the SAME table. They held
 * two near-identical copies of that query until 868m1r2u7, which is the shape where a change lands in
 * one and not the other: the badge is right in the feed, missing in search, both look correct alone,
 * and nothing fails.
 *
 * WHAT THIS COVERS: the badge derivation, and its delivery to the search surface.
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
  // Tests quote the SQL and the field names they pin — including this file, which named itself on its
  // first run.
  .filter((f) => !/(^|\/)__tests__(\/|$)/.test(f.rel) && !/\.(browser\.)?test\.tsx?$/.test(f.rel));

const helperText = readFileSync(path.join(repoRoot, HELPER), 'utf8');

describe('paid-gate badge derivation lives in exactly one place', () => {
  it('no other module derives model-level gate state from PaidAccess', () => {
    const offenders = sourceFiles
      .filter((f) => f.rel !== HELPER)
      // The join that turns PaidAccess rows into a per-MODEL answer. The two filter helpers named in
      // the header also match it, so model.service.ts is excluded BY NAME — a pattern narrow enough
      // to miss them would also miss a new copy.
      .filter((f) => /JOIN "ModelVersion" mv ON mv\.id = pa\."entityId"/.test(f.text))
      .map((f) => f.rel)
      .filter((rel) => rel !== 'src/server/services/model.service.ts');

    expect(
      offenders,
      `These files join PaidAccess to ModelVersion themselves instead of calling ` +
        `getModelPaidAccessGates(). The feed and the search index must not each carry a copy — that ` +
        `is how the badge ends up correct on one surface and missing on the other, with nothing failing.`
    ).toEqual([]);
  });

  it('every file that sets hasActivePaidAccess imports the helper', () => {
    // Matches the object-literal key, a plain assignment, and shorthand — the three ways to write it.
    // A guard keyed only on `hasActivePaidAccess:` let the other two walk past.
    const setsField = /hasActivePaidAccess\s*[:=]|\{\s*hasActivePaidAccess\s*[,}]/;

    const offenders = sourceFiles
      .filter((f) => f.rel !== HELPER)
      .filter((f) => setsField.test(f.text))
      .filter((f) => !/import \{[^}]*getModelPaidAccessGates/s.test(f.text))
      .map((f) => f.rel);

    expect(
      offenders,
      `These files build a hasActivePaidAccess value without importing getModelPaidAccessGates().`
    ).toEqual([]);
  });

  it('the row predicate is isPaidAccessActive, not a timeframeDays test', () => {
    // Pinned by spelling, the same trade as no-lint-rules-script-drift: a reword goes red for a
    // non-defect, which is cheaper than what it replaces.
    //
    // This clause IS the definition of "paid right now", and every plausible rewrite of it is a
    // user-visible bug nothing else here can see. `endsAt > NOW()` alone drops every permanent gate.
    // Keying on `timeframeDays` drops the 36 published versions on prod whose timed gate was never
    // materialized — paywalled, endsAt NULL, timeframeDays set — and in the other direction admits
    // expired tombstones, which are never deleted.
    expect(
      helperText,
      'getModelPaidAccessGates must admit a row on (endsAt IS NULL OR endsAt > NOW()) — that is ' +
        'isPaidAccessActive in SQL, and anything else mislabels a real gate.'
    ).toContain('(pa."endsAt" IS NULL OR pa."endsAt" > NOW())');
  });

  it('an unpublished version cannot gate the card', () => {
    expect(
      helperText,
      'getModelPaidAccessGates must still filter on mv.status = Published.'
    ).toContain(`mv.status = 'Published'::"ModelStatus"`);
  });
});

describe('the badge reaches the search surface', () => {
  it('hasActivePaidAccess is served by the models index', () => {
    const indexText = readFileSync(path.join(repoRoot, INDEX), 'utf8');

    // Meili returns only what displayedAttributes allowlists. Drop the key and the derivation stays
    // perfectly unified while the search-served card reads `undefined` — the original bug restored,
    // with every other check in this file still green.
    expect(
      indexText,
      `'hasActivePaidAccess' must be in the models index displayedAttributes, or Meilisearch strips it and ` +
        `the badge silently disappears from search while remaining correct in the feed.`
    ).toMatch(/displayedAttributes[\s\S]*'hasActivePaidAccess'[\s\S]*\]/);
  });

  it('earlyAccessDeadline is coerced to a Date on the search path', () => {
    const transform = readFileSync(
      path.join(repoRoot, 'src/shared/search/models-transform.ts'),
      'utf8'
    );

    // Meili returns dates as ISO strings. The type says Date, so nothing else catches this: the card
    // compares `deadline > new Date()`, and string > Date is NaN — false forever, so the Early Access
    // badge simply never renders on /search/models.
    expect(
      transform,
      'transformModelHits must coerce earlyAccessDeadline — the type claims Date while Meili returns ' +
        'a string, and the card silently stops showing Early Access in search.'
    ).toMatch(/earlyAccessDeadline:[\s\S]{0,120}new Date\(item\.earlyAccessDeadline\)/);
  });
});
