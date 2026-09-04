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
 *
 * 🔴 THIS LIST IS NOT AN ENUMERATION. It names the escapes that have been DEMONSTRATED against this
 * file — each was written, run, and left the suite green — and it is not, and cannot be, the set of
 * every shape that escapes. A shape absent from it has not been ruled out; it has not been tried.
 * An earlier revision closed this paragraph with "each is a live gap, listed so it is chosen rather
 * than assumed away", which reads as completeness and is exactly the sentence this guard must not
 * make. Two whole axes below (object fields, and the network) were missing from it at the time.
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
 *  - **A handle held in an OBJECT FIELD, not a binding.** `const holder = { h: dbRead };
 *    holder.h.user.update(…)` — `resolveDbAliases` rewrites declarations whose initialiser IS the
 *    handle, and an object literal is not one. Left open deliberately: following a handle through
 *    property assignment is a dataflow analysis, not a regex, and this file is not the place for one.
 *  - **A method name COMPUTED rather than written.** `const k = 'up' + 'date';
 *    (dbRead as any).user[k](…)` — `SEGMENT` requires a quoted literal inside `[…]`, so a
 *    concatenation, a template with a hole, or a variable contributes no ledger member. Same reason:
 *    resolving it is constant folding, which a scanner does not do.
 *  - **🔴 THE NETWORK, WHICH IS A WHOLE AXIS NEITHER LEDGER LOOKS AT.**
 *    `await fetch('http://…/api/mod/mute', { method: 'POST' })` mutes an account with no import — the
 *    global needs none — and no database handle, so the import ledger and the operation ledger are
 *    BOTH unmoved. Every other gap here is a way of hiding a `db` token; this one never has one. It
 *    is not closed by widening any pattern below, and the only thing standing against it today is
 *    `run.test.ts`'s behavioural claim over its own fixtures plus review.
 *
 * WHAT `resolveDbAliases` WAS WIDENED FOR, and what it still is not: it now follows a type
 * annotation (`const c: typeof dbRead = dbRead`), a non-null assertion (`const c = dbRead!`) and a
 * trailing `??`/`||`/`&&` operand (`const c = maybeDb ?? dbRead`). It does not follow destructuring,
 * object fields, or a handle returned from a function. See its own docstring.
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
 * 🔴 THREE FORMS THE FIRST VERSION MISSED, all of them ordinary TypeScript rather than evasion:
 *  - `const c: typeof dbRead = dbRead;` — a TYPE ANNOTATION sits between the identifier and the `=`,
 *    so the pattern's `identifier` `=` adjacency never matched. This is the one most likely to be
 *    written by accident, which is why it is worth the widening.
 *  - `const c = dbRead!;` — a non-null assertion between the handle and the terminator.
 *  - `const c = maybeDb ?? dbRead;` — the handle is the LAST operand, not the whole initialiser.
 * All three left the guard 19/19 green. The optional initialiser prefix is deliberately anchored on
 * `??`/`||`/`&&`: a bare `[^=;\n]*` would alias on any initialiser merely CONTAINING the handle
 * (`wrap(dbRead)`), and while over-aliasing fails closed, doing it on every call expression makes
 * the operation ledger noise rather than a ledger.
 *
 * It does NOT follow destructuring, an object field, or a handle returned from a call — see the file
 * header; those gaps are stated, not papered over.
 */
export function resolveDbAliases(source: string): string {
  const declaration =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*(?:[^=;\n]*?(?:\?\?|\|\||&&)\s*)?(db(?:Read|Write)?)\s*!?\s*(?=[;\n,)])/g;
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
 *
 * 🔴 OPTIONAL CHAINING IS THE THIRD SPELLING, and it is not exotic here — it is IDIOMATIC. Several
 * handles in this tree are typed `| undefined` (`clickhouse` most of all), so `?.` is what anyone
 * reaching for one actually writes, and `dbWrite?.user.update(…)` left BOTH ledgers unmoved: the
 * `?` sat between the handle and the `.` where the pattern required adjacency. Both the dot form
 * (`a?.b`) and the computed form (`a?.['b']`) are covered.
 */
const SEGMENT = String.raw`(?:\s*\??\s*\.\s*([A-Za-z_$][\w$]*)|\s*(?:\?\s*\.)?\s*\[\s*['"]([^'"\n\]]+)['"]\s*\])`;

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
 * A method called on a ClickHouse handle — `clickhouse.$query(`, `ch.$exec(`.
 *
 * 🔴 A SECOND LEDGER, BECAUSE THE FIRST ONE IS BLIND HERE BY CONSTRUCTION. `DB_CALL` above anchors
 * on `db`/`dbRead`/`dbWrite`; the ClickHouse client is none of those, so a call on it moves the
 * operation ledger not at all. That matters because the client's surface is not read-only: `$exec`
 * takes the same kind of string, runs arbitrary DDL/DML, and returns `void` — so a mutation through
 * it produces no value anyone would notice was missing.
 *
 * The handle names are matched rather than tracked by dataflow, for the same reason
 * `resolveDbAliases` is a regex: following a client through property assignment is an analysis this
 * file does not attempt. `ch` is included because that is what `createEvidenceReader` binds it to.
 * The `$`-prefixed method requirement is what keeps ordinary `.map(`/`.filter(` on a variable named
 * `ch` out of the set.
 *
 * 🔴 THE TYPE-ARGUMENT LIST IS PART OF THE PATTERN, and leaving it out made the ledger return an
 * empty set for a module that calls `$query` on every run. `ch.$query<{ ip: string }>(sql)` puts a
 * generic argument between the method name and the `(`, so a pattern requiring them adjacent matches
 * nothing — while `$exec(` , which nobody writes with type arguments, matched fine. The result was
 * the worst possible shape: the guard's negative control passed, its assertion read a reassuring
 * `[]`, and it was blind to the exact call the real code makes. Caught only because the positive
 * control asserts the benign shape IS seen rather than only that the hostile one is.
 *
 * The type-argument body excludes parentheses so the match cannot run past the call it belongs to.
 *
 * 🔴 OPTIONAL CHAINING AND THE BRACKET FORM ARE BOTH MATCHED, and the first of those is the one that
 * mattered: `~/server/clickhouse/client` exports `clickhouse: CustomClickHouseClient | undefined`,
 * so `clickhouse?.$exec(…)` is not an evasion, it is the SPELLING THE TYPE PUSHES YOU TOWARDS —
 * `evidence.ts` only avoids it by binding a narrowed local first. Against the adjacency-requiring
 * pattern it recorded nothing at all, and `$exec` runs arbitrary DDL/DML and returns `void`, so a
 * mutation through it produces no value anyone would notice was missing. `ch['$exec'](…)` is the
 * same hole with a different keystroke.
 *
 * 🔴 WHAT REMAINS OPEN, stated rather than implied by the widening: this matches the two handle
 * NAMES it knows and a `$`-prefixed method spelled as a literal. It does not follow a client through
 * an assignment to a differently-named variable, a destructure (`const { $exec } = clickhouse`), an
 * object field, a function return, or a computed key built at runtime (`ch[m]`). Those are dataflow,
 * not pattern-matching, and this file does not attempt them — the import ledger is what bounds the
 * blast radius there, by refusing a new specifier without a maintainer looking at it.
 */
const CLICKHOUSE_CALL =
  /\b(?:clickhouse|ch)\s*(?:\??\s*\.\s*(\$[A-Za-z_$][\w$]*)|(?:\s*\?\s*\.)?\s*\[\s*['"](\$[A-Za-z_$][\w$]*)['"]\s*\])\s*(?:<[^()]*>)?\s*\(/g;

export function clickhouseMethods(sources: ReturnType<typeof detectorSources>): string[] {
  const found = new Set<string>();
  for (const { source } of sources)
    for (const match of source.matchAll(CLICKHOUSE_CALL)) found.add(match[1] ?? match[2]);
  return [...found].sort();
}

/**
 * Every SQL-looking string literal in the module.
 *
 * Deliberately over-inclusive: it collects any template or quoted string whose first word is a SQL
 * verb, whether or not it is passed to ClickHouse. Over-inclusion is the safe direction — it can
 * only add candidates for the "is it a SELECT" test below, never hide one — and it means a statement
 * built into a variable before being passed is still seen, which is exactly how `registrationIpSql`
 * is written.
 */
const SQL_VERB = /^\s*(select|insert|alter|drop|delete|update|create|truncate|optimize|rename)\b/i;

export function clickhouseStatements(sources: ReturnType<typeof detectorSources>): string[] {
  const out: string[] = [];
  for (const { source } of sources) {
    // Template literals and quoted strings alike. The comment stripper has already run, so nothing
    // collected here is prose.
    for (const match of source.matchAll(/`([^`]*)`|'([^'\n]*)'|"([^"\n]*)"/g)) {
      const text = match[1] ?? match[2] ?? match[3] ?? '';
      if (SQL_VERB.test(text)) out.push(text);
    }
  }
  return out;
}

/** The statements that are NOT reads. The assertion this exists for expects an empty list, so the
 *  control that proves it can be non-empty is a test of its own. */
export function nonSelectClickhouseStatements(
  sources: ReturnType<typeof detectorSources>
): string[] {
  return clickhouseStatements(sources).filter((sql) => !/^\s*select\b/i.test(sql));
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

  it('performs exactly seven database operations, all of them reads', () => {
    // 🔴 THE LEDGER. A write added anywhere in these files is an eighth member and fails here; a
    // read removed is a missing member and fails here too (dropping `commentV2` would silently turn
    // every newer-comment-only account into a false negative).
    //
    // 🔴 IT WENT FROM FIVE TO SEVEN WITH THE HEURISTICS, AND THE TWO NEW MEMBERS ARE THE WHOLE
    // DATABASE COST OF THIS CHANGE. `comment.findMany`/`commentV2.findMany` are the content samples
    // the templating heuristic compares. Note what is NOT here: the velocity heuristic added
    // nothing (it reads counts the cohort already carried) and the clustering heuristic's email
    // half added nothing (a wider `select` on the existing `user.findMany` is not a new operation).
    //
    // 🔴 THIS LEDGER CANNOT SEE THE CLICKHOUSE READ — `DB_CALL` anchors on a `db` handle and the
    // ClickHouse client is not one. That is not a gap being tolerated; it is why the separate
    // ClickHouse ledger below exists. Adding a source that is not Prisma leaves this assertion
    // completely unmoved, which is the exact shape of hole this file is built to refuse.
    expect(databaseOperations(detectorSources())).toEqual([
      'comment.findMany',
      'comment.groupBy',
      'commentV2.findMany',
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
    //
    // 🔴 THE ONE ENTRY THAT CHANGES THE THREAT MODEL IS `~/server/clickhouse/client`. Every other
    // new member is a local module inside this tree. That one is a NEW EXTERNAL DATA SYSTEM, and
    // the question this list exists to force is what else its module exports: it exports a client
    // whose surface includes `$exec`, which runs arbitrary statements and returns nothing. Nothing
    // in THIS assertion can tell `clickhouse` apart from `$exec` being taken off the same
    // specifier — that is the "which BINDING" gap named in the file header — so the ClickHouse
    // ledger below asserts the method set and the statement text separately.
    expect(importSpecifiers(detectorSources())).toEqual([
      '../scoring',
      './clustering',
      './cohort',
      './evidence',
      './heuristics',
      './job',
      './ramp',
      './report',
      './scoring',
      './similarity',
      './velocity',
      '@civitai/moderation',
      // Pure string constants and one string builder — no client, no env, no IO. It is the SAME
      // predicate `apps/moderator/src/lib/server/reactor-lookup.service.ts` reads `userActivities`
      // with, shared rather than copied; a second hand-written copy is how two readers of one table
      // silently stop agreeing about what an address means.
      '@civitai/shared/clickhouse-ip-filters',
      '~/server/clickhouse/client',
      '~/server/db/client',
      '~/server/logging/client',
      '~/server/services/bot-account-detection/cohort',
      '~/server/services/bot-account-detection/evidence',
      '~/server/services/bot-account-detection/run',
      '~/server/services/moderator-app.service',
      '~/shared/utils/prisma/enums',
    ]);
  });

  it('the ClickHouse scanner can see a call and a statement — controls, both halves', () => {
    // 🔴 VALIDATE THE INSTRUMENT BEFORE READING ITS VERDICT. The two assertions after this one are
    // both ZEROES ("no method other than $query", "no non-SELECT statement"), and a reassuring zero
    // is indistinguishable from a scanner wired to nothing. Both controls are built from the exact
    // text a real regression would carry.
    const planted = asSources({
      'a.ts': `await clickhouse.$exec(\`ALTER TABLE default.userActivities DELETE WHERE ip = ''\`);\n`,
    });
    // Positive control: the method scanner CAN produce a non-empty result.
    expect(clickhouseMethods(planted)).toEqual(['$exec']);
    // Positive control: the statement scanner CAN find a non-SELECT.
    expect(nonSelectClickhouseStatements(planted)).toHaveLength(1);

    // And it does not fire on the shape the module actually uses.
    const benign = asSources({ 'b.ts': "await ch.$query<{ip: string}>('SELECT ip FROM t');\n" });
    expect(clickhouseMethods(benign)).toEqual(['$query']);
    expect(nonSelectClickhouseStatements(benign)).toEqual([]);
  });

  it('🔴 sees a ClickHouse call spelled with OPTIONAL CHAINING or a bracket key', () => {
    // 🔴 Red before the widening, and this is not an exotic spelling: `clickhouse` is typed
    // `| undefined`, so `clickhouse?.$exec(…)` is what the type pushes anyone towards. Against the
    // adjacency-requiring pattern it recorded NOTHING — the ledger read `['$query']`, exactly as it
    // does on a clean tree, so the reassuring answer and the escaped answer were the same string.
    //
    // Each widening gets its OWN control rather than one case asserting both, so a regression names
    // which spelling came back.
    const optional = asSources({
      'a.ts': `await clickhouse?.$exec(\`ALTER TABLE default.userActivities DELETE WHERE ip = ''\`);\n`,
    });
    expect(clickhouseMethods(optional)).toEqual(['$exec']);

    const bracket = asSources({
      'b.ts': `await ch['$exec'](\`ALTER TABLE default.userActivities DELETE WHERE ip = ''\`);\n`,
    });
    expect(clickhouseMethods(bracket)).toEqual(['$exec']);

    const optionalBracket = asSources({ 'c.ts': `await ch?.['$exec']('DROP TABLE t');\n` });
    expect(clickhouseMethods(optionalBracket)).toEqual(['$exec']);

    // And the widening did not swallow the benign shape it has to keep seeing.
    expect(
      clickhouseMethods(
        asSources({ 'd.ts': "await ch.$query<{ip: string}>('SELECT ip FROM t');\n" })
      )
    ).toEqual(['$query']);
    // Nor does it now match an ordinary array method on a variable called `ch` — the `$` prefix is
    // still what keeps `.map(`/`.filter(` out, and a widened pattern is the moment to re-check it.
    expect(clickhouseMethods(asSources({ 'e.ts': 'const x = ch?.map((r) => r.ip);\n' }))).toEqual(
      []
    );
  });

  it('🔴 sees a Prisma write spelled with OPTIONAL CHAINING', () => {
    // Same class, other ledger: `dbWrite?.user.update(…)` put the `?` exactly where `SEGMENT`
    // required a bare `.`, so it contributed no operation and the ledger stayed at seven members.
    // Its own control, separate from the ClickHouse one above.
    const optional = asSources({ 'a.ts': 'await dbWrite?.user.update({ where: { id } });\n' });
    expect(databaseOperations(optional)).toEqual(['user.update']);

    const optionalBracket = asSources({ 'b.ts': "await dbRead?.['user']?.['update']({ id });\n" });
    expect(databaseOperations(optionalBracket)).toEqual(['user.update']);

    // The benign shapes the ledger already saw still read the same, so the widening added members
    // rather than moving them.
    expect(
      databaseOperations(asSources({ 'c.ts': 'await dbRead.comment.findMany(args);\n' }))
    ).toEqual(['comment.findMany']);
  });

  it('calls exactly one ClickHouse method, and it is the read one', () => {
    // 🔴 THE LEDGER THE PRISMA ONE STRUCTURALLY CANNOT PROVIDE. `DB_CALL` anchors on a `db` handle,
    // so a ClickHouse call contributes nothing to it — the operation ledger above stays at seven
    // members whatever this module does to ClickHouse. `$exec` is on the same client and the same
    // import, takes the same kind of string, and runs arbitrary DDL/DML while returning nothing.
    // An asserted set, so it fails if a second method appears as well as if this one goes.
    expect(clickhouseMethods(detectorSources())).toEqual(['$query']);
  });

  it('every ClickHouse statement it holds is a bare SELECT', () => {
    // The method ledger says which call is made; this says what is handed to it. They are different
    // claims — `$query` is a read method, but the scanner cannot know that the string it is given
    // is a read, and ClickHouse will happily accept a mutation through a query path.
    expect(nonSelectClickhouseStatements(detectorSources())).toEqual([]);
    // 🔴 POSITIVE CONTROL ON THE REAL TREE, not just on a fixture: an empty list above is only
    // meaningful if the walk found statements to look at in the first place.
    expect(clickhouseStatements(detectorSources()).length).toBeGreaterThanOrEqual(1);
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
