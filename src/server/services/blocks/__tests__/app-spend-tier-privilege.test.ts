import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * PRIVILEGE SURFACE for the per-app SPEND columns (`spendTier`,
 * `spendCapBuzzPerDay`, `spendVelocityMaxGens`).
 *
 * 🔴 THE INVARIANT: an app's developer must never be able to raise their own
 * abuse ceiling. Two separate suites already prove the mod gate holds on the one
 * surface that exists (`blocks.router.appSpendCapConfig.test.ts`) and that the
 * developer manifest endpoint drops the keys (`block-manifests.test.ts`, which
 * drives the real handler). What THIS suite adds is the property those two
 * cannot express: that the surface set is CLOSED.
 *
 * A per-endpoint test only ever covers the endpoints someone remembered to
 * write a test for. So instead of asserting about a handed set, this enumerates
 * the POPULATION from the source tree — every Prisma write against `appBlock`,
 * every zod schema, the canonical manifest schema — and asserts the spend
 * columns appear in exactly one of them. A new publisher-facing write path that
 * touches these columns fails here even though nobody thought to test it.
 *
 * These are source-level assertions on purpose: the thing being defended is
 * "no OTHER code exists", which no amount of exercising the code that does
 * exist can establish.
 */

const SPEND_FIELDS = ['spendTier', 'spendCapBuzzPerDay', 'spendVelocityMaxGens'] as const;

/** The ONE module allowed to write the spend columns (mod-gated at the router). */
const AUTHORISED_WRITER = 'src/server/services/block-registry.service.ts';

/** The ONE schema module allowed to declare a spend-column input (mod-only). */
const AUTHORISED_SCHEMA = 'src/server/schema/blocks/subscription.schema.ts';

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === '.git') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Every non-test .ts/.tsx under src/, as repo-relative paths. */
function sourceFiles(): string[] {
  return walk(join(ROOT, 'src'))
    .map((f) => relative(ROOT, f))
    .filter((f) => !/__tests__|\.test\.tsx?$|(^|\/)src\/tests\//.test(f));
}

const FILES = sourceFiles();

/**
 * Source with comments removed. Prose ABOUT the spend columns is exactly what
 * we want more of — the thing under test is whether any other module has CODE
 * that touches them. Scanning raw text would punish documentation.
 */
function code(file: string): string {
  return readFileSync(join(ROOT, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const codeCache = new Map<string, string>();
function codeOf(file: string): string {
  let c = codeCache.get(file);
  if (c === undefined) {
    c = code(file);
    codeCache.set(file, c);
  }
  return c;
}

function filesMentioning(token: string): string[] {
  return FILES.filter((f) => codeOf(f).includes(token));
}

describe('the spend columns have exactly ONE write surface', () => {
  it('enumerates a non-trivial population (the scan itself is working)', () => {
    // Guard against the vacuous-pass mode: a broken walk would make every
    // assertion below trivially true.
    expect(FILES.length).toBeGreaterThan(500);
    expect(FILES).toContain(AUTHORISED_WRITER);
    expect(FILES).toContain(AUTHORISED_SCHEMA);
  });

  it.each(SPEND_FIELDS)(
    '`%s` is written by block-registry.service.ts and nowhere else',
    (field) => {
      // The resolver reads them (a `select`), the schema declares the mod input,
      // and the registry writes them. Anything else is a new privilege path.
      const allowed = new Set([
        AUTHORISED_WRITER,
        AUTHORISED_SCHEMA,
        'src/server/services/blocks/app-cap-limits.constants.ts',
        'src/server/services/blocks/app-cap-limits.service.ts',
      ]);
      const offenders = filesMentioning(field).filter((f) => !allowed.has(f));
      expect(offenders).toEqual([]);
    }
  );

  it('no PUBLISHER-facing module mentions the spend columns at all', () => {
    // The developer-reachable write paths, enumerated explicitly: the JOB_TOKEN
    // manifest endpoint, the build callback, the moderator approve/publish flow
    // and the offsite/screenshot services. None of them may carry a spend field
    // — new rows take the DB default ('standard'), forever, unless a moderator
    // acts.
    const publisherReachable = [
      'src/pages/api/v1/developer/block-manifests.ts',
      'src/pages/api/internal/blocks/build-callback.ts',
      'src/server/services/blocks/publish-request.service.ts',
      'src/server/services/blocks/offsite-moderation.service.ts',
      'src/server/services/blocks/autogenerate-screenshot.service.ts',
      'src/server/routers/blocks.router.ts',
    ];
    for (const file of publisherReachable) {
      // blocks.router.ts hosts the MOD-ONLY procedures, which reference the
      // schemas by name but never the column names themselves.
      const src = codeOf(file);
      for (const field of SPEND_FIELDS) {
        expect(src.includes(field), `${file} must not reference ${field} in code`).toBe(false);
      }
      expect(src.includes('spend_tier'), `${file} must not reference spend_tier`).toBe(false);
    }
  });

  it('every Prisma write against appBlock is accounted for', () => {
    // Audit the POPULATION: find every appBlock create/update/upsert in the tree
    // and assert each one either belongs to the authorised writer or carries no
    // spend field. A brand-new write site added later lands here.
    const writeSites = FILES.filter((f) =>
      /appBlock\.(create|update|updateMany|upsert)\b/.test(codeOf(f))
    );
    expect(writeSites.length).toBeGreaterThan(3); // the scan found real sites
    expect(writeSites).toContain(AUTHORISED_WRITER);
    for (const file of writeSites) {
      if (file === AUTHORISED_WRITER) continue;
      const src = codeOf(file);
      for (const field of SPEND_FIELDS) {
        expect(src.includes(field), `${file} writes appBlock and references ${field}`).toBe(false);
      }
    }
  });
});

describe('the manifest cannot declare a spend ceiling', () => {
  const manifestSchema = JSON.parse(
    readFileSync(join(ROOT, 'public/schemas/app-block/v1.json'), 'utf8')
  ) as { properties: Record<string, unknown>; additionalProperties?: boolean };

  it('the canonical manifest schema has no spend property', () => {
    for (const field of SPEND_FIELDS) {
      expect(Object.keys(manifestSchema.properties)).not.toContain(field);
    }
    expect(Object.keys(manifestSchema.properties).filter((k) => /^spend/i.test(k))).toEqual([]);
  });

  it('still declares trustTier — the two axes are separate, not merged', () => {
    // Sanity that the schema being read is the real one AND that this change did
    // not simply delete the trust axis: `trustTier` still exists, still gates the
    // iframe sandbox, and now has nothing to do with money.
    expect(Object.keys(manifestSchema.properties)).toContain('trustTier');
  });
});
