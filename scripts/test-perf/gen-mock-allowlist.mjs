#!/usr/bin/env node
/**
 * Regenerate src/__tests__/mocks/direct-mock-allowlist.json — the files that still mock a
 * guarded shared module directly.
 *
 *   node scripts/test-perf/gen-mock-allowlist.mjs
 *
 * 🔴 Regenerating is only legitimate after MIGRATING files, or after a merge that touched a
 * migrated test file — never to make the guard pass. A run that would grow the CANONICAL
 * list exits non-zero and writes nothing, because a grown list means a new direct mock was
 * added and that is precisely what the guard exists to stop.
 *
 * The PENDING list has no such rule: those specifiers have no canonical mock to migrate to,
 * so their count moves with ordinary development and is measurement, not enforcement.
 */
import { readFileSync, writeFileSync, existsSync, globSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(repoRoot, 'src/__tests__/mocks/direct-mock-allowlist.json');
const SPECIFIERS_SRC = path.join(repoRoot, 'src/__tests__/mocks/guarded-specifiers.ts');

// Parsed out of the TS module rather than duplicated here. Two copies would drift, and a
// generator disagreeing with the guard about which modules are guarded is the one failure
// this file must not have.
const { CANONICAL_SPECIFIERS, PENDING_SPECIFIERS } = readSpecifiers();

const pattern = (spec) =>
  new RegExp(`vi\\.mock\\(\\s*['"\`]${spec.replace(/[/~.]/g, (c) => `\\${c}`)}['"\`]`);

// `{ts,tsx}` for DETECTION. A `.browser.test.tsx` adding a direct canonical mock is a class
// the guard could not observe at all, which is different from a class that happens to be
// empty today (it is: 0 such files). The CODEMOD deliberately stays `.ts` — converting a
// browser-mode file would put it in a regime the canonical mocks have never been proven in.
const testFiles = globSync('src/**/*.test.{ts,tsx}', { cwd: repoRoot })
  .map((f) => f.replace(/\\/g, '/'))
  .filter((f) => !f.startsWith('src/__tests__/mocks/'))
  .sort();

const files = [];
const pendingFiles = [];
const bySpecifier = Object.fromEntries([...CANONICAL_SPECIFIERS, ...PENDING_SPECIFIERS].map((s) => [s, 0]));

for (const file of testFiles) {
  const src = readFileSync(path.join(repoRoot, file), 'utf8');
  let hitCanonical = false;
  let hitPending = false;
  for (const spec of CANONICAL_SPECIFIERS)
    if (pattern(spec).test(src)) {
      bySpecifier[spec]++;
      hitCanonical = true;
    }
  for (const spec of PENDING_SPECIFIERS)
    if (pattern(spec).test(src)) {
      bySpecifier[spec]++;
      hitPending = true;
    }
  if (hitCanonical) files.push(file);
  if (hitPending) pendingFiles.push(file);
}

const previous = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;
const previousFiles = previous?.files ?? null;
if (previousFiles && files.length > previousFiles.length) {
  const added = files.filter((f) => !previousFiles.includes(f));
  console.error(
    `Refusing to grow the CANONICAL allowlist (${previousFiles.length} -> ${files.length}). New direct mocks:`
  );
  for (const f of added) console.error(`  ${f}`);
  process.exit(1);
}

const allFiles = [...new Set([...files, ...pendingFiles])];
const out = {
  // 🔴 `files` is the enforced list: mocking one of these is a test failure. Kept as the
  // top-level name because that is what the guard reads.
  canonicalSpecifiers: CANONICAL_SPECIFIERS,
  pendingSpecifiers: PENDING_SPECIFIERS,
  totals: {
    canonicalFiles: files.length,
    pendingFiles: pendingFiles.length,
    allFiles: allFiles.length,
    canonicalSites: CANONICAL_SPECIFIERS.reduce((n, s) => n + bySpecifier[s], 0),
    pendingSites: PENDING_SPECIFIERS.reduce((n, s) => n + bySpecifier[s], 0),
  },
  bySpecifier,
  files,
  pendingFiles,
};
writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);

const delta = previousFiles ? ` (${previousFiles.length - files.length} migrated)` : '';
console.log(`canonical ${previousFiles ? `${previousFiles.length} -> ` : ''}${files.length} files${delta}`);
console.log(`pending   ${pendingFiles.length} files across ${PENDING_SPECIFIERS.length} specifiers`);
console.log(`sites     canonical ${out.totals.canonicalSites}, pending ${out.totals.pendingSites}`);

function readSpecifiers() {
  const sf = ts.createSourceFile(
    SPECIFIERS_SRC,
    readFileSync(SPECIFIERS_SRC, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  const found = {};
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const d of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !d.initializer || !ts.isArrayLiteralExpression(d.initializer))
        continue;
      const values = d.initializer.elements.map((e) => (ts.isStringLiteral(e) ? e.text : null));
      if (values.every((v) => v !== null)) found[d.name.text] = values;
    }
  }
  for (const name of ['CANONICAL_SPECIFIERS', 'PENDING_SPECIFIERS'])
    if (!found[name]) throw new Error(`Could not read ${name} from ${SPECIFIERS_SRC} — refusing to guess.`);
  return found;
}
