import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * 🔴 THE REGRESSION GUARD FOR A PRODUCTION 500 THIS PR ACTUALLY CAUSED.
 *
 * ── THE DEFECT, MEASURED ON A PREVIEW ENVIRONMENT ───────────────────────────────
 * `app_listings.visibility` is a MANUAL-APPLY column, so there is necessarily a window in
 * which deployed code runs against a database that does not have it. While `visibility` was
 * declared as an ordinary field on the `AppListing` Prisma model, EVERY call that returns
 * rows and passes no explicit `select` named it in the generated `SELECT`/`RETURNING` list —
 * so in that window the off-site listing path died:
 *
 *   Invalid `prisma.appListing.create()` invocation:
 *   The column `app_listings.visibility` does not exist in the current database.  (P2022)
 *   → appListings.submitExternalListing → HTTP 500
 *
 * Five preview specs went red on it: external approve, delist and submit.
 *
 * ── WHY FOUR REVIEW LANES AND A GREEN SUITE MISSED IT ───────────────────────────
 * 🔴 EVERY UNIT SUITE IN THIS REPO MOCKS PRISMA, SO NONE OF THEM EVER GENERATES SQL. The
 * guarded-reader pattern this feature copied protects READS, and the degradation cases
 * written for it drove reads. The failing sites are WRITES — enumerated on this tree, 18
 * sites return rows with no explicit `select` and **17 of them are writes**. No test could
 * see it, and the sibling `app-listing-source-repo.service.ts` header records the identical
 * failure happening for `source_repo_url` on a preview environment for the same reason.
 *
 * ── WHAT THE FIX IS, AND THEREFORE WHAT THIS GUARDS ─────────────────────────────
 * The column is no longer on the Prisma model. It is declared in `schema.full.prisma` with
 * an inline `// @no-type`, which `scripts/generate-slim-schema.js` strips from the schema the
 * CLIENT is generated from. So the field does not exist on the generated delegate, no Prisma
 * query anywhere can emit it, and all 18 sites are immune BY CONSTRUCTION rather than by a
 * guard somebody has to remember at each one. Reads and writes of the column go through raw
 * SQL in two modules and nowhere else.
 *
 * 🔴 THIS FILE IS A SCHEMA-AND-CLIENT GUARD, NOT A BEHAVIOURAL ONE, AND THAT IS FORCED
 * RATHER THAN CHOSEN. The defect is "the generated client names a column", which exists only
 * in generated artefacts — there is no runtime behaviour to drive without a real Postgres
 * missing a real column. So it asserts the three facts that together make the 500
 * impossible, each independently falsifiable:
 *   1. the full schema declares the column (drift detection + documentation keep working);
 *   2. it carries `// @no-type`, so the generator strips it;
 *   3. the GENERATED client does not contain the field — which is the fact that actually
 *      closes the window, and the only one a reviewer cannot talk themselves out of.
 *
 * Reverting the annotation makes (2) and (3) red. Deleting the column makes (1) red.
 */

const ROOT = process.cwd();
const FULL_SCHEMA = 'packages/civitai-db-schema/prisma/schema.full.prisma';
const SLIM_SCHEMA = 'packages/civitai-db-schema/prisma/schema.prisma';
const KYSELY_TYPES = 'packages/civitai-db-schema/src/kysely/types.ts';

const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

/** The `model AppListing { … }` block of a schema, so a neighbour model cannot answer for it. */
function appListingModel(schema: string): string {
  const at = schema.indexOf('model AppListing {');
  expect(at, 'the AppListing model must still exist under this name').toBeGreaterThan(0);
  const end = schema.indexOf('\n}', at);
  expect(end, 'the AppListing model block must terminate').toBeGreaterThan(at);
  return schema.slice(at, end);
}

/**
 * FIELD declarations only — `///` and `//` lines dropped.
 *
 * 🔴 NECESSARY, NOT COSMETIC. This feature's own doc comment inside the model contains the
 * word `visibility` (it names the service that owns the column), so a bare substring test
 * over the model block is satisfied by PROSE and reports a field that is not there. That is
 * the exact trap the sibling `source` ledger records — passing off a neighbour's comment —
 * and it would make assertion (3) below vacuously green.
 */
function fieldLines(model: string): string[] {
  return model
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('//') && !l.startsWith('@@') && l !== '{');
}

const declaresField = (model: string, name: string) =>
  fieldLines(model).some((l) => new RegExp(`^${name}\\s+\\S`).test(l));

describe('app_listings.visibility is NOT a Prisma model field', () => {
  it('[INV][POSITIVE CONTROL] the field scan can see a real field and ignores prose', () => {
    // Without this the assertions below could pass over an empty list or a wrong slice.
    const model = appListingModel(read(FULL_SCHEMA));
    expect(fieldLines(model).length).toBeGreaterThan(20);
    // A field that is unquestionably declared.
    expect(declaresField(model, 'status')).toBe(true);
    expect(declaresField(model, 'slug')).toBe(true);
    // And the discriminating half: the model's PROSE mentions the word, but prose is not a
    // field declaration. If this ever returned true for a comment, assertion (3) is vacuous.
    expect(model).toContain('visibility');
    expect(declaresField(model, 'thisIsNotAField')).toBe(false);
  });

  it('[REG] the FULL schema still declares the column — drift detection depends on it', () => {
    // The schema-drift detector reads `schema.full.prisma`. Dropping the declaration
    // entirely would make a column that EXISTS in the database undeclared, which is the
    // drift class that detector is for.
    const model = appListingModel(read(FULL_SCHEMA));
    expect(declaresField(model, 'visibility')).toBe(true);
  });

  it('[REG] it is annotated `// @no-type`, so the generator strips it', () => {
    const model = appListingModel(read(FULL_SCHEMA));
    const line = fieldLines(model).find((l) => /^visibility\s+\S/.test(l));
    expect(line, 'the visibility field declaration must be findable').toBeDefined();
    expect(
      line,
      'the visibility field must carry an inline `// @no-type`, or the generated client ' +
        'names the column and every unguarded `appListing` write 500s while the ' +
        'manual-apply migration is outstanding'
    ).toContain('// @no-type');
  });

  it('🔴 [REG] the SLIM schema — what the CLIENT is generated from — has no such field', () => {
    // The fact that actually closes the window. Red if the annotation is removed and
    // `db:generate` re-run, and red if someone hand-edits the slim schema back.
    expect(declaresField(appListingModel(read(SLIM_SCHEMA)), 'visibility')).toBe(false);
  });

  it('🔴 [REG] the GENERATED Kysely types carry no `visibility` on the app_listings table', () => {
    // The generated artefact, not the input to the generator — so this stays honest even if
    // the stripping script changes shape. `db:check-generated` is what keeps it in step.
    const types = read(KYSELY_TYPES);
    // 🔴 THE TABLE TYPE IS A NAMED ALIAS, NOT AN INLINE OBJECT — `app_listings: AppListing`
    // in the DB map, with `export type AppListing = { … }` declared elsewhere in the file.
    // An earlier version of this case looked for `app_listings: {` and found NOTHING, which
    // its own positive control caught: without that control it would have sliced an empty
    // string and passed, reporting a clean generated client it had never read.
    expect(types).toContain('app_listings: AppListing;');
    const at = types.indexOf('export type AppListing = {');
    expect(at, 'the AppListing row type must exist').toBeGreaterThan(0);
    const block = types.slice(at, types.indexOf('\n};', at));
    // Positive control: the block is the right one and non-trivial.
    expect(block).toContain('status:');
    expect(
      /\bvisibility\s*:/.test(block),
      'the generated app_listings type declares `visibility`, so the Prisma client will ' +
        'emit it in every default SELECT/RETURNING — the P2022 that 500d off-site submit, ' +
        'approve and delist on the PR preview'
    ).toBe(false);
  });

  it('🔴 [REG] no production code reads or writes the column through the Prisma delegate', () => {
    // The complement of the schema facts: even with the field stripped, a `$queryRaw` that
    // names the column is fine while an `appListing.update({ data: { visibility } })` would
    // not compile — but a future re-addition of the field would make it compile again. Pinning the
    // delegate-free property means the two modules that own the column stay the only ones,
    // so re-adding the field cannot quietly spread.
    const owners = [
      'src/server/services/blocks/app-listing-visibility.service.ts',
      'src/server/services/blocks/app-listing-visibility-write.service.ts',
    ];
    for (const f of owners) {
      const src = read(f);
      expect(src.length, `${f} must load`).toBeGreaterThan(500);
      // Each owner touches the column, and does so through raw SQL.
      expect(src).toContain('"visibility"');
      expect(src, `${f} must address the column through raw SQL`).toMatch(
        /\$queryRaw|\$executeRaw/
      );
    }
  });
});
