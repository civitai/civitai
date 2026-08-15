import { readFileSync } from 'fs';
import { readdir, readFile, stat } from 'fs/promises';
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

/**
 * 🔴 WHY THE SCAN IS SHAPED LIKE THIS — it fixes a measured flake, not a style nit.
 *
 * The original scan read all ~3.5k source files with a SERIAL `readFileSync` and
 * comment-stripped every one, lazily on first use — which charged the entire cost
 * to the body of whichever test happened to run first. That is LATENCY-bound work
 * (thousands of blocking syscalls), so it does not degrade like the rest of the
 * suite: CPU-bound tests slow by a few percent under load, while this one scales
 * with per-read latency. Observed on CI, unchanged, across three PRs: 6995ms,
 * 8303ms, then 68197ms — the last one blowing the 60s `testTimeout` and reporting
 * as a failure of an unrelated change. The run that died was the FASTEST of the
 * three overall (380s vs 437s) and exactly ONE test inflated, which is the
 * signature of a latency-bound test rather than a loaded box.
 *
 * Three things keep it from coming back. None of them narrows WHAT is scanned —
 * narrowing is the one change this guard may never make, because a file that is
 * never read cannot be found guilty:
 *
 *  1. ONE pass, at module scope. Every case asserts against a precomputed result
 *     instead of triggering the scan itself. Module scope also puts it in
 *     Vitest's COLLECTION phase, which no timeout bounds — see the `testTimeout`
 *     comment in vitest.config.mts, which prescribes exactly this hoist. A slow
 *     disk can now make this file slow; it can no longer make it RED.
 *  2. Reads are issued CONCURRENTLY. Serial blocking reads are the thing that
 *     multiplies under I/O contention.
 *  3. Files are prefiltered on their raw BYTES; only the handful that could
 *     possibly match are decoded and comment-stripped (~30 of ~3553). See
 *     `INTERESTING` for why that is sound rather than a narrowing.
 */

const SPEND_FIELDS = ['spendTier', 'spendCapBuzzPerDay', 'spendVelocityMaxGens'] as const;

/**
 * Positive control on the CASE COUNT. `it.each(SPEND_FIELDS)` generates one test
 * per entry, so a trimmed — or emptied — list silently generates fewer, or zero,
 * cases and the suite still reports green. Pinned so shrinking the population is
 * a failure rather than a quieter pass.
 */
const EXPECTED_SPEND_FIELD_COUNT = 3;

/** The ONE module allowed to write the spend columns (mod-gated at the router). */
const AUTHORISED_WRITER = 'src/server/services/block-registry.service.ts';

/** The ONE schema module allowed to declare a spend-column input (mod-only). */
const AUTHORISED_SCHEMA = 'src/server/schema/blocks/subscription.schema.ts';

/**
 * The developer-reachable write paths, enumerated explicitly: the JOB_TOKEN
 * manifest endpoint, the build callback, the moderator approve/publish flow and
 * the offsite/screenshot services. None of them may carry a spend field — new
 * rows take the DB default ('standard'), forever, unless a moderator acts.
 */
const PUBLISHER_REACHABLE = [
  'src/pages/api/v1/developer/block-manifests.ts',
  'src/pages/api/internal/blocks/build-callback.ts',
  'src/server/services/blocks/publish-request.service.ts',
  'src/server/services/blocks/offsite-moderation.service.ts',
  'src/server/services/blocks/autogenerate-screenshot.service.ts',
  'src/server/routers/blocks.router.ts',
];

/** The snake_case column name, checked alongside the camelCase Prisma fields. */
const RAW_COLUMN = 'spend_tier';

const APPBLOCK_WRITE = /appBlock\.(create|update|updateMany|upsert)\b/;

/** The literal every `APPBLOCK_WRITE` match necessarily contains. */
const APPBLOCK_LITERAL = 'appBlock.';

/**
 * Every token whose presence has to be decided from the CODE view.
 *
 * 🔴 Prefiltering on raw bytes and comment-stripping only the survivors is SOUND,
 * not a narrowing, because stripping can only ever REMOVE occurrences: a block
 * comment is replaced by a single space, a line comment by the character that
 * preceded it (the newline survives — `.` does not match `\n`). Neither
 * substitution can splice a NEW token into existence, because every token here is
 * whitespace-free and the only thing either one inserts is whitespace that was
 * already adjacent. So `stripped ⊆ raw` for these needles, and a file whose bytes
 * lack the token cannot hold it in code. Bytes are searched directly rather than
 * decoded first, which is exact for ASCII needles (no UTF-8 multi-byte sequence
 * contains an ASCII byte) and skips decoding ~27MB to learn nothing.
 *
 * Verified empirically against the whole tree as well as argued: scanning every
 * file both ways, the set found by the byte prefilter was a superset of the set
 * found from stripped code for every token, with nothing missed.
 */
const INTERESTING = [...SPEND_FIELDS, RAW_COLUMN, APPBLOCK_LITERAL] as const;

const ROOT = process.cwd();

/** How many reads to keep in flight. The point is to overlap syscall latency. */
const READ_CONCURRENCY = 32;

async function walk(dir: string, out: string[]): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    // `withFileTypes` reports a symlink as neither file nor directory, whereas
    // the `statSync` walk this replaced FOLLOWED symlinks. Resolve them, so a
    // symlinked source directory keeps being scanned — silently skipping one
    // would be exactly the narrowing this guard must not do.
    const isDirectory = entry.isSymbolicLink()
      ? (await stat(full)).isDirectory()
      : entry.isDirectory();
    if (isDirectory) await walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

async function forEachConcurrent<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = cursor++; i < items.length; i = cursor++) await fn(items[i]);
  });
  await Promise.all(workers);
}

/**
 * Source with comments removed. Prose ABOUT the spend columns is exactly what
 * we want more of — the thing under test is whether any other module has CODE
 * that touches them. Scanning raw text would punish documentation.
 *
 * Load-bearing rather than decorative: `blocks.router.ts` and
 * `app-spend-cap.service.ts` each name `spendTier` in JSDoc and nowhere else, so
 * without the strip both would read as offenders.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

type Scan = {
  /** Every non-test .ts/.tsx under src/, as repo-relative paths. */
  files: string[];
  /** token -> the files whose CODE (comments stripped) mentions it. */
  mentions: Record<string, string[]>;
  /** Files holding a Prisma create/update/upsert against `appBlock`. */
  appBlockWriteSites: string[];
  /** Comment-stripped source, for the files the scan kept. */
  code: Map<string, string>;
  /** Raw text, kept only for the publisher-facing modules (raw-vs-code control). */
  raw: Map<string, string>;
};

const SCANNED_TOKENS = [...SPEND_FIELDS, RAW_COLUMN] as const;

async function scanSourceTree(): Promise<Scan> {
  // Repo-relative paths are IDENTIFIERS here — matched against the `/`-separated
  // literals in PUBLISHER_REACHABLE and by `/`-anchored regexes — so they carry
  // posix separators on every platform. Without this `alwaysDecode` never hits on
  // Windows, and the ENOENT that is supposed to announce a renamed publisher path
  // silently becomes an empty `raw` map instead.
  const scanned = (await walk(join(ROOT, 'src'), []))
    .map((abs) => ({ abs, file: relative(ROOT, abs).replace(/\\/g, '/') }))
    .filter(({ file }) => !/__tests__|\.test\.tsx?$|(^|\/)src\/tests\//.test(file));
  const files = scanned.map((s) => s.file);

  const code = new Map<string, string>();
  const raw = new Map<string, string>();
  // Always decoded, whatever the prefilter says: these are the paths the
  // publisher-facing assertion names. Reading them unconditionally keeps a
  // renamed or deleted path a loud ENOENT instead of a silently vacuous pass.
  const alwaysDecode = new Set<string>(PUBLISHER_REACHABLE);

  await forEachConcurrent(scanned, READ_CONCURRENCY, async ({ abs, file }) => {
    // Read the path the walk produced, never the normalised key: the key is an identifier,
    // and handing a posix-separated string back to the filesystem happens to work today but
    // would not under a `\\?\` prefixed path.
    const bytes = await readFile(abs);
    if (!alwaysDecode.has(file) && !INTERESTING.some((t) => bytes.includes(t))) return;
    const text = bytes.toString('utf8');
    if (alwaysDecode.has(file)) raw.set(file, text);
    code.set(file, stripComments(text));
  });

  // Classify in `files` order, so every list below is deterministic and matches
  // the order a straight filter over the tree walk would have produced.
  const mentions: Record<string, string[]> = Object.fromEntries(
    SCANNED_TOKENS.map((t) => [t, [] as string[]])
  );
  const appBlockWriteSites: string[] = [];
  for (const file of files) {
    const src = code.get(file);
    if (src === undefined) continue;
    for (const token of SCANNED_TOKENS) if (src.includes(token)) mentions[token].push(file);
    if (APPBLOCK_WRITE.test(src)) appBlockWriteSites.push(file);
  }

  return { files, mentions, appBlockWriteSites, code, raw };
}

// Module scope on purpose — see the cost note above. This lands in Vitest's
// collection phase, so no per-test timeout is ever charged for it.
const SCAN = await scanSourceTree();

describe('the spend columns have exactly ONE write surface', () => {
  it('enumerates a non-trivial population (the scan itself is working)', () => {
    // Guard against the vacuous-pass mode: a broken walk would make every
    // assertion below trivially true.
    expect(SCAN.files.length).toBeGreaterThan(500);
    expect(SCAN.files).toContain(AUTHORISED_WRITER);
    expect(SCAN.files).toContain(AUTHORISED_SCHEMA);

    // Case-count control: the `it.each` below shrinks silently if SPEND_FIELDS is
    // ever trimmed, and a zero-case `it.each` reports green.
    expect(SPEND_FIELDS.length).toBe(EXPECTED_SPEND_FIELD_COUNT);
  });

  it('the CODE scan can actually see a spend column (positive control)', () => {
    // Everything below is reassured by an EMPTY list, which a scan wired to
    // nothing — or a `stripComments` that blanked its input — produces just as
    // readily. So pin a known TRUE positive first: the mod-only schema declares
    // all three columns in real code and must be observed doing so.
    for (const field of SPEND_FIELDS) {
      expect(SCAN.mentions[field], `nothing was observed to mention ${field} in code`).toContain(
        AUTHORISED_SCHEMA
      );
    }

    // ...and pin that comment stripping is live rather than a no-op: the router
    // names `spendTier` in JSDoc only, so it must be present in the bytes and
    // absent from the code view.
    const router = 'src/server/routers/blocks.router.ts';
    expect(SCAN.raw.get(router)).toContain('spendTier');
    expect(SCAN.code.get(router)).not.toContain('spendTier');
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
      const offenders = SCAN.mentions[field].filter((f) => !allowed.has(f));
      expect(offenders).toEqual([]);
    }
  );

  it('no PUBLISHER-facing module mentions the spend columns at all', () => {
    for (const file of PUBLISHER_REACHABLE) {
      // blocks.router.ts hosts the MOD-ONLY procedures, which reference the
      // schemas by name but never the column names themselves.
      const src = SCAN.code.get(file);
      expect(src, `${file} was not read — is the path stale?`).toBeDefined();
      for (const field of SPEND_FIELDS) {
        expect(src!.includes(field), `${file} must not reference ${field} in code`).toBe(false);
      }
      expect(src!.includes(RAW_COLUMN), `${file} must not reference ${RAW_COLUMN}`).toBe(false);
    }
  });

  it('every Prisma write against appBlock is accounted for', () => {
    // Audit the POPULATION: find every appBlock create/update/upsert in the tree
    // and assert each one either belongs to the authorised writer or carries no
    // spend field. A brand-new write site added later lands here.
    const writeSites = SCAN.appBlockWriteSites;
    expect(writeSites.length).toBeGreaterThan(3); // the scan found real sites
    expect(writeSites).toContain(AUTHORISED_WRITER);
    for (const file of writeSites) {
      if (file === AUTHORISED_WRITER) continue;
      const src = SCAN.code.get(file)!;
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
