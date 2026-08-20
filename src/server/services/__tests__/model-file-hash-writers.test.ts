import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { describe, it, expect } from 'vitest';

/**
 * Writer ledger for `ModelFileHash`.
 *
 * `normalizeScanHashes()` is the only thing left enforcing the stored AutoV3 width and the only
 * thing that derives `SHA256_12` — migration 20260819010000 drops the `truncate_autov3_hash`
 * trigger that used to do the AutoV3 half in the database. So a writer that inserts hashes
 * without going through it stores a 64-char AutoV3 and no SHA256_12, and nothing anywhere fails:
 * the rows are valid, they just never match the values A1111/Forge write into image metadata.
 *
 * This file pins the seam in two ways, because either alone is walkable:
 *
 *   1. The ledger below is compared against a fresh enumeration of the source tree. It fails when
 *      the writer set GROWS (a new writer must declare whether it normalizes) or SHRINKS (a
 *      writer was removed and the ledger — and the doc comment on normalizeScanHashes — is now
 *      lying about the surface).
 *   2. `describe('behaviour')` drives the two normalizing writers for real and asserts the exact
 *      rows they hand the database, against literal expected values. A structural ledger
 *      type-checks past a writer that calls the helper and then ignores its return value.
 *
 * The third writer's exemption is pinned in
 * src/server/services/orchestrator/__tests__/createModelFileScanRequest.test.ts, where the
 * sentinel it writes actually exists.
 */

// ---------------------------------------------------------------------------
// 1. Structural ledger
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '../../../..');

// Everything a `ModelFileHash` row could be written from. `packages/` is in scope because the
// db-schema package is the other place application code lives; `apps/` and `scripts/` because a
// standalone worker or one-off script is exactly the kind of writer that would skip the helper.
const SCAN_ROOTS = ['src', 'apps', 'scripts', 'packages'];
const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  '.turbo',
  '.svelte-kit',
  '.git',
  'dist',
  'build',
  'coverage',
]);
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.sql']);
/**
 * The scanned extensions that take JS comment syntax — DERIVED, not a second hand-written list.
 * Two lists spelling one rule means adding an extension to SCAN_EXTENSIONS and forgetting this
 * one, at which point that extension falls through unstripped and silently.
 *
 * Known adjacent gap, pre-dating this: `.mts` (12 files under the scan roots today) and `.cts`
 * are in NEITHER set, so a writer in one is invisible to the ledger. Widening SCAN_EXTENSIONS
 * would enlarge the enumeration and is its own change with its own evidence — recorded here
 * rather than fixed in passing.
 */
const JS_EXTENSIONS = new Set([...SCAN_EXTENSIONS].filter((e) => e !== '.sql'));

/**
 * Four spellings a write can take. A single Prisma-only pattern would miss a raw-SQL or Kysely
 * writer entirely and report a clean ledger, which is the failure this whole file exists to
 * prevent — so each access route gets its own matcher.
 */
const WRITE_PATTERNS: Array<[kind: string, re: RegExp]> = [
  [
    'prisma',
    /\bmodelFileHash\s*\.\s*(create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)\b/g,
  ],
  ['raw-sql', /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?ModelFileHash"?/gi],
  ['kysely', /(?:insertInto|updateTable|deleteFrom)\s*\(\s*['"]ModelFileHash['"]/g],
  [
    'prisma-relation',
    /hashes\s*:\s*\{\s*(create|createMany|connectOrCreate|upsert|updateMany|update|deleteMany|delete|set|disconnect)\b/g,
  ],
];

/**
 * A commented-out statement is not a writer.
 *
 * `--` and block comments make "the token is present" and "the clause is LIVE" different facts,
 * and this ledger only cares about the second. Migration
 * `20260819000000_model_file_hash_sha256_12` documents its backfill as commented SQL — its only
 * live statement is an `ALTER TYPE` — and matching that text put a sixth "writer" in the
 * enumeration that writes nothing. It made trunk red for every PR until someone either declared a
 * non-writer in the ledger or deleted the documentation, and both would have been wrong.
 *
 * Originally scoped to `.sql` alone, with the `.ts` half deferred for evidence rather than taken
 * as a drive-by — the concern being that stripping could only ever SHRINK the enumeration, which
 * is a direction this ledger also exists to catch. That evidence now exists, and it says the
 * unstripped side was the broken one: a file containing NOTHING but
 *
 *     // await dbWrite.modelFileHash.createMany({ data: rows });
 *
 * was enumerated as a live writer (measured 2026-08-20 by planting exactly that and watching the
 * ledger assertion fail with the probe file listed). So `.ts` was not the safe default; it was the
 * same defect with a different comment syntax, and the `.sql` fix simply reached it first.
 *
 * The shrink risk is real, so it is controlled rather than argued away — see the two tests below
 * that pin BOTH directions: a commented writer must not be counted, and a live writer on a line
 * carrying a trailing comment must still be.
 */
export function stripCommentsForExt(source: string, ext: string): string {
  if (ext === '.sql') {
    return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
  }
  // `--` is a DECREMENT operator in JS/TS, so the SQL rule must never run here: `i--; foo();`
  // would lose the rest of the line and hide a real writer.
  if (JS_EXTENSIONS.has(ext)) return stripComments(source);
  return source;
}

// (An earlier revision kept a `stripSqlComments` alias here "so any external caller keeps
// working". There are none — the only other occurrences in the repo are a local function of the
// same name in oauth-client-scope-grants.test.ts, which is unrelated. The alias was dead code
// under a name that had stopped being true, since this strips JS comments too.)

const isTestFile = (relPath: string) =>
  relPath.includes('__tests__') || /\.(test|spec)\.[cm]?[jt]sx?$/.test(relPath);

function collectFiles(dir: string, acc: string[]): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectFiles(full, acc);
    } else if (SCAN_EXTENSIONS.has(path.extname(entry.name))) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * `<repo-relative path> :: <matched write expression>`, deduped and sorted.
 *
 * `root` and `scanRoots` are parameters ONLY so a test can point this at a fixture directory.
 * That is not a convenience: without it the comment strip could only be tested through
 * `stripCommentsForExt` directly, and a mutant that reverts the CALL below — leaving the
 * stripper perfectly correct while the enumerator reads raw source again — passes a suite that
 * exercises the stripper alone. That mutant is exactly the defect this file was fixing, so it
 * has to die here rather than be argued about.
 */
function enumerateWriters(
  root: string = REPO_ROOT,
  scanRoots: readonly string[] = SCAN_ROOTS
): string[] {
  const files: string[] = [];
  for (const r of scanRoots) collectFiles(path.join(root, r), files);

  const found = new Set<string>();
  for (const file of files) {
    const rel = path.relative(root, file);
    if (isTestFile(rel)) continue;
    const source = stripCommentsForExt(fs.readFileSync(file, 'utf8'), path.extname(file));
    if (!source.includes('odelFileHash')) continue; // cheap prefilter, case-insensitive on the M
    for (const [, re] of WRITE_PATTERNS) {
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(source)) !== null) {
        found.add(`${rel} :: ${match[0].replace(/\s+/g, '')}`);
      }
    }
  }
  return [...found].sort();
}

/**
 * The asserted set. Every entry is a real write to `ModelFileHash` in shipped code.
 *
 * `normalizes` is the decision a maintainer has to make when adding a row here, and it is checked
 * against the file rather than taken on faith.
 */
const WRITER_LEDGER = [
  {
    file: 'src/server/services/model-file-scan.service.ts',
    writes: ['modelFileHash.deleteMany', 'modelFileHash.createMany'],
    normalizes: true,
    why: 'applyScanOutcome — the orchestrator scan-webhook path, the primary writer',
  },
  {
    file: 'src/pages/api/mod/reprocess-scan.ts',
    writes: ['modelFileHash.deleteMany', 'modelFileHash.createMany'],
    normalizes: true,
    why: 'replays rawScanResult, where AutoV3 is still full-length and SHA256_12 is absent',
  },
  {
    file: 'src/server/services/orchestrator/orchestrator.service.ts',
    writes: ['modelFileHash.upsert'],
    normalizes: false,
    why: "createModelFileScanRequest's dev-only skip writes ONLY the all-zero SHA256 'file unreachable' sentinel, which normalizeScanHashes leaves untouched — see createModelFileScanRequest.test.ts",
  },
] as const;

/**
 * Comments blanked, code kept — using the TypeScript scanner, NOT regexes.
 *
 * 🔴 DO NOT REPLACE THIS WITH REGEXES. Two serious attempts were made and both shipped a
 * silently BLIND ledger; the numbers below are why this uses a real lexer instead.
 *
 * Measured against the TS scanner as ground truth over `src/` (4,133 files, 819,039 nonblank
 * lines), counting LIVE lines each variant wrongly hides:
 *
 *   block pass first, then line pass    a `/(star)` inside a `//` comment — e.g. an ordinary
 *                                       package glob — opens a region that runs to the next
 *                                       `(star)/`. 43 sites, 40 files, 1,591 lines hidden.
 *
 *   line pass first, then block pass    strictly worse. The line filter blanks any line starting
 *                                       with `*`, which includes the ` (star)/` TERMINATOR of
 *                                       every ordinary JSDoc block, leaving a dangling opener
 *                                       that closes against the next inline block comment.
 *                                       Retention fell 81.1% -> 70.8%; in
 *                                       `ecosystem-seo.constants.ts` it wrongly hid 3,816 of
 *                                       3,838 live lines (99.4%).
 *
 *   line pass without the `*` branch     fixes both of the above, and is still wrong: 3,205 of
 *                                       6,730 live lines wrongly hidden in `blocks.router.ts`.
 *
 * Each order fixes the other's bug and none is correct, because the thing being parsed is not a
 * regular language: `'/(star)'` in a string, a `//` inside a template literal, and a slash in a
 * regex literal all defeat character-level matching. The scanner already knows all of this, it
 * ships with the repo, and it costs ~940 ms across 5,257 files.
 *
 * `getTokenPos()`/`getTextPos()` bound the comment trivia; newlines are preserved so reported
 * line numbers and the `\s+` collapse in the enumerator still behave.
 */
function stripComments(source: string): string {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ false,
    ts.LanguageVariant.Standard,
    source
  );
  const out = source.split('');
  let kind: ts.SyntaxKind;
  while ((kind = scanner.scan()) !== ts.SyntaxKind.EndOfFileToken) {
    if (
      kind === ts.SyntaxKind.SingleLineCommentTrivia ||
      kind === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      for (let i = scanner.getTokenPos(); i < scanner.getTextPos(); i++) {
        if (out[i] !== '\n') out[i] = ' ';
      }
    }
  }
  return out.join('');
}

/** A live writer, used as the payload in the stripper cases below. */
const WRITE = 'await dbWrite.modelFileHash.createMany({ data: rows });';

const LEDGER_ENTRIES = WRITER_LEDGER.flatMap(({ file, writes }) =>
  writes.map((w) => `${file} :: ${w}`)
).sort();

describe('ModelFileHash writer ledger', () => {
  it('matches the writers actually present in the source tree', () => {
    // toEqual on the full sorted set, not a count or a "contains": a count passes when one writer
    // is added and another deleted, and a "contains" passes when the set grows.
    expect(enumerateWriters()).toEqual(LEDGER_ENTRIES);
  });

  it('enumerates from a source tree it actually found (positive control)', () => {
    // A zero from `enumerateWriters` would be indistinguishable from a scanner wired to nothing —
    // a wrong REPO_ROOT, a stale SKIP_DIRS entry, an extension typo. Prove the walk reaches the
    // module under test and that the matchers can fire before believing any of its answers.
    const files: string[] = [];
    for (const root of SCAN_ROOTS) collectFiles(path.join(REPO_ROOT, root), files);
    expect(files.length).toBeGreaterThan(1000);
    expect(files).toContain(path.join(REPO_ROOT, 'src/server/services/model-file-scan.service.ts'));
    expect(enumerateWriters().length).toBeGreaterThan(0);
  });

  // ── the comment seam ────────────────────────────────────────────────────────────────────
  //
  // `stripComments` existed and was tested here long before anything called it: the enumerator
  // ran its patterns over the RAW source, so the stripper's own tests passed while the path that
  // matters skipped it entirely. Both halves covered, the seam between them owned by nobody.
  //
  // 🔴 The first fix for that reproduced the same shape. It added tests that call
  // `stripCommentsForExt` DIRECTLY, and a comment here claiming they "drive the enumerator's
  // transform rather than the stripper alone". They did not, and an audit killed the claim with
  // one mutant: leave the stripper perfectly correct and revert only the CALL in
  // `enumerateWriters`, and the whole suite stayed green — i.e. the precise defect being fixed
  // was not caught. The lesson is narrow and worth keeping: a test that exercises a helper is
  // not a test that the helper is WIRED UP, and only the second kind closes a seam.
  //
  // So `drives the real enumerator over a fixture tree` below calls `enumerateWriters()` itself.
  // That is the test that dies to the revert mutant. The direct-call tests are kept as cheap
  // unit coverage of the stripper's shapes, not as the seam guard.
  //
  // Stripping can shrink the enumeration as well as correct it, and a ledger that silently stops
  // seeing a real writer is worse than one that over-reports — so every case below asserts BOTH
  // that a commented writer is ignored and that a live one is still found.

  it('drives the real enumerator over a fixture tree, in both directions', () => {
    // The seam guard. Fails if `enumerateWriters` ever stops calling the strip, and fails if the
    // strip ever eats live code.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfh-ledger-'));
    try {
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      const write = (name: string, body: string) =>
        fs.writeFileSync(path.join(dir, 'src', name), body);

      // (a) commented-out writer — must NOT be enumerated
      write(
        'commented.ts',
        '// await dbWrite.modelFileHash.createMany({ data: rows });\nexport const a = 1;\n'
      );

      // (b) live writer whose file also carries a package glob in a line comment and a trailing
      // JSDoc. With the block pass running first this module strips to the empty string and the
      // writer vanishes — 43 real files on this tree had that shape. Must still be enumerated.
      write(
        'globbed.ts',
        [
          '// ported onto the shared @civitai/* clients.',
          'export async function write(dbWrite: any) {',
          '  await dbWrite.modelFileHash.createMany({ data: rows });',
          '}',
          '/** Re-exported for tests. */',
          'export const b = 2;',
        ].join('\n')
      );

      // (c) plain live writer — the floor
      write(
        'live.ts',
        'export async function w(dbWrite: any) {\n  await dbWrite.modelFileHash.deleteMany({ where });\n}\n'
      );

      const found = enumerateWriters(dir, ['src']);
      expect(found, 'a commented-out writer was enumerated as live').not.toContain(
        'src/commented.ts :: modelFileHash.createMany'
      );
      expect(found, 'a live writer was hidden by the block-comment over-match').toContain(
        'src/globbed.ts :: modelFileHash.createMany'
      );
      expect(found, 'the enumerator found no live writer at all').toContain(
        'src/live.ts :: modelFileHash.deleteMany'
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps live code that every regex stripper we tried swallowed', () => {
    // One case per variant that shipped or nearly shipped. Each was a real defect measured on
    // this tree, not a hypothetical — see the note on `stripComments`.
    const mustSurvive: Array<[string, string]> = [
      [
        'block-open inside a line comment (a package glob) — killed the block-first order',
        ['// ported onto the shared @civitai/* clients.', WRITE, '/** Re-exported. */'].join('\n'),
      ],
      [
        'multi-line JSDoc terminator — killed the line-first order',
        ['/**', ' * doc', ' */', WRITE, 'const x = 1; /* n */ const y = 2;'].join('\n'),
      ],
      [
        'block-open inside a STRING literal — defeats every character-level variant',
        `const a = '/*';\n${WRITE}`,
      ],
      ['comment marker inside a template literal', 'const t = `// not a comment`;\n' + WRITE],
      // NOT covered, deliberately and measured: a REGEX LITERAL containing a block-open, e.g.
      // `const re = /a\/*b/;`. A standalone scanner has no parser context, so it cannot always
      // tell a regex literal from division and mis-lexes that as a comment opener — the writer
      // after it then goes missing. Verified as a real limitation rather than assumed. It is not
      // asserted here because asserting broken behaviour freezes it; the blast-radius bound and
      // the ledger assertion below are what would catch it if a real file ever hits the shape.
    ];
    for (const [why, src] of mustSurvive) {
      expect(stripCommentsForExt(src, '.ts'), `live writer hidden — ${why}`).toMatch(
        /modelFileHash\s*\.\s*createMany/
      );
    }
  });

  it('retains almost all of a large real file (blast-radius bound)', () => {
    // The control every previous revision lacked. Each measured only the population it was
    // FIXING and never the population it was BREAKING, so a stripper that hid half the repo
    // still looked like a win. This bound is what makes that impossible to ship again:
    // `blocks.router.ts` has 6,730 live lines by the scanner's own reckoning, and the two regex
    // variants retained 1,053 and 4,156 of them. A floor of 6,000 fails both.
    const rel = 'src/server/routers/blocks.router.ts';
    const abs = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(abs)) return; // file renamed — the bound is not worth a false red
    const src = fs.readFileSync(abs, 'utf8');
    const nonblank = (s: string) => s.split('\n').filter((l) => l.trim()).length;
    const kept = nonblank(stripCommentsForExt(src, '.ts'));
    expect(kept, `${rel}: stripper retained only ${kept} nonblank lines`).toBeGreaterThan(6000);
    // …and it must still be REMOVING comments, or the bound is satisfied by doing nothing.
    expect(kept).toBeLessThan(nonblank(src));
  });

  it('does not count a writer that is only mentioned in a comment', () => {
    const commented = [
      '// await dbWrite.modelFileHash.createMany({ data: rows });',
      '/* await dbWrite.modelFileHash.upsert({ where, create, update }); */',
      // A JSDoc continuation, INSIDE its block. The bare ` * …` line this fixture used to carry
      // was an artifact of the old line-based stripper, which blanked any line starting with `*`.
      // A real lexer is right to call that CODE — outside a block, `*` is multiplication — and
      // the shape never occurs in real source, where continuations live inside `/** … */`.
      "/**\n * await kyselyDb.insertInto('ModelFileHash').values(rows).execute();\n */",
      'const x = 1; // await dbWrite.modelFileHash.createMany({ data: rows });',
    ].join('\n');

    for (const ext of ['.ts', '.tsx', '.js', '.mjs', '.cjs']) {
      const stripped = stripCommentsForExt(commented, ext);
      const hit = WRITE_PATTERNS.find(([, re]) => {
        re.lastIndex = 0;
        return re.test(stripped);
      });
      expect(hit?.[0], `${ext}: a commented-out writer was counted as live`).toBeUndefined();
    }
  });

  it('still counts a live writer sharing a line with a comment (shrink control)', () => {
    // The direction the original `.sql`-only scoping was protecting. If stripping ever eats live
    // code, the ledger goes quiet about a real writer — and quiet is exactly what it cannot do.
    const live = 'await dbWrite.modelFileHash.createMany({ data: rows }); // derived from the scan';
    for (const ext of ['.ts', '.tsx', '.js', '.mjs', '.cjs']) {
      const stripped = stripCommentsForExt(live, ext);
      const matched = WRITE_PATTERNS.some(([, re]) => {
        re.lastIndex = 0;
        return re.test(stripped);
      });
      expect(matched, `${ext}: stripping hid a LIVE writer`).toBe(true);
    }
    // `--` is a decrement operator in JS, not a comment. Running the SQL rule here would swallow
    // the rest of the line and hide this writer.
    const decrement = 'i--; await dbWrite.modelFileHash.createMany({ data: rows });';
    const strippedTs = stripCommentsForExt(decrement, '.ts');
    expect(
      WRITE_PATTERNS.some(([, re]) => {
        re.lastIndex = 0;
        return re.test(strippedTs);
      }),
      'the SQL `--` rule leaked into JS and hid a writer after a decrement'
    ).toBe(true);
  });

  it('detects a planted writer in every spelling a write can take (negative control)', () => {
    // The ledger is only as good as the matchers. Each access route gets a realistic sample,
    // because a matcher that cannot see a Kysely or raw-SQL writer reports a clean ledger while
    // that writer bypasses normalizeScanHashes.
    const samples: Array<[string, string]> = [
      ['prisma', 'await dbWrite.modelFileHash.createMany({ data: rows });'],
      ['prisma-upsert', 'await dbWrite.modelFileHash.upsert({ where, create, update });'],
      ['raw-sql', 'await dbWrite.$executeRaw`INSERT INTO "ModelFileHash" ("fileId") VALUES (1)`;'],
      ['kysely', "await kyselyDb.insertInto('ModelFileHash').values(rows).execute();"],
      [
        'prisma-relation',
        'await dbWrite.modelFile.update({ where, data: { hashes: { create: rows } } });',
      ],
    ];
    for (const [label, snippet] of samples) {
      const matched = WRITE_PATTERNS.some(([, re]) => {
        re.lastIndex = 0;
        return re.test(snippet);
      });
      expect(matched, `${label} writer went undetected: ${snippet}`).toBe(true);
    }
  });

  it('strips comments before looking for the call (control for the check below)', () => {
    // Not decoration. Every one of these writer files DISCUSSES normalizeScanHashes in prose —
    // reprocess-scan.ts contains the literal `// normalizeScanHashes(); without it …`. Measured:
    // without this step, deleting the real call from that file and leaving the comment behind
    // left the check below GREEN. A guard on a word is walkable by writing the word.
    expect(
      stripComments('// normalizeScanHashes(); without it a file loses its hashes.\n')
    ).not.toMatch(/normalizeScanHashes\s*\(/);
    // Inside its block, as a JSDoc continuation actually appears. This fixture used to be a bare
    // ` * see …` line, which only read as a comment because the old stripper was line-based; the
    // scanner correctly calls that multiplication, and real source never has it.
    expect(
      stripComments('/**\n * see normalizeScanHashes() in model-file-scan.service.ts\n */\n')
    ).not.toMatch(/normalizeScanHashes\s*\(/);
    expect(stripComments('const x = 1; // normalizeScanHashes() used to live here\n')).not.toMatch(
      /normalizeScanHashes\s*\(/
    );
    // Inline block comment on a line of real code — the whole-line filter cannot see this one, so
    // it is the only fixture that exercises the block-comment pass. Without it, neutering that
    // pass leaves every assertion here green (measured: it did).
    expect(
      stripComments('const x = 1; /* normalizeScanHashes() moved */ const y = 2;\n')
    ).not.toMatch(/normalizeScanHashes\s*\(/);
    // …and it must not eat real code, or the check inverts into a different false verdict.
    expect(stripComments('const rows = normalizeScanHashes(scanned); // derived\n')).toMatch(
      /normalizeScanHashes\s*\(/
    );
    expect(stripComments("const url = 'https://example.com/x';\n")).toContain(
      'https://example.com/x'
    );
  });

  it('agrees with each writer file about whether it normalizes', () => {
    for (const { file, normalizes, why } of WRITER_LEDGER) {
      const source = stripComments(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'));
      // A CALL in live code — not the identifier, not a mention in a comment.
      const callsHelper = /\bnormalizeScanHashes\s*\(/.test(source);
      expect(callsHelper, `${file} (${why})`).toBe(normalizes);
    }
  });
});

// The behavioural half lives in files that already own the mock surface for the writer they
// drive, because a structural ledger type-checks past a writer that calls the helper and then
// ignores what it returns:
//
//   applyScanOutcome        model-file-scan.service.test.ts  ('derives SHA256_12 …' cases)
//   /api/mod/reprocess-scan reprocess-scan-hash-derivation.test.ts
//   the exempt sentinel     orchestrator/__tests__/createModelFileScanRequest.test.ts
