import fs from 'node:fs';
import path from 'node:path';
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
 *      lying about the surface). The enumeration runs over COMMENT-STRIPPED source, because a
 *      writer is something that executes: migration 20260819000000 documents the SHA256_12
 *      backfill for other environments as a commented-out `INSERT INTO "ModelFileHash"`, and
 *      matching that would force a maintainer to register prose as a writer — which then hides a
 *      real INSERT later added to that same file behind an entry the ledger already holds.
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
 * 🔴 THE `.ts` HALF NOW HAS ITS EVIDENCE, which is why stripping is no longer scoped to `.sql`.
 * The earlier fix deliberately stopped at SQL, on the reasoning that stripping `.ts` "could only
 * ever SHRINK the enumeration, which is the direction this ledger is also meant to catch — so
 * that half needs its own evidence, not a drive-by." That is the right worry: a stripper that
 * eats LIVE code makes the ledger under-report, and under-reporting is the dangerous direction.
 * The evidence is the paired positive controls below — every live spelling of a write (SQL
 * `INSERT`/`UPDATE`/`DELETE`, and the Prisma `dbWrite.modelFileHash.*` forms) is asserted to
 * SURVIVE stripping, alongside its commented twin asserted not to. Shrinkage is therefore
 * observed, not assumed absent.
 *
 * Both strippers are QUOTE-AWARE for the same reason. Postgres spells the table
 * `"ModelFileHash"`, and a `--` inside a string literal must not swallow a real statement that
 * follows it on the same line — a naive line-comment regex that ignores quote state does exactly
 * that. See `stripCommentsForFile` and the two strippers it dispatches to.
 */

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

/** `<repo-relative path> :: <matched write expression>`, deduped and sorted. */
function enumerateWriters(): string[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) collectFiles(path.join(REPO_ROOT, root), files);

  const found = new Set<string>();
  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file);
    if (isTestFile(rel)) continue;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.includes('odelFileHash')) continue; // cheap prefilter, case-insensitive on the M
    const source = stripCommentsForFile(rel, raw);
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
 * Comments removed, code kept. Block comments and JSDoc go first; then whole-line `//` comments;
 * then a trailing `//` comment, but only where the slashes are not part of a `://` scheme so a URL
 * in real code survives.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      if (/^\s*(\/\/|\*)/.test(line)) return '';
      return line.replace(/(^|[^:])\/\/.*$/, '$1');
    })
    .join('\n');
}

/**
 * SQL comments removed, statements kept. `--` to end of line and `/* … *\/` blocks, but only
 * outside a quoted literal or identifier — Postgres spells the table `"ModelFileHash"`, and a
 * string containing `--` must not swallow a real statement that follows it on the same line.
 *
 * A `'` inside a comment cannot open a literal, because the comment is consumed before the quote
 * state is ever touched; `''` (an escaped quote inside a literal) closes and reopens, which nets
 * out correctly.
 */
function stripSqlComments(source: string): string {
  let out = '';
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  while (i < source.length) {
    if (!inSingle && !inDouble && source.startsWith('--', i)) {
      const nl = source.indexOf('\n', i);
      if (nl === -1) break;
      i = nl; // keep the newline so line structure survives
      continue;
    }
    if (!inSingle && !inDouble && source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      out += ' '; // a block comment separates tokens; it must not join them
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    const ch = source[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    out += ch;
    i++;
  }
  return out;
}

/**
 * The enumeration matches on code, so it must strip whatever the file's language calls a comment.
 * `--` is a comment in SQL and a decrement in TS; `//` is a comment in TS and nothing in SQL.
 * Using one stripper for both would either miss the prose or eat the code.
 */
function stripCommentsForFile(relPath: string, source: string): string {
  return path.extname(relPath) === '.sql' ? stripSqlComments(source) : stripComments(source);
}

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

  it('enumerates statements, not a commented-out INSERT in a migration', () => {
    // The case that made this necessary. Migration 20260819000000 adds the SHA256_12 enum value
    // and nothing else; the `INSERT INTO "ModelFileHash"` in it is a `--` comment documenting the
    // backfill for environments that still need it. Registering it would put a non-writer in the
    // ledger AND make a real INSERT later added to that file invisible, since the entry key is
    // `<path> :: INSERT INTO "ModelFileHash"` either way.
    const rel =
      'packages/civitai-db-schema/prisma/migrations/20260819000000_model_file_hash_sha256_12/migration.sql';
    const abs = path.join(REPO_ROOT, rel);

    // Three separate claims, because "the test is green" has three very different causes here.
    // (1) the walk reaches the file at all — otherwise the strip is not what produced the green.
    const files: string[] = [];
    for (const root of SCAN_ROOTS) collectFiles(path.join(REPO_ROOT, root), files);
    expect(files, 'the migration is outside the scanned roots').toContain(abs);

    // (2) the raw file really does carry text the raw-sql matcher fires on…
    const raw = fs.readFileSync(abs, 'utf8');
    const rawSql = WRITE_PATTERNS.find(([kind]) => kind === 'raw-sql')![1];
    rawSql.lastIndex = 0;
    expect(rawSql.test(raw), 'fixture drift: the migration no longer contains the text').toBe(true);

    // (3) …and stripping comments is what removes it.
    rawSql.lastIndex = 0;
    expect(rawSql.test(stripCommentsForFile(rel, raw))).toBe(false);
    expect(enumerateWriters().filter((e) => e.startsWith(rel))).toEqual([]);
  });

  it('still sees a real SQL write after stripping (positive control for the strip)', () => {
    // The dangerous direction: a stripper that eats statements reports a clean ledger while a raw
    // SQL writer bypasses normalizeScanHashes. Every fixture below is a REAL write that must
    // survive, paired with the commented form that must not.
    const rawSql = WRITE_PATTERNS.find(([kind]) => kind === 'raw-sql')![1];
    const survives = (sql: string) => {
      rawSql.lastIndex = 0;
      return rawSql.test(stripSqlComments(sql));
    };

    expect(survives('INSERT INTO "ModelFileHash" ("fileId", type) VALUES (1, \'SHA256\');')).toBe(
      true
    );
    expect(survives('UPDATE "ModelFileHash" SET hash = \'x\' WHERE "fileId" = 1;')).toBe(true);
    expect(survives('DELETE FROM "ModelFileHash" WHERE "fileId" = 1;')).toBe(true);
    // A `--` inside a string literal is not a comment. Without quote tracking this line would be
    // truncated at the dashes and the write after it would vanish.
    expect(
      survives(
        'SELECT \'a--b\'; INSERT INTO "ModelFileHash" ("fileId", type) VALUES (1, \'SHA256\');'
      )
    ).toBe(true);
    // A block comment SEPARATES tokens, so a write interrupted by one is still a write — the
    // stripper leaves a space rather than splicing `INSERT` onto `INTO`.
    expect(survives('INSERT /* note */ INTO "ModelFileHash" ("fileId") VALUES (1);')).toBe(true);
    expect(survives('/* INSERT INTO "ModelFileHash" ("fileId") VALUES (1); */ SELECT 1;')).toBe(
      false
    );
    expect(survives('--   INSERT INTO "ModelFileHash" ("fileId") VALUES (1);\nSELECT 1;')).toBe(
      false
    );
  });

  it('still sees a real Prisma write after stripping (positive control for the strip)', () => {
    // Same control on the TS side: `stripCommentsForFile` routes .ts through the JS stripper, so a
    // commented-out write stops being a phantom ledger entry — without hiding the live call.
    const prisma = WRITE_PATTERNS.find(([kind]) => kind === 'prisma')![1];
    const survives = (ts: string) => {
      prisma.lastIndex = 0;
      return prisma.test(stripCommentsForFile('x.ts', ts));
    };

    expect(survives('await dbWrite.modelFileHash.createMany({ data: rows });')).toBe(true);
    expect(survives('// await dbWrite.modelFileHash.createMany({ data: rows });')).toBe(false);
    expect(survives('/* await dbWrite.modelFileHash.deleteMany({ where }); */')).toBe(false);
    // A trailing comment must not take the statement in front of it with it.
    expect(survives('await dbWrite.modelFileHash.upsert(args); // legacy')).toBe(true);
  });

  it('strips comments before looking for the call (control for the check below)', () => {
    // Not decoration. Every one of these writer files DISCUSSES normalizeScanHashes in prose —
    // reprocess-scan.ts contains the literal `// normalizeScanHashes(); without it …`. Measured:
    // without this step, deleting the real call from that file and leaving the comment behind
    // left the check below GREEN. A guard on a word is walkable by writing the word.
    expect(
      stripComments('// normalizeScanHashes(); without it a file loses its hashes.\n')
    ).not.toMatch(/normalizeScanHashes\s*\(/);
    expect(
      stripComments(' * see normalizeScanHashes() in model-file-scan.service.ts\n')
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
