import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The structural half of the shadow-mode guarantee.
 *
 * `run.test.ts` proves that a run over ITS fixtures issues no write. That is a claim about the paths
 * those fixtures reach. This is the complementary claim: the detector's source contains no write
 * SURFACE at all, so there is no input, flag or unlucky branch that could reach one. Neither guard
 * subsumes the other — a write behind a condition no fixture satisfies is invisible to the first,
 * and a write issued by an imported module is invisible to the second, which is why the two are
 * asserted against different things (behaviour, and the import ledger below).
 *
 * 🔴 EVERY assertion here is an asserted LEDGER — an exact set, failing when it grows AND when it
 * shrinks — rather than a search for a forbidden word. A word list is walkable by spelling the same
 * hazard differently; a ledger is not, because the new spelling is still a new member of the set.
 *
 * 🔴 WHAT THE LEDGERS STRUCTURALLY CANNOT POLICE. Stating it, because a guard whose comment claims
 * more than it delivers is worse than no guard — it stops the next person looking.
 *  - **Which BINDING is taken from an already-permitted specifier.** The import ledger records
 *    module specifiers, not names. `~/server/db/client` is on the list because `cohort.ts` needs
 *    `dbRead` from it; nothing here can tell that specifier apart from one that also yields
 *    `dbWrite`, and `import { dbWrite } from '~/server/db/client'` moves the import ledger not at
 *    all. What catches that case is the operation ledger (a write method is a new member) and the
 *    name check at the end — NOT this list. The same holds for every permitted specifier: adding a
 *    module to the import ledger is the moment to ask what else that module exports.
 *  - **What a permitted module does on ITS side.** `moderator-app.service` is a network client
 *    today. If it grew a database write, no assertion in this file would move.
 *  - **Destructured handles.** `resolveDbAliases` follows `const c = dbRead`, and does not follow
 *    `const { user } = dbRead`. That shape reaches `user.update(` with no `db` token in front of
 *    it, and the operation ledger would miss it. The name check does not cover it either.
 * None of these is hypothetical-only; each is a live gap, listed so it is chosen rather than
 * assumed away.
 */

const MODULE_DIR = path.resolve(__dirname, '..');
const JOB_FILE = path.resolve(__dirname, '../../../jobs/bot-account-detection.ts');

/**
 * 🔴 EVERY EXTENSION A BUNDLER WOULD LOAD, not just `.ts`.
 *
 * The two enumerations below are deliberately different mechanisms so they cannot share a bug — but
 * they shared this filter, so "different mechanism" bought nothing in the extension axis: a
 * `heuristics/ip-cluster.tsx` carrying a write and a restriction import left the whole guard green,
 * and the byte-identical file named `.ts` went red. A `.tsx` under `services/` is unusual, which is
 * exactly the property that makes it a hole nobody would look in.
 */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

const isSourceFile = (name: string) => SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext));

/** Same width, so the columns of everything on either side are undisturbed. */
const blankOut = (text: string) => text.replace(/[^\n]/g, ' ');

/**
 * Where a `/` may open a regex literal: only where a VALUE is expected.
 *
 * After an identifier, a closing bracket or a string, a `/` is division. Everywhere else it may be
 * a regex, and this errs deliberately towards "may be": treating a division as a regex only makes
 * the scanner copy MORE text through unchanged, while treating a regex as division is what lets a
 * `//` inside it truncate the line.
 */
const regexCanStartAfter = (prev: string) => prev === '' || !/[\w$)\]'"`]/.test(prev);

/** Index just past the string/template literal starting at `start`. Bails at an unterminated one. */
function endOfQuoted(source: string, start: number): number {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    const c = source[i];
    if (c === '\\') i += 2;
    else if (c === quote) return i + 1;
    // A plain string cannot span lines; stopping at the newline keeps a stray quote from swallowing
    // the rest of the file.
    else if (quote !== '`' && c === '\n') return i;
    else i += 1;
  }
  return source.length;
}

/** Index just past the regex literal starting at `start`, or `start + 1` if it is not one after
 *  all. Backing off is the safe direction: the `/` is then re-read as ordinary code. */
function endOfRegex(source: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < source.length) {
    const c = source[i];
    if (c === '\\') i += 2;
    else if (c === '\n') return start + 1;
    else if (c === '[') (inClass = true), (i += 1);
    else if (c === ']') (inClass = false), (i += 1);
    else if (c === '/' && !inClass) return i + 1;
    else i += 1;
  }
  return start + 1;
}

/**
 * Comments removed, because the claims below are about CODE.
 *
 * These files explain at length why they hold no write client, and an explanation that names the
 * thing it forbids would otherwise fail the very guard it documents — training the next maintainer
 * to delete the comment rather than keep the property. Blanks are substituted for a stripped span so
 * nothing on either side of it is joined into a token that was never written.
 *
 * 🔴 A SCANNER, NOT TWO REGEXES, AND THE DIRECTION OF ERROR IS THE WHOLE POINT. This was a
 * `.replace()` of a `(^|[^:])` + `//` + rest-of-line pattern, which deletes the rest of any line
 * holding `//` — including one inside a string or a regex. Written out, the pattern cannot appear
 * in this comment: its trailing `[^\n]` star closes the block comment it sits in, which is its own
 * small lesson. `const p = 'a//b'; await dbWrite.user.update({ id });` stripped
 * to `const p = 'a`, and BOTH ledgers then passed: the operation had been deleted before either
 * scanner ran, and so had the name. The old control only ever tested the `://` spelling, which is
 * the one case the `[^:]` hack happened to cover.
 *
 * Stripping too MUCH hides a real write and reports green; stripping too LITTLE only surfaces a
 * comment as a false failure. So every ambiguous case here resolves towards copying text through.
 */
export function stripComments(source: string): string {
  let out = '';
  let i = 0;
  /** Last non-whitespace character emitted as code. Decides regex-vs-division. */
  let prev = '';

  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += blankOut(source.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '/' && next === '/') {
      let stop = source.indexOf('\n', i);
      if (stop === -1) stop = source.length;
      out += blankOut(source.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const stop = endOfQuoted(source, i);
      out += source.slice(i, stop);
      i = stop;
      prev = c;
      continue;
    }
    if (c === '/' && regexCanStartAfter(prev)) {
      const stop = endOfRegex(source, i);
      out += source.slice(i, stop);
      i = stop;
      prev = '/';
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return out;
}

const EXCLUDED_DIRS = new Set(['__tests__']);

/**
 * Every source file under a directory, RECURSIVELY.
 *
 * 🔴 A flat `readdirSync` was a hole with a name on it: heuristics are the announced next change,
 * they will land in `heuristics/`, and a flat walk stops scanning the moment a subdirectory exists.
 * Nothing goes red when that happens — the ledgers below simply stop covering the new code and keep
 * passing, which is the failure mode this whole file exists to prevent.
 *
 * Test directories are excluded: they legitimately name write paths in order to assert they are
 * unused.
 */
export function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      out.push(...listSourceFiles(full));
    } else if (entry.isFile() && isSourceFile(entry.name)) {
      out.push(full);
    }
  }
  return out.sort();
}

/** Every source file the detector is made of. */
function detectorFiles(): string[] {
  return [...listSourceFiles(MODULE_DIR), JOB_FILE];
}

function detectorSources(): Array<{ file: string; source: string }> {
  return detectorFiles().map((file) => ({
    file: path.relative(path.resolve(__dirname, '../../../../..'), file),
    source: stripComments(readFileSync(file, 'utf8')),
  }));
}

const escapeRegExp = (literal: string) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Rewrite local aliases of a database handle back to the handle.
 *
 * 🔴 `const c = dbRead; await c.user.update(…)` is one line longer than the direct call and was
 * completely invisible: no `db` token stands in front of the operation, so the operation ledger
 * never saw it. Substituting the handle back in is enough to put it on the ledger, and the
 * substitution is applied to a COPY used only for counting operations — never to the text the
 * import ledger reads, where rewriting an identifier that also occurs inside a specifier string
 * would corrupt the very set it is asserting.
 *
 * Iterated to a fixed point (bounded) so `const c = dbRead; const d = c;` resolves too. Widening
 * an identifier to `dbRead` can only ADD ledger members, so a wrong guess fails closed.
 *
 * It does NOT follow destructuring — see the file header; that gap is stated, not papered over.
 */
export function resolveDbAliases(source: string): string {
  const declaration =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(db(?:Read|Write)?)\s*(?=[;\n,)])/g;
  let out = source;
  for (let pass = 0; pass < 5; pass += 1) {
    let changed = false;
    for (const match of [...out.matchAll(declaration)]) {
      const [, alias, handle] = match;
      if (alias === handle) continue;
      const next = out.replace(new RegExp(`\\b${escapeRegExp(alias)}\\b`, 'g'), handle);
      if (next !== out) {
        out = next;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return out;
}

/**
 * One member access, by dot or by computed string key, tolerating the whitespace a formatter
 * inserts.
 *
 * 🔴 `dbRead['user']['update'](…)` reaches the same method with no dot in it, and prettier wraps a
 * long chain as `dbRead.user\n  .update(` — a newline where the old pattern required none. Both
 * left the operation ledger unmoved.
 */
const SEGMENT = String.raw`(?:\s*\.\s*([A-Za-z_$][\w$]*)|\s*\[\s*['"]([^'"\n\]]+)['"]\s*\])`;

/**
 * `db.model.method(` / `dbRead.$rawMethod(` / `dbWrite['model']['method'](` — every shape a Prisma
 * call takes on a handle in this codebase.
 *
 * 🔴 THE SECOND SEGMENT IS OPTIONAL, and requiring it was the hole that mattered most. Prisma's
 * raw-SQL escape hatches hang off the CLIENT, not off a model — `dbRead.$executeRawUnsafe(…)` is
 * two segments, so a three-segment pattern never matched it. One such line at the top of
 * `collectCohort`'s loop — the hot path every run takes — issued an arbitrary `UPDATE` and left the
 * whole suite green. It also escaped the name check, because the handle it is spelled on is
 * `dbRead`; and wherever `DATABASE_REPLICA_URL` equals `DATABASE_URL` those two names are the same
 * object, so that statement runs against the primary.
 */
const DB_CALL = new RegExp(
  String.raw`\bdb(?:Read|Write)?` + SEGMENT + `(?:${SEGMENT})?` + String.raw`\s*\(`,
  'g'
);

function databaseOperations(sources: ReturnType<typeof detectorSources>): string[] {
  const found = new Set<string>();
  for (const { source } of sources) {
    for (const match of resolveDbAliases(source).matchAll(DB_CALL)) {
      const first = match[1] ?? match[2];
      const second = match[3] ?? match[4];
      found.add(second ? `${first}.${second}` : first);
    }
  }
  return [...found].sort();
}

/**
 * Every module specifier this code can pull in, however it is spelled.
 *
 * 🔴 Four spellings, because a ledger that only knows one of them is a word list wearing a
 * ledger's clothes. Each of these was a demonstrated escape from the single-quoted `from '…'`
 * pattern this used to be, and each left the whole suite green:
 *  - `from "…"` — double quotes. A one-character difference.
 *  - `await import('…')` / `import("…")` — a DYNAMIC import, which defeats BOTH halves of the guard
 *    at once: it adds no `dbWrite` token and no new database operation, so the operation ledger is
 *    unmoved, and it is not a `from` clause, so the import ledger was unmoved too. It is also the
 *    natural way to reach a heavy service from a job.
 *  - `require('…')` — included for completeness; it is a module reference like any other and
 *    leaving it out would just move the hole.
 *  - ``import(`…`)`` / ``require(`…`)`` — a TEMPLATE literal. Constant ones read like any other
 *    specifier; an interpolated one (`` `~/server/services/${name}` ``) is recorded verbatim,
 *    which is a member no expected list will ever hold, so a computed specifier fails CLOSED
 *    rather than slipping through as unrecorded.
 * The alternation is written once so a fifth spelling is added in one place.
 *
 * 🔴 THE LEADING LOOKBEHIND IS LOad-BEARING. Without it the pattern matched any `.from('literal')`,
 * so `Buffer.from('base64')` contributed an import specifier `base64`. It failed CLOSED — a bogus
 * member fails the ledger — but the natural repair is to add `base64` to the expected list, which
 * puts a permanent lie in the one assertion whose whole value is being exactly right.
 */
const MODULE_REF =
  /(?<![.\w$])(?:from|import|require)\s*\(?\s*(?:'([^'\n]+)'|"([^"\n]+)"|`([^`\n]*)`)/g;

function importSpecifiers(sources: ReturnType<typeof detectorSources>): string[] {
  const found = new Set<string>();
  for (const { source } of sources)
    for (const match of source.matchAll(MODULE_REF)) found.add(match[1] ?? match[2] ?? match[3]);
  return [...found].sort();
}

/**
 * 🔴 Temp trees are REMOVED. Every case below that plants an escape builds one, and they used to be
 * left behind on the runner — one per case per run, forever, under `os.tmpdir()`.
 */
const tempRoots: string[] = [];
function tempTree(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bot-account-tree-'));
  tempRoots.push(root);
  return root;
}
afterEach(() => {
  while (tempRoots.length) rmSync(tempRoots.pop() as string, { recursive: true, force: true });
});

/** The exact text a real regression would carry, on whichever handle is named. */
const plantedWrite = (handle: string) =>
  `import { applyPendingReviewMute } from '~/server/services/user-restriction.service';\n` +
  `await ${handle}.user.update({ where: { id }, data: { muted: true } });\n`;

const asSources = (files: Record<string, string>) =>
  Object.entries(files).map(([file, source]) => ({ file, source: stripComments(source) }));

describe('the detector has no write surface', () => {
  it('reads its own source — positive control', () => {
    // Everything below is a claim about a set of files. If the walk returns nothing, or files with
    // no content, every one of those claims is vacuously true and this suite reports success while
    // checking nothing.
    const sources = detectorSources();
    expect(sources.length).toBeGreaterThanOrEqual(5);
    expect(sources.every((s) => s.source.length > 200)).toBe(true);
    expect(sources.map((s) => path.basename(s.file))).toContain('cohort.ts');
    expect(sources.map((s) => path.basename(s.file))).toContain('bot-account-detection.ts');
  });

  it('scans EVERY file in the module tree, at any depth — exhaustiveness', () => {
    // 🔴 This replaces a hand-maintained list of five basenames. That list was the wrong shape of
    // assertion: it pinned which files exist, not that every file that exists is SCANNED, so a
    // sixth file added under `heuristics/` failed the list once (a maintainer deletes the stale
    // name) and was then invisible forever after.
    //
    // The enumeration this is checked against is deliberately a DIFFERENT MECHANISM from the walk
    // it grades — Node's own `readdirSync(..., { recursive: true })` rather than the hand-rolled
    // recursion in `listSourceFiles` — so the two cannot share a bug and agree on it. They do
    // share `SOURCE_EXTENSIONS` and `EXCLUDED_DIRS`, which is why those are asserted directly
    // rather than left to this comparison.
    const expected = readdirSync(MODULE_DIR, { recursive: true, encoding: 'utf8' })
      .filter((rel) => isSourceFile(rel))
      .filter((rel) => !rel.split(path.sep).some((seg) => EXCLUDED_DIRS.has(seg)))
      .map((rel) => path.join(MODULE_DIR, rel))
      .sort();

    const scanned = detectorFiles().sort();
    expect(expected.length).toBeGreaterThanOrEqual(4);
    // Every file in the tree is scanned. Set equality, not containment: a scanned file that is not
    // in the tree means the walk is reading something it should not be.
    expect(scanned).toEqual([...expected, JOB_FILE].sort());
  });

  it('a module in a SUBDIRECTORY is scanned — the escape heuristics will walk into', () => {
    // Red before the recursive walk landed: a flat `readdirSync` returns the directory entry and
    // filters it out for not being a source file, so the nested file is never opened and everything
    // inside it is unledgered. Built on a temp tree rather than the real one so the control is a
    // control and not a commit.
    const root = tempTree();
    mkdirSync(path.join(root, 'heuristics'));
    mkdirSync(path.join(root, '__tests__'));
    writeFileSync(path.join(root, 'top.ts'), 'export const a = 1;\n');
    writeFileSync(path.join(root, 'heuristics', 'ip-cluster.ts'), plantedWrite('dbWrite'));
    writeFileSync(path.join(root, '__tests__', 'ignored.ts'), 'export const b = 2;\n');
    writeFileSync(path.join(root, 'notes.md'), 'dbWrite.user.update(x)\n');

    const files = listSourceFiles(root).map((f) => path.relative(root, f));
    expect(files).toEqual([path.join('heuristics', 'ip-cluster.ts'), 'top.ts']);

    // And the scanners see through to it: the planted write is a ledger member, not invisible.
    const sources = listSourceFiles(root).map((file) => ({
      file,
      source: stripComments(readFileSync(file, 'utf8')),
    }));
    expect(databaseOperations(sources)).toEqual(['user.update']);
    expect(importSpecifiers(sources)).toEqual(['~/server/services/user-restriction.service']);
  });

  it('scans every extension a bundler would load, not only `.ts`', () => {
    // 🔴 Red before `SOURCE_EXTENSIONS`: `heuristics/ip-cluster.tsx` carrying a write and a
    // restriction import left the guard 9/9 green, while the byte-identical file named `.ts` went
    // red. The two enumerations are different mechanisms but shared this one filter, so the
    // redundancy bought nothing here.
    const root = tempTree();
    mkdirSync(path.join(root, 'heuristics'));
    for (const [i, ext] of SOURCE_EXTENSIONS.entries())
      writeFileSync(path.join(root, 'heuristics', `h${i}${ext}`), plantedWrite('dbWrite'));

    const found = listSourceFiles(root).map((f) => path.extname(f));
    expect(found.sort()).toEqual([...SOURCE_EXTENSIONS].sort());

    const sources = listSourceFiles(root).map((file) => ({
      file,
      source: stripComments(readFileSync(file, 'utf8')),
    }));
    // Every one of them is on the ledger — not just the `.ts` member of the set.
    expect(sources).toHaveLength(SOURCE_EXTENSIONS.length);
    expect(databaseOperations(sources)).toEqual(['user.update']);
  });

  it('the exhaustiveness walk uses the same extension set as the tree walk', () => {
    // The two enumerations agree only because they read one constant. Pinning it here is what makes
    // the previous case a statement about the guard rather than about one temp directory: widening
    // `SOURCE_EXTENSIONS` for one walk and not the other is the regression that reopens F-4.
    expect(SOURCE_EXTENSIONS).toContain('.ts');
    expect(SOURCE_EXTENSIONS).toContain('.tsx');
    expect(isSourceFile('ip-cluster.tsx')).toBe(true);
    expect(isSourceFile('notes.md')).toBe(false);
    expect(isSourceFile('heuristics')).toBe(false);
  });

  it('sees an import however it is spelled — quotes, dynamic, require, template', () => {
    // Each of these was planted alone in the real tree and left the full suite green, because the
    // scanner matched only `from '…'`. They are asserted here on synthetic sources so the control
    // is repeatable and does not require editing a shipped file.
    const restriction = '~/server/services/user-restriction.service';

    expect(
      importSpecifiers(asSources({ 'a.ts': `import { x } from "${restriction}";\n` }))
    ).toEqual([restriction]);

    // 🔴 The case that defeats BOTH halves of the guard: no `dbWrite` token, no new database
    // operation, and — until this — no `from` clause either.
    const dynamic = asSources({
      'b.ts': `const m = await import('${restriction}');\nm.applyPendingReviewMute(id);\n`,
    });
    expect(importSpecifiers(dynamic)).toEqual([restriction]);
    expect(databaseOperations(dynamic)).toEqual([]);

    expect(importSpecifiers(asSources({ 'c.ts': `await import("${restriction}");\n` }))).toEqual([
      restriction,
    ]);
    expect(
      importSpecifiers(asSources({ 'd.ts': `const m = require('${restriction}');\n` }))
    ).toEqual([restriction]);
  });

  it('sees a TEMPLATE-LITERAL module specifier, constant or interpolated', () => {
    // 🔴 Red before the backtick alternative: ``await import(`…`)`` matched nothing, so a dynamic
    // import written with backticks — the spelling anyone reaching for interpolation uses — was
    // completely unledgered while looking exactly like the two spellings that were covered.
    const restriction = '~/server/services/user-restriction.service';
    expect(
      importSpecifiers(asSources({ 'a.ts': 'await import(`' + restriction + '`);\n' }))
    ).toEqual([restriction]);

    // An interpolated specifier cannot be resolved to a module name, so it is recorded verbatim.
    // No expected list will ever contain it, which is the point: it fails CLOSED instead of
    // resolving to nothing and slipping past.
    const computed = importSpecifiers(
      asSources({ 'b.ts': 'await import(`~/server/services/${name}.service`);\n' })
    );
    expect(computed).toEqual(['~/server/services/${name}.service']);
    expect(computed).not.toEqual([]);
  });

  it('does not invent an import from a `.from(` method call', () => {
    // 🔴 `MODULE_REF` used to match any `.from('literal')`, so `Buffer.from('base64')` produced an
    // import specifier `base64`. It failed closed — but the obvious repair is to add `base64` to
    // the expected list, and a ledger carrying a member that is not an import is a ledger nobody
    // can reason about afterwards.
    const sources = asSources({
      'a.ts':
        "const buf = Buffer.from('base64');\n" +
        "const rows = qb.from('User');\n" +
        "import { x } from '~/server/db/client';\n",
    });
    expect(importSpecifiers(sources)).toEqual(['~/server/db/client']);
  });

  it('sees a raw-SQL call on ANY handle, including the read client — two segments, not three', () => {
    // 🔴 THE DEMONSTRATED ESCAPE. One line at the top of `collectCohort`'s loop left the suite
    // 102/102 green and the guard 9/9: `$executeRawUnsafe` hangs off the client, so it is two
    // segments where the old pattern required three, and it is spelled on `dbRead`, so the name
    // check did not fire either.
    const planted = asSources({
      'a.ts': `await dbRead.$executeRawUnsafe('UPDATE "User" SET "muted" = true WHERE id > 0');\n`,
    });
    expect(databaseOperations(planted)).toEqual(['$executeRawUnsafe']);

    // The same shape on every handle and every raw method, so the fix is not one spelling deep.
    for (const handle of ['db', 'dbRead', 'dbWrite'])
      for (const method of ['$executeRaw', '$executeRawUnsafe', '$queryRaw', '$transaction'])
        expect(
          databaseOperations(asSources({ 'a.ts': `await ${handle}.${method}(x);\n` })),
          `${handle}.${method} is invisible to the operation ledger`
        ).toEqual([method]);
  });

  it('sees a computed member access — `db["model"]["method"]`', () => {
    // Red before `SEGMENT` learned the bracket form: `dbRead['user']['update'](…)` reaches exactly
    // the method the dotted spelling does and contained no `.` for the pattern to anchor on.
    expect(
      databaseOperations(asSources({ 'a.ts': "await dbRead['user']['update']({ id });\n" }))
    ).toEqual(['user.update']);
    expect(
      databaseOperations(asSources({ 'a.ts': 'await dbWrite["user"].update({ id });\n' }))
    ).toEqual(['user.update']);
    expect(
      databaseOperations(asSources({ 'a.ts': "await dbRead['$executeRawUnsafe']('x');\n" }))
    ).toEqual(['$executeRawUnsafe']);
  });

  it('sees a call a formatter wrapped across lines', () => {
    // Red before `SEGMENT` allowed leading whitespace: prettier breaks a long chain after the
    // receiver, and the resulting `dbRead.user\n  .update(` matched nothing at all.
    expect(
      databaseOperations(
        asSources({ 'a.ts': 'await dbWrite.user\n  .update({ where: { id }, data: {} });\n' })
      )
    ).toEqual(['user.update']);
    expect(
      databaseOperations(asSources({ 'a.ts': 'await dbRead\n  .user\n  .update({ id });\n' }))
    ).toEqual(['user.update']);
  });

  it('follows a local alias of a database handle', () => {
    // Red before `resolveDbAliases`: `const c = dbRead;` puts an ordinary identifier in front of
    // the operation, and nothing anchored on `db` could see it.
    expect(
      databaseOperations(asSources({ 'a.ts': 'const c = dbRead;\nawait c.user.update({ id });\n' }))
    ).toEqual(['user.update']);
    // Through two hops, and on the write client too.
    expect(
      databaseOperations(
        asSources({ 'a.ts': 'const c = dbWrite;\nconst d = c;\nawait d.$executeRawUnsafe(sql);\n' })
      )
    ).toEqual(['$executeRawUnsafe']);
  });

  it('the comment stripper removes prose and keeps code — controls, both directions', () => {
    // The stripper is an instrument the ledgers below read through. A stripper that removed too
    // much would delete a real write and report a clean ledger; one that removed nothing would fail
    // on the files' own explanations. Both directions, so neither is assumed.
    expect(stripComments('// dbWrite.user.update(x)\nconst a = 1;')).not.toContain('dbWrite');
    expect(stripComments('/* a\n dbWrite.user.update(x)\n */ const a = 1;')).not.toContain(
      'dbWrite'
    );
    expect(stripComments('await dbWrite.user.update(x); // fine')).toContain(
      'dbWrite.user.update(x)'
    );
    // A `://` inside a URL is not a line comment, and treating it as one would silently truncate
    // the rest of that line — including a write sitting after it.
    expect(stripComments("fetch('https://x/y'); dbWrite.user.update(z);")).toContain(
      'dbWrite.user.update'
    );
  });

  it('the stripper keeps a `//` that lives inside a string or a regex', () => {
    // 🔴 THE DEMONSTRATED ESCAPE, and it beat both ledgers at once. The old stripper deleted the
    // rest of any line containing `//` unless it was preceded by a colon, so
    // `const p = 'a//b'; await dbWrite.user.update({ id });` became `const p = 'a` — the operation
    // was gone before `databaseOperations` ran, and so was the `dbWrite` the name check looks for.
    // The old control tested only the `://` spelling, which is precisely the case the `[^:]` hack
    // covered.
    const inString = "const p = 'a//b'; await dbWrite.user.update({ id });";
    expect(stripComments(inString)).toContain('dbWrite.user.update');
    expect(databaseOperations(asSources({ 'a.ts': inString }))).toEqual(['user.update']);

    const inDoubleQuotes = 'const p = "a//b"; await dbRead.$executeRawUnsafe(sql);';
    expect(databaseOperations(asSources({ 'a.ts': inDoubleQuotes }))).toEqual([
      '$executeRawUnsafe',
    ]);

    const inTemplate = 'const p = `a//b`; await dbWrite.user.update({ id });';
    expect(databaseOperations(asSources({ 'a.ts': inTemplate }))).toEqual(['user.update']);

    const inRegex = 'const re = /a[//]b/; await dbWrite.user.update({ id });';
    expect(databaseOperations(asSources({ 'a.ts': inRegex }))).toEqual(['user.update']);
  });

  it('the stripper still treats a division as a division, not a regex', () => {
    // The safe direction has a cost: mistaking division for a regex would swallow code. Pinned so
    // the regex branch cannot quietly widen — `)` and an identifier are the two receivers a `/`
    // most often follows in this module.
    const divided =
      'const h = (a.getTime() - b.getTime()) / 3600000; await dbWrite.user.update(x);';
    expect(databaseOperations(asSources({ 'a.ts': divided }))).toEqual(['user.update']);
    const byIdent = 'const r = weighted / totalWeight; await dbWrite.user.update(x);';
    expect(databaseOperations(asSources({ 'a.ts': byIdent }))).toEqual(['user.update']);
  });

  it('the scanners can see a write — negative control', () => {
    // Proves the instrument can go red before its zero is believed. Built from the exact text a
    // real regression would carry, not a textbook fixture.
    const planted = asSources({ 'planted.ts': plantedWrite('dbWrite') });
    expect(databaseOperations(planted)).toEqual(['user.update']);
    expect(importSpecifiers(planted)).toEqual(['~/server/services/user-restriction.service']);
  });

  it('performs exactly five database operations, all of them reads', () => {
    // 🔴 THE LEDGER. A write added anywhere in these files is a sixth member and fails here; a read
    // removed is a missing member and fails here too (dropping `commentV2` would silently turn
    // every newer-comment-only account into a false negative).
    expect(databaseOperations(detectorSources())).toEqual([
      'comment.groupBy',
      'commentV2.groupBy',
      'image.groupBy',
      'model.groupBy',
      'user.findMany',
    ]);
  });

  it('imports exactly the modules it needs, and none that can act on an account', () => {
    // The other half of the ledger: a write does not have to be spelled here to happen here. Calling
    // `applyPendingReviewMute` is one import and one line, and it would leave the database-operation
    // ledger above completely unmoved. Adding a module to this list is the moment to ask whether
    // the shadow guarantee still holds — and, per the file header, WHICH BINDING is taken from it,
    // which this list cannot see.
    expect(importSpecifiers(detectorSources())).toEqual([
      './cohort',
      './job',
      './report',
      './scoring',
      '@civitai/moderation',
      '~/server/db/client',
      '~/server/logging/client',
      '~/server/services/bot-account-detection/cohort',
      '~/server/services/bot-account-detection/run',
      '~/server/services/moderator-app.service',
      '~/shared/utils/prisma/enums',
    ]);
  });

  it('names no write client, and no raw-SQL escape hatch on EITHER handle', () => {
    // Redundant with the ledgers by construction, and kept anyway: it is the assertion whose failure
    // message names the hazard directly, so a maintainer who trips it is told what they did rather
    // than shown a set diff.
    //
    // 🔴 IT NO LONGER CHECKS ONLY `dbWrite`. That spelling was the entire test, and the escape that
    // beat it was spelled on the READ handle — `dbRead.$executeRawUnsafe(…)`, which mutates the
    // primary wherever the replica URL equals the primary's. The raw methods are handle-agnostic
    // here for that reason. This remains a word list, and it is not what holds the property; the
    // operation ledger above is.
    for (const { file, source } of detectorSources()) {
      expect(source.includes('dbWrite'), `${file} names the write client`).toBe(false);
      for (const raw of ['$executeRaw', '$queryRaw', '$transaction'])
        expect(
          source.includes(raw),
          `${file} names ${raw} — raw SQL can issue a write through ANY handle, dbRead included`
        ).toBe(false);
    }
  });
});
