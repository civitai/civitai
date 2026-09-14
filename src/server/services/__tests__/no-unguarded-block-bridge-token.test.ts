import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Every tRPC procedure on the host↔block postMessage bridge must resolve its claims
 * through `authorizeBlockBridgeToken`, never through `verifyBlockToken` directly.
 *
 * `verifyBlockToken` answers one question — is this a token we signed, not yet expired.
 * It cannot see an uninstall, a toggle-off, a publisher ban or a suspended app. The
 * bridge procs each called it directly and checked none of those, so a revoked install
 * kept driving the bridge — orchestrator polls, workflow cancels, and
 * `publishGenerationOutputs`, which persists public `Image` rows — until the token
 * expired on its own. The REST `withBlockScope` wrapper never had this gap.
 *
 * WHY A GUARD AND NOT A TYPE. Nothing in the type system can require a check that
 * happens INSIDE a resolver. And the realistic regression is not someone deleting the
 * helper — it is the fourteenth bridge proc, written by copying the thirteenth's opening
 * lines, whose reviewer has no reason to know that `await verifyBlockToken(...)` is the
 * one shape that must not appear in this file.
 *
 * A RELATIONSHIP, NOT A COUNT. Two ledgers below, each compared as a SET, each failing in
 * both directions on purpose. A bare count would satisfy both halves of a swap (one proc
 * unguarded, one added) and pin nothing.
 *
 *   `GUARD_CALL_SITE_LEDGER` — who CALLS the guard, by owning procedure or helper.
 *     A site disappears (a proc deleted, renamed, or quietly moved back onto a bare
 *     `verifyBlockToken`) and the set shrinks; a site appears and is not ledgered, so a
 *     new bridge proc gets looked at by whoever adds it rather than inheriting coverage.
 *
 *   `BRIDGE_INPUT_LEDGER` — who TAKES a `blockToken`, i.e. the population that has to
 *     reach the guard at all.
 *
 * 🔴 WHY THE SECOND LEDGER EXISTS, AND WHAT THE FIRST ONE COULD NOT SEE. Until it was
 * added, this file keyed on calls to `authorizeBlockBridgeToken` and on the literal
 * spelling `verifyBlockToken(` — both of which a procedure that verifies NOTHING AT ALL
 * satisfies vacuously. Measured: a proc added to `blocks.router.ts` taking `blockToken`
 * in its input and base64-decoding the JWT payload inline, with no verification of any
 * kind, left this file at 7 passed / 0 failed. A file called
 * `no-unguarded-block-bridge-token` could not see an unguarded bridge token. The second
 * ledger plus `reaches the guard` below is what closes that: the population is derived
 * from the router's `.input(...)` shapes, not from the ledger, so a proc cannot enter the
 * population and stay out of the check.
 *
 * 🔴 AND WHAT THAT LEDGER, AS FIRST WRITTEN, STILL COULD NOT SEE. A population derived
 * from the router only covers procs the derivation can READ, and four things could make a
 * proc unreadable while every assertion stayed green: an `.input()` schema behind a
 * `.extend(…)` / `.merge(…)` / factory call rather than a bare identifier (`unresolved`
 * demanded resolution only for the bare case); a schema chain deeper than the depth cap; a
 * proc chunk cut short by a column-zero line; and a proc nested in a sub-router. Each is
 * now either closed or ledgered-and-asserted — `schemaIdentifiers`, `truncated`,
 * `every proc chunk keeps its own terminator`, and `PROC_RE`'s indent respectively. The
 * generalisation worth keeping: for a DERIVED population, "this procedure is not in the
 * set" and "this procedure could not be parsed" have to be different outcomes, or the
 * second one hides inside the first.
 *
 * 🔴 WHAT IS STILL OUT OF REACH — do not read this file as wider than it is. Every entry
 * below is a limit that is OPEN, stated because it is open. Where a limit was closed in a
 * later round it was moved out of this list, not softened inside it.
 *   - A bridge proc that carries the token under some other input field name. The
 *     population is derived from the literal field `blockToken`; a `token:` or `jwt:`
 *     field is invisible here. That spelling is the repo's convention across all 15
 *     procs, but it is a convention, not something this test enforces.
 *   - Verification performed in a module this file does not read. Reachability is
 *     computed inside `blocks.router.ts` only: a proc that delegates to an imported
 *     helper which calls the guard reads as UNGUARDED here and will fail. That is
 *     deliberate (fail-closed), but it means the answer is "reaches the guard from within
 *     the router", not "is authorized".
 *   - `verifyBlockToken` reached WITHOUT SPELLING ITS NAME in the router — a computed
 *     member access (`mod['verify' + 'BlockToken']`), or a re-export under a different
 *     name in another module. `DIRECT_CALL_RE`, the import-alias assertion and the wider
 *     `only in prose` assertion are all SPELLING checks on that one identifier, and none
 *     of them can see a name that is never written. What covers that case is not a
 *     spelling check at all — it is `THE RELATIONSHIP`, which asks whether the proc
 *     reaches `authorizeBlockBridgeToken`, and does not care what else it calls.
 *   - Reachability is a TEXTUAL call-graph over the router, so it answers "the guard's
 *     name appears in a body that runs" — not "the guard is awaited on every path". A
 *     call behind a `if (someFlag)` reads as reaching it.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const ROUTER = 'src/server/routers/blocks.router.ts';
const GUARD = 'src/server/services/blocks/block-bridge-auth.service.ts';

/**
 * The bridge call sites, by owning procedure. `authorizeBlockBuzzRead` is the router's
 * own buzz self-read helper — it is a call SITE like any other, and the three procs behind
 * it (`getMyBuzzAccounts`, `getMyBuzzTransactions`, `getMyDailyCompensation`) reach the
 * guard through it, which is why they appear in the population ledger below but not here.
 *
 * ⚠️ Named rather than wildcarded: `getMyBuzzBalance` is a `getMyBuzz*` proc that does NOT
 * go through the helper — it calls the guard directly, which is why it is listed here in
 * its own right. A `getMyBuzz*` shorthand gets that exactly backwards in both directions.
 */
const GUARD_CALL_SITE_LEDGER = [
  'authorizeBlockBuzzRead',
  'cancelAppWorkflow',
  'cancelWorkflow',
  'estimateWorkflow',
  'getImagesByIds',
  'getMyBuzzBalance',
  'getMyViewer',
  'listMyWorkflows',
  'pollWorkflow',
  'publishGenerationOutputs',
  'queryAppWorkflows',
  'submitWorkflow',
  'updateUserSettings',
].sort();

/**
 * THE POPULATION: every procedure in `blocks.router.ts` whose `.input(...)` carries a
 * `blockToken` field — 12 spelled inline in the router, and 3 arriving through schemas
 * imported from `~/server/schema/buzz.schema`: `getMyBuzzAccounts`,
 * `getMyBuzzTransactions` and `getMyDailyCompensation`. (Named, not `getMyBuzz*`: that
 * wildcard excludes `getMyDailyCompensation`, which is one of the three, and includes
 * `getMyBuzzBalance`, which is not — its input is spelled inline.) Derived, not
 * hand-listed: this ledger is the SET the derivation must reproduce, so adding a bridge
 * proc fails here whether or not its author knew this file existed.
 */
const BRIDGE_INPUT_LEDGER = [
  'cancelAppWorkflow',
  'cancelWorkflow',
  'estimateWorkflow',
  'getImagesByIds',
  'getMyBuzzAccounts',
  'getMyBuzzBalance',
  'getMyBuzzTransactions',
  'getMyDailyCompensation',
  'getMyViewer',
  'listMyWorkflows',
  'pollWorkflow',
  'publishGenerationOutputs',
  'queryAppWorkflows',
  'submitWorkflow',
  'updateUserSettings',
].sort();

/**
 * `  someProc: publicProcedure` — the router's procedure definitions. The indent is
 * `{2,}`, not `{2}`, so a proc nested inside a sub-router (`sub: router({ … })`, which
 * indents its members by four) is still seen. Pinning two spaces meant a whole sub-router
 * yielded an EMPTY population — every proc in it silently outside the check. There are no
 * sub-routers in `blocks.router.ts` today (measured: 73 procs, all at two spaces, zero at
 * three or more), so this is a latent shape being closed, not a bug being fixed.
 */
const PROC_RE = /^ {2,}([A-Za-z0-9_]+):\s*[A-Za-z0-9_]*[Pp]rocedure\b/;
/**
 * A module-scope helper, in EITHER declaration form: `async function someHelper(` or
 * `const someHelper = async (`. The `function`-only version made every proc behind an
 * arrow-function helper read as UNGUARDED — fail-closed and loud, but a false red on a
 * legitimate refactor, and the docstring above promises router-local delegation is covered
 * generally. `blocks.router.ts` has no module-scope arrow helpers today (measured: zero
 * matches for a column-zero `const x = (`), so this too is a latent shape.
 */
const FN_RE =
  /^(?:export )?(?:async )?function ([A-Za-z0-9_]+)|^(?:export )?const ([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\(/;

/** The declared name from an `FN_RE` match, whichever of its two alternatives matched. */
function fnName(line: string): string | null {
  const m = FN_RE.exec(line);
  return m ? m[1] ?? m[2] ?? null : null;
}

/** A CALL, not a type position — `ReturnType<typeof verifyBlockToken>` must not count. */
const DIRECT_CALL_RE = /\bverifyBlockToken\s*\(/;
const GUARD_CALL_RE = /\bauthorizeBlockBridgeToken\s*\(/;

/** The owner of each `authorizeBlockBridgeToken(` call in `source`, plus every direct call. */
function scan(source: string): { guarded: string[]; direct: number[] } {
  const lines = source.split('\n');
  const guarded: string[] = [];
  const direct: number[] = [];

  lines.forEach((line, i) => {
    if (DIRECT_CALL_RE.test(line)) direct.push(i + 1);
    if (!/\bauthorizeBlockBridgeToken\s*\(/.test(line)) return;
    for (let j = i; j >= 0; j--) {
      const proc = PROC_RE.exec(lines[j]);
      const owner = proc ? proc[1] : fnName(lines[j]);
      if (owner) {
        guarded.push(owner);
        return;
      }
    }
    guarded.push(`<no owner resolved at line ${i + 1}>`);
  });

  return { guarded, direct };
}

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

/**
 * Cached, because the schema walk below asks the same few files for the same identifiers
 * hundreds of times (every word inside every `.input(z.object({…}))` is a candidate). The
 * caches are pure memoisation of file content and of what was parsed out of it — measured
 * on this suite, 7.16s of test time uncached against 1.58s cached.
 */
const fileCache = new Map<string, string | null>();
function readIfPresent(rel: string): string | null {
  if (!fileCache.has(rel)) {
    const abs = path.join(REPO_ROOT, rel);
    fileCache.set(rel, fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null);
  }
  return fileCache.get(rel) ?? null;
}

const definitionCache = new Map<string, string | null>();
const importCache = new Map<string, Map<string, { spec: string; imported: string }>>();

// ---------------------------------------------------------------------------
// The population scan: which procedures TAKE a block token, and do they reach
// the guard. Everything below is text — the router is not importable here (it
// pulls the whole server graph), which is the same reason `scan` above is text.
// ---------------------------------------------------------------------------

type Chunk = { name: string; kind: 'proc' | 'fn'; text: string };

/**
 * Split a module into top-level chunks: one per `  someProc: publicProcedure` and one per
 * module-scope helper (`function someHelper(` or `const someHelper = async (`). A chunk
 * ends at the next chunk, or at the next line that starts in COLUMN ZERO with a letter or
 * `}` — which is `});` closing the router, or a following `const`/`export`/`function`.
 * Everything inside a proc or a function body is indented, so that boundary is the file's
 * own formatting rather than a brace count.
 *
 * 🔴 THAT BOUNDARY IS A FORMATTING ASSUMPTION, AND IT CAN CUT A PROC SHORT. A line that
 * legitimately starts in column zero INSIDE a proc — the continuation of a multi-line
 * template literal, say — closes the chunk early. If that happens before the proc's
 * `.input(`, the proc drops out of the population silently, which is the same class of
 * hole the second ledger exists to close. It is not left to prose: `every proc chunk keeps
 * its own terminator` below asserts that each chunk still contains the `.mutation(` /
 * `.query(` / `.subscription(` that ends a tRPC procedure, so a truncated chunk goes RED
 * instead of shrinking the population. Measured on the current router: 73 of 73 intact.
 */
function chunks(source: string): Chunk[] {
  const lines = source.split('\n');
  const out: Chunk[] = [];
  let open: { name: string; kind: 'proc' | 'fn'; start: number } | null = null;

  const close = (endExclusive: number) => {
    if (!open) return;
    out.push({
      name: open.name,
      kind: open.kind,
      text: lines.slice(open.start, endExclusive).join('\n'),
    });
    open = null;
  };

  lines.forEach((line, i) => {
    const proc = PROC_RE.exec(line);
    if (proc) {
      close(i);
      open = { name: proc[1], kind: 'proc', start: i };
      return;
    }
    const fn = fnName(line);
    if (fn) {
      close(i);
      open = { name: fn, kind: 'fn', start: i };
      return;
    }
    if (open && /^[A-Za-z}]/.test(line)) close(i);
  });
  close(lines.length);
  return out;
}

/** The balanced-paren argument of the first `.input(` in `text`, or null. */
function inputArg(text: string): string | null {
  const at = text.indexOf('.input(');
  if (at < 0) return null;
  let depth = 0;
  for (let i = at + 6; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(at + 7, i);
  }
  return null;
}

/**
 * Blank out comments and string/template literals, so the identifier scan below reads CODE
 * and not prose. Not cosmetic: the `.input(z.object({…}))` arguments in this router carry
 * long `//` commentaries, and tokenising those raw yields English words as candidate
 * schema names. MEASURED on the current router with neither this nor the positional
 * filtering in `schemaIdentifiers`: 990 proc→identifier pairs, 492 distinct word-shaped
 * "identifiers" across 38 procedures, every one of them unresolvable. That is the noise
 * that would make an `unresolved` ledger unusable and get it narrowed back to nothing.
 * With both in place it is 0.
 *
 * A character scanner rather than a regex chain, because stripping `//` before strings
 * mangles a URL literal (`'https://x'` loses its closing quote and the next real string
 * swallows the code between them). Regex LITERALS are not modelled: a `/[a-z']/` would
 * read as opening a string. None appear in this router's `.input()` arguments, and the
 * assertion that `unresolved` is empty is what would notice if one arrived.
 */
function stripNonCode(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      i++;
      while (i < text.length && text[i] !== c) {
        if (text[i] === '\\') i++;
        i++;
      }
      i++;
      out += ' ';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Keywords and literals that tokenise as identifiers but can never NAME anything. */
const RESERVED_WORDS = new Set([
  'true',
  'false',
  'null',
  'undefined',
  'NaN',
  'Infinity',
  'async',
  'await',
  'new',
  'typeof',
  'void',
  'return',
  'this',
  'in',
  'of',
  'as',
]);

/**
 * 🔴 REAL BINDINGS this scan declines to follow — the ONLY place an identifier can be
 * excused from resolving. The zod namespace is the BUILDER, not a schema, and it comes
 * from a package `resolveModule` deliberately does not read, so leaving it in would make
 * every inline `z.object(...)` argument report an unresolvable identifier forever.
 *
 * It stays a set of ONE. `the identifier exemption set is exactly the zod namespace` pins
 * that, because the cheap way out of a red `unresolved` will always be to add a name here,
 * and a suppression list is how this ledger stops meaning anything.
 */
const MODULE_EXEMPTIONS = new Set(['z']);

const NON_SCHEMA_WORDS = new Set([...RESERVED_WORDS, ...MODULE_EXEMPTIONS]);

/**
 * The identifiers in an `.input(...)` argument that occupy a SCHEMA position — i.e. the
 * ones that have to resolve to something before this scan can say whether the argument
 * carries a `blockToken`.
 *
 * 🔴 WHY THIS REPLACED `is the whole argument one bare identifier`. The previous rule
 * recorded an unreadable schema ONLY when the entire argument was a bare identifier, so
 * `.input(mysteryBridgeInput)` was loud while `.input(mysteryBridgeInput.extend({ page }))`
 * was silent — the proc vanished from the population with `procs: []` and `unresolved: []`,
 * which is precisely the "scored as carrying no token" outcome the docstring on
 * `bridgeInputProcs` promises never happens. Same for `.input(a.merge(b))`,
 * `.input(makeInput())`, and any schema behind a relative-path or package import.
 *
 * What is dropped, and why each is not a schema reference:
 *   - a member NAME (`.extend`, `.object`, `.min`) — the thing being called ON a schema;
 *   - an object KEY (`blockToken:`, `page:`) — a field name;
 *   - a parameter bound INSIDE the argument (`.refine((v) => !!v.slug)`) — `v` is local;
 *   - a keyword or literal (`z.boolean().default(true)`);
 *   - the zod namespace, per `NON_SCHEMA_WORDS`.
 * Everything else survives and MUST resolve. An identifier the router neither imports nor
 * declares cannot appear in a valid argument at all, so flagging it is fail-closed.
 */
function schemaIdentifiers(arg: string): string[] {
  const code = stripNonCode(arg);

  // Parameters bound by an arrow function inside the argument: `(v) => …` and `v => …`.
  const bound = new Set<string>();
  for (const re of [
    /\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^)]*)?\)\s*=>/g,
    /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*=>/g,
  ]) {
    for (let m = re.exec(code); m; m = re.exec(code)) bound.add(m[1]);
  }

  const out = new Set<string>();
  // `(\.\s*)?` — preceded by a dot, so a member name. `(\s*:)?` — followed by a colon, so
  // an object key. Either match disqualifies the token.
  const re = /(\.\s*)?\b([A-Za-z_$][A-Za-z0-9_$]*)\b(\s*:)?/g;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    if (m[1] || m[3]) continue;
    const ident = m[2];
    if (NON_SCHEMA_WORDS.has(ident) || bound.has(ident)) continue;
    out.add(ident);
  }
  return [...out];
}

/** `importMap` over a repo-relative FILE, memoised. */
function importsOf(file: string): Map<string, { spec: string; imported: string }> {
  let cached = importCache.get(file);
  if (!cached) {
    cached = importMap(readIfPresent(file) ?? '');
    importCache.set(file, cached);
  }
  return cached;
}

/** local name -> { module specifier, imported name }, from `import { a, b as c } from 'm'`. */
function importMap(source: string): Map<string, { spec: string; imported: string }> {
  const out = new Map<string, { spec: string; imported: string }>();
  const re = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    for (const raw of m[1].split(',')) {
      const part = raw.trim().replace(/^type\s+/, '');
      if (!part) continue;
      const [imported, local] = part.includes(' as ')
        ? part.split(' as ').map((s) => s.trim())
        : [part, part];
      out.set(local, { spec: m[2], imported });
    }
  }
  return out;
}

/** `~/server/schema/buzz.schema` -> the repo-relative file that actually exists. */
function resolveModule(spec: string): string | null {
  if (!spec.startsWith('~/')) return null;
  const base = path.join('src', spec.slice(2));
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(path.join(REPO_ROOT, candidate))) return candidate;
  }
  return null;
}

const NEXT_BINDING_RE =
  /^(?:export\s+)?(?:const|let|var|function|async function|type|interface|class|enum)\s/;

/** The source text of `const <ident> = …` in `file`, up to the next top-level binding. */
function definitionText(file: string, ident: string): string | null {
  const key = `${file}#${ident}`;
  if (definitionCache.has(key)) return definitionCache.get(key) ?? null;
  const found = findDefinitionText(file, ident);
  definitionCache.set(key, found);
  return found;
}

function findDefinitionText(file: string, ident: string): string | null {
  const source = readIfPresent(file);
  if (source == null) return null;
  const lines = source.split('\n');
  const start = lines.findIndex((l) =>
    new RegExp(`^(?:export\\s+)?(?:const|let|var)\\s+${ident}\\b`).test(l)
  );
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !NEXT_BINDING_RE.test(lines[end])) end++;
  return lines.slice(start, end).join('\n');
}

/**
 * Does `ident`, resolved from `file`, define a `blockToken` field — following imports and
 * same-file references? Returns `null` when the definition could NOT be located, which the
 * suite treats as a failure rather than a `false`: an unresolvable schema is exactly the
 * silent hole this scan exists to not have.
 *
 * 🔴 DEPTH. The cap is `MAX_SCHEMA_DEPTH`, and hitting it returns `false` — i.e. "no token
 * here" for a branch nobody actually read, which is the same silent scoring `unresolved`
 * exists to prevent. So a truncation is RECORDED in `truncated` and asserted empty, rather
 * than described as a blind spot in prose.
 *
 * The previous wording here — "the real corpus resolves every `.input()` identifier within
 * 2" — was false, and the cap it justified was load-bearing on the committed tree, not
 * hypothetically: at a cap of 5 the walk reached depth 6 and truncated 9 calls across 7
 * identifiers (`TokenScope` and `SKIP_OAUTH_CHECK` in `block-scope.constants.ts`, five
 * spend bounds in `app-cap-limits.constants.ts`). No verdict moved — none of those carries
 * a `blockToken` and the population was 15 either way — but nothing said so out loud.
 * MEASURED: the walk terminates on its own at depth 8, with 800 resolution calls and no
 * change in wall time between a cap of 5 and a cap of 12. The cap is set to 12 for that
 * headroom, and `truncated` is what tells you when a chain outgrows it.
 */
const MAX_SCHEMA_DEPTH = 12;

function schemaCarriesBlockToken(
  ident: string,
  file: string,
  seen = new Set<string>(),
  depth = 0,
  truncated: string[] = []
): boolean | null {
  const key = `${file}#${ident}`;
  if (depth > MAX_SCHEMA_DEPTH) {
    truncated.push(`${key} @ depth ${depth}`);
    return false;
  }
  if (seen.has(key)) return false;
  seen.add(key);

  const def = definitionText(file, ident);
  if (def == null) {
    const imported = importsOf(file).get(ident);
    if (!imported) return null;
    const target = resolveModule(imported.spec);
    if (!target) return null;
    return schemaCarriesBlockToken(imported.imported, target, seen, depth + 1, truncated);
  }

  if (/\bblockToken\b/.test(def)) return true;

  const localImports = importsOf(file);
  for (const other of new Set(def.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? [])) {
    if (other === ident) continue;
    if (definitionText(file, other) == null && !localImports.has(other)) continue;
    if (schemaCarriesBlockToken(other, file, seen, depth + 1, truncated) === true) return true;
  }
  return false;
}

/**
 * The procedures whose input carries a block token, plus every `.input()` identifier whose
 * definition could not be read. Both `unresolved` and `truncated` are asserted EMPTY: a
 * schema we cannot read is indistinguishable from a schema with no `blockToken` in it, and
 * silently scoring it as "not a bridge proc" is how a population check quietly stops
 * covering things.
 *
 * 🔴 THE RULE IS NOW THE ARGUMENT'S SCHEMA POSITIONS, NOT ITS SHAPE. Every identifier
 * `schemaIdentifiers` returns has to resolve, whatever the argument looks like around it.
 * The earlier rule only demanded resolution when the WHOLE argument was a bare identifier,
 * which made the ledger's own promise false for every other shape — see that function's
 * docstring for the measured escape.
 *
 * Note the ORDER: the literal-`blockToken` test runs against the RAW argument, before any
 * comment stripping. A proc whose argument only MENTIONS the field in a comment therefore
 * enters the population and has to reach the guard. That is deliberate — the error is in
 * the fail-closed direction, and narrowing it would trade a harmless false member for a
 * chance of a silent absent one.
 */
function bridgeInputProcs(
  routerFile: string,
  source: string
): { procs: string[]; unresolved: string[]; truncated: string[] } {
  const procs: string[] = [];
  const unresolved: string[] = [];
  const truncated: string[] = [];

  for (const chunk of chunks(source)) {
    if (chunk.kind !== 'proc') continue;
    const arg = inputArg(chunk.text);
    if (arg == null) continue;
    if (/\bblockToken\b/.test(arg)) {
      procs.push(chunk.name);
      continue;
    }
    let carries = false;
    for (const ident of schemaIdentifiers(arg)) {
      const verdict = schemaCarriesBlockToken(ident, routerFile, new Set(), 0, truncated);
      if (verdict === true) {
        carries = true;
        break;
      }
      if (verdict === null) unresolved.push(`${chunk.name} -> ${ident}`);
    }
    if (carries) procs.push(chunk.name);
  }
  return { procs: procs.sort(), unresolved, truncated };
}

/**
 * Module-scope helpers in `source` that reach the guard, to a fixpoint — so a proc
 * delegating to a helper that delegates to `authorizeBlockBuzzRead` still counts.
 */
function guardedHelpers(source: string): Set<string> {
  const fns = chunks(source).filter((c) => c.kind === 'fn');
  const reached = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const fn of fns) {
      if (reached.has(fn.name)) continue;
      const calls =
        GUARD_CALL_RE.test(fn.text) ||
        [...reached].some((h) => new RegExp(`\\b${h}\\s*\\(`).test(fn.text));
      if (calls) {
        reached.add(fn.name);
        changed = true;
      }
    }
  }
  return reached;
}

/** Procedures in `source` that reach `authorizeBlockBridgeToken`, directly or via a helper. */
function procsReachingGuard(source: string): string[] {
  const helpers = guardedHelpers(source);
  return chunks(source)
    .filter(
      (c) =>
        c.kind === 'proc' &&
        (GUARD_CALL_RE.test(c.text) ||
          [...helpers].some((h) => new RegExp(`\\b${h}\\s*\\(`).test(c.text)))
    )
    .map((c) => c.name)
    .sort();
}

describe('the bridge scan can actually see what it claims to', () => {
  /**
   * A ledger test that silently matches nothing passes forever. These two run the real
   * `scan` over a synthetic source whose answers are known, so a regex that stops
   * matching — or one that starts matching a type position — is caught here rather than
   * showing up as a reassuring empty result below.
   */
  it('finds a guarded site and attributes it to its procedure', () => {
    const { guarded, direct } = scan(
      [
        'export const r = router({',
        '  somethingElse: publicProcedure.query(async () => 1),',
        '  myBridgeProc: publicProcedure',
        '    .mutation(async ({ input }) => {',
        '      const claims = await authorizeBlockBridgeToken(input.blockToken);',
        '      return claims;',
        '    }),',
        '});',
      ].join('\n')
    );
    expect(guarded).toEqual(['myBridgeProc']);
    expect(direct).toEqual([]);
  });

  it('flags a direct call and ignores a type position', () => {
    const { direct } = scan(
      [
        'type C = NonNullable<Awaited<ReturnType<typeof verifyBlockToken>>>;',
        'const claims = await verifyBlockToken(input.blockToken);',
      ].join('\n')
    );
    expect(direct).toEqual([2]);
  });

  /**
   * The population scan's own controls. The negative one is the whole point of the second
   * ledger: the synthetic `unguardedProc` below is the exact shape that used to pass this
   * file 7/7, so if `procsReachingGuard` ever starts including it, this fails here rather
   * than in production.
   */
  const SYNTHETIC = [
    'async function helperThatGuards(blockToken: string) {',
    '  return authorizeBlockBridgeToken(blockToken);',
    '}',
    '',
    'async function helperThatDelegates(blockToken: string) {',
    '  return helperThatGuards(blockToken);',
    '}',
    '',
    'export const r = router({',
    '  noToken: publicProcedure.input(z.object({ id: z.number() })).query(async () => 1),',
    '  directlyGuarded: publicProcedure',
    '    .input(z.object({ blockToken: z.string().min(1) }))',
    '    .mutation(async ({ input }) => authorizeBlockBridgeToken(input.blockToken)),',
    '  guardedViaHelper: publicProcedure',
    '    .input(z.object({ blockToken: z.string().min(1) }))',
    '    .mutation(async ({ input }) => helperThatDelegates(input.blockToken)),',
    '  unguardedProc: publicProcedure',
    '    .input(z.object({ blockToken: z.string().min(1) }))',
    '    .mutation(async ({ input }) => {',
    "      const [, payload] = input.blockToken.split('.');",
    "      return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));",
    '    }),',
    '});',
  ].join('\n');

  it('POSITIVE CONTROL — finds the procs that take a blockToken, whatever they do with it', () => {
    const { procs, unresolved } = bridgeInputProcs(ROUTER, SYNTHETIC);
    expect(procs).toEqual(['directlyGuarded', 'guardedViaHelper', 'unguardedProc']);
    expect(unresolved).toEqual([]);
  });

  it('NEGATIVE CONTROL — a proc that verifies nothing does NOT read as reaching the guard', () => {
    // Two claims in one: the transitive helper chain IS followed (so the check does not
    // fail-closed on every delegation), and the unguarded proc is NOT swept up by it.
    expect(procsReachingGuard(SYNTHETIC)).toEqual(['directlyGuarded', 'guardedViaHelper']);
  });

  /**
   * 🔴 THE POSITIVE CONTROL FOR `unresolved`, AND WHY ITS ABSENCE WAS THE REAL DEFECT.
   * Every other control in this file asserts `unresolved` is EMPTY, and an empty result is
   * indistinguishable from a probe wired to nothing — so the ledger could be, and was,
   * structurally unable to report anything for four of the five argument shapes it claimed
   * to cover, while reading green. This feeds four arguments whose schema CANNOT be read
   * and requires the count to move off zero for each of them, separately, so a future
   * narrowing shows up here instead of as a reassuring blank.
   *
   * `mysteryBridgeInput` / `otherInput` / `makeBridgeInput` are resolved against the REAL
   * router, which neither declares nor imports them — the same position a schema behind an
   * `@civitai/*` package or a relative path is in.
   */
  const UNREADABLE = [
    'export const r = router({',
    '  bareUnknown: publicProcedure',
    '    .input(mysteryBridgeInput)',
    '    .mutation(async () => 1),',
    '  extendedUnknown: publicProcedure',
    '    .input(mysteryBridgeInput.extend({ page: z.number().optional() }))',
    '    .mutation(async () => 1),',
    '  mergedUnknown: publicProcedure',
    '    .input(mysteryBridgeInput.merge(otherInput))',
    '    .mutation(async () => 1),',
    '  factoryUnknown: publicProcedure',
    '    .input(makeBridgeInput())',
    '    .mutation(async () => 1),',
    '});',
  ].join('\n');

  it('POSITIVE CONTROL — an unreadable schema moves `unresolved` off zero, in EVERY argument shape', () => {
    const { procs, unresolved } = bridgeInputProcs(ROUTER, UNREADABLE);

    // None of them can be scored as carrying a token — that is the whole point: a proc
    // this scan cannot read must not quietly leave the population.
    expect(procs).toEqual([]);
    expect([...unresolved].sort()).toEqual([
      'bareUnknown -> mysteryBridgeInput',
      'extendedUnknown -> mysteryBridgeInput',
      'factoryUnknown -> makeBridgeInput',
      'mergedUnknown -> mysteryBridgeInput',
      'mergedUnknown -> otherInput',
    ]);
    // Report the pair, never the zero alone: 5 here, 0 against the real router below.
    expect(unresolved.length).toBeGreaterThan(0);
  });

  it('NEGATIVE CONTROL — prose and field names inside an inline z.object are NOT schema identifiers', () => {
    // The other half of the same claim. `schemaIdentifiers` has to be narrow enough that
    // an ordinary annotated inline argument yields nothing, or `unresolved` fills with
    // English words and gets switched off again. Measured on the router with neither
    // half in place: 990 proc→identifier pairs across 38 procs, all unresolvable.
    const arg = [
      'z.object({',
      '  // The blockToken the host minted — see mintBlockToken, which is not a schema.',
      "  blockToken: z.string().min(1).describe('a token, aka someOtherSchema'),",
      '  page: z.number().optional(),',
      '})',
      '  .refine((v) => !!v.page, { message: `page is required` })',
    ].join('\n');
    expect(schemaIdentifiers(arg)).toEqual([]);
  });

  it('the identifier exemption set is exactly the zod namespace', () => {
    // Keywords can never name anything, so they are not exemptions. `MODULE_EXEMPTIONS` is
    // the list of REAL bindings this scan declines to follow, and it must stay at one:
    // the cheap way out of a red `unresolved` will always be to add a name to it.
    expect([...MODULE_EXEMPTIONS]).toEqual(['z']);
    expect([...RESERVED_WORDS].filter((w) => MODULE_EXEMPTIONS.has(w))).toEqual([]);
  });

  it('follows a router-local helper declared as an arrow const, not just a `function`', () => {
    // FN_RE used to match `function` declarations only, so every proc behind
    // `const helper = async (…) => …` read as UNGUARDED — fail-closed, but a false red on
    // a legitimate refactor, and wider than the docstring admits.
    const source = [
      'const arrowGuard = async (blockToken: string) => {',
      '  return authorizeBlockBridgeToken(blockToken);',
      '};',
      '',
      'export const r = router({',
      '  viaArrow: publicProcedure',
      '    .input(z.object({ blockToken: z.string().min(1) }))',
      '    .mutation(async ({ input }) => arrowGuard(input.blockToken)),',
      '  stillUnguarded: publicProcedure',
      '    .input(z.object({ blockToken: z.string().min(1) }))',
      '    .mutation(async ({ input }) => input.blockToken.length),',
      '});',
    ].join('\n');
    expect(procsReachingGuard(source)).toEqual(['viaArrow']);
  });

  it('sees a procedure nested in a sub-router, not only one at two-space indent', () => {
    // PROC_RE used to pin a two-space indent, so `sub: router({ … })` yielded an EMPTY
    // population — every proc inside it outside the check, with nothing going red.
    const source = [
      'export const r = router({',
      '  sub: router({',
      '    nestedBridgeProc: publicProcedure',
      '      .input(z.object({ blockToken: z.string().min(1) }))',
      '      .mutation(async ({ input }) => authorizeBlockBridgeToken(input.blockToken)),',
      '  }),',
      '});',
    ].join('\n');
    const { procs } = bridgeInputProcs(ROUTER, source);
    expect(procs).toEqual(['nestedBridgeProc']);
    expect(procsReachingGuard(source)).toEqual(['nestedBridgeProc']);
  });

  it('resolves an imported schema, not just an inline z.object', () => {
    // `getMyBuzzAccounts`, `getMyBuzzTransactions` and `getMyDailyCompensation` carry their
    // token through a schema imported from
    // `~/server/schema/buzz.schema`. If import resolution silently broke, the population
    // would shrink by exactly those three and the ledger below would go red with no clue
    // why — so pin the resolution itself.
    expect(schemaCarriesBlockToken('getMyBuzzTransactionsInput', ROUTER)).toBe(true);
    expect(schemaCarriesBlockToken('getMyBuzzAccountsInput', ROUTER)).toBe(true);
    expect(schemaCarriesBlockToken('getMyDailyCompensationInput', ROUTER)).toBe(true);
    // A schema that genuinely has no block token must come back false, not true — a
    // resolver that answered `true` for everything would satisfy the three above.
    expect(schemaCarriesBlockToken('getAppDetailSchema', ROUTER)).toBe(false);
  });
});

describe('no unguarded block-bridge token verification', () => {
  it('routes every bridge call site through the guard, and exactly the ledgered ones', () => {
    const { guarded } = scan(read(ROUTER));

    expect(
      [...guarded].sort(),
      'The set of bridge procedures resolving claims through authorizeBlockBridgeToken ' +
        'changed. If you ADDED a bridge proc, add it to GUARD_CALL_SITE_LEDGER in this ' +
        'file. If one DISAPPEARED, it was deleted, renamed, or put back on a bare ' +
        'verifyBlockToken — the last of those is the defect this guard exists for. This ' +
        'fails in both directions on purpose.'
    ).toEqual(GUARD_CALL_SITE_LEDGER);
  });

  it('names each site once — a duplicate would hide a shrink behind a growth', () => {
    const { guarded } = scan(read(ROUTER));
    expect([...new Set(guarded)].length).toBe(guarded.length);
  });

  it('ledgers every procedure that TAKES a block token — the population, not the call sites', () => {
    const { procs, unresolved, truncated } = bridgeInputProcs(ROUTER, read(ROUTER));

    expect(
      unresolved,
      "An identifier in a procedure's .input(...) argument could not be resolved to a " +
        'definition, so this scan cannot say whether it carries a blockToken. An ' +
        'unreadable schema scores the same as one with no token in it, which is how a ' +
        'population check stops covering things without going red. This covers ANY shape ' +
        'of argument — a bare schema, a .extend(...)/.merge(...) chain, a factory call — ' +
        'not only the bare-identifier case. If the schema legitimately lives somewhere ' +
        'this scan does not read (a relative path, an @civitai/* package), teach ' +
        'resolveModule about it; do not exempt the procedure. Listed as proc -> ident.'
    ).toEqual([]);

    expect(
      truncated,
      `A schema chain outgrew MAX_SCHEMA_DEPTH (${MAX_SCHEMA_DEPTH}), so the walk gave up ` +
        'and scored that branch as carrying no blockToken — a verdict nobody read. Raise ' +
        'the cap, or shorten the chain. Listed as file#ident @ depth.'
    ).toEqual([]);

    expect(
      procs,
      'The set of procedures in blocks.router.ts whose input carries a blockToken ' +
        'changed. If you ADDED a bridge procedure, add it to BRIDGE_INPUT_LEDGER — and ' +
        'note that the next assertion requires it to reach authorizeBlockBridgeToken. ' +
        'If one DISAPPEARED it was deleted or renamed. Both directions fail on purpose.'
    ).toEqual(BRIDGE_INPUT_LEDGER);
  });

  it('THE RELATIONSHIP — every procedure taking a block token reaches the guard', () => {
    const source = read(ROUTER);
    const { procs } = bridgeInputProcs(ROUTER, source);
    const reaching = new Set(procsReachingGuard(source));
    const unguarded = procs.filter((p) => !reaching.has(p));

    expect(
      unguarded,
      'These procedures accept a blockToken and never reach authorizeBlockBridgeToken — ' +
        'not directly and not through a router-local helper. Whatever they do with the ' +
        'token instead (decode it, trust it, verify it by some other name), the install ' +
        'is not being checked: a revoked install, a suspended app and a banned publisher ' +
        'all still drive them until the token expires on its own. Resolve claims through ' +
        'authorizeBlockBridgeToken. If the verification genuinely lives in an imported ' +
        'module, this scan cannot see it — say so here and widen the scan, do not exempt ' +
        'the procedure.'
    ).toEqual([]);
  });

  it('keeps every proc chunk intact — a truncated chunk would shrink the population silently', () => {
    // `chunks` ends a chunk at the next COLUMN-ZERO letter or `}`, which is the router's
    // own formatting, not a brace count. A line that legitimately starts in column zero
    // inside a proc — a multi-line template literal's continuation — cuts the chunk short,
    // and if that lands before `.input(` the proc leaves the population with nothing going
    // red. Every tRPC procedure ends in one of these three terminators, so their presence
    // is a cheap structural proof that no chunk was cut.
    const procChunks = chunks(read(ROUTER)).filter((c) => c.kind === 'proc');
    const truncated = procChunks
      .filter((c) => !/\.(mutation|query|subscription)\s*\(/.test(c.text))
      .map((c) => c.name);

    expect(
      truncated,
      'These procedure chunks do not contain the .mutation( / .query( / .subscription( ' +
        'that terminates a tRPC procedure, which means the chunk was cut short — almost ' +
        'certainly by a line starting in column zero inside the procedure body. Anything ' +
        'after the cut, .input( included, is invisible to the population scan.'
    ).toEqual([]);
    // Positive control on the same read: the scan found procedures at all.
    expect(procChunks.length).toBeGreaterThan(50);
  });

  it('mentions verifyBlockToken in the router only in PROSE — no code path spells it', () => {
    // 🔴 WIDER THAN THE IMPORT ASSERTION BELOW, AND DELIBERATELY SO. `importMap` parses
    // static `import { … } from '…'` only, so it cannot see
    // `const { verifyBlockToken: vbt } = await import('~/server/middleware/…')` — an idiom
    // this router uses 89 times for other modules. That defeats the alias check AND
    // DIRECT_CALL_RE at once. Rather than add a third spelling regex per import syntax,
    // pin the fact that the identifier appears in `blocks.router.ts` in COMMENTS ONLY.
    //
    // A code line carrying a trailing comment that names it would fail here. That is a
    // false red, and the cure is to reword the comment — cheap, and the alternative is a
    // check that can be walked by writing the import on a commented line.
    const offenders = read(ROUTER)
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /\bverifyBlockToken\b/.test(line))
      .filter(({ line }) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
      .map(({ line, n }) => `${n}: ${line.trim()}`);

    expect(
      offenders,
      `${ROUTER} names verifyBlockToken on a line that is not a comment. The bridge's only ` +
        'entry point is authorizeBlockBridgeToken: a static import, a dynamic ' +
        '`await import()` destructure, a member access on a namespace import and a direct ' +
        'call are all reachable this way, and this is the one assertion that sees all four.'
    ).toEqual([]);
  });

  it('does not let an import alias hide the bare verify — the router may not import it at all', () => {
    // DIRECT_CALL_RE is a spelling check, so `import { verifyBlockToken as verify }` walks
    // through it. This pins the structural fact instead: the router has no business
    // importing the bare verifier under any local name.
    //
    // ⚠️ SCOPE, because the name of this test reads wider than it is: `importMap` parses
    // STATIC `import { … } from '…'` declarations and nothing else. A dynamic
    // `const { verifyBlockToken: vbt } = await import(…)` is invisible to it. That case is
    // covered — by `mentions verifyBlockToken in the router only in PROSE` above, which
    // works line-wise and needs no import syntax at all — not by this assertion.
    const local = [...importMap(read(ROUTER))].filter(
      ([, binding]) => binding.imported === 'verifyBlockToken'
    );
    expect(
      local.map(([name]) => name),
      `${ROUTER} must not import verifyBlockToken, aliased or not. The bridge's only ` +
        'entry point is authorizeBlockBridgeToken; an import of the bare verifier is ' +
        'either a direct call the spelling check would catch, or an aliased one it would ' +
        'not.'
    ).toEqual([]);
  });

  it('leaves no direct verifyBlockToken call in the router', () => {
    const { direct } = scan(read(ROUTER));

    expect(
      direct,
      `${ROUTER} must not call verifyBlockToken directly — a bare verify checks the ` +
        'signature and expiry and nothing else, so it honours a revoked install and a ' +
        'suspended app for a whole token lifetime. Call authorizeBlockBridgeToken instead ' +
        '(lines listed are 1-based).'
    ).toEqual([]);
  });

  it('keeps the verification in ONE place — the guard calls it exactly once', () => {
    const { direct } = scan(read(GUARD));
    expect(
      direct.length,
      `${GUARD} is the single place the bridge may call verifyBlockToken. A second call ` +
        'there is a second predicate, which is how the thirteen open-coded copies this ' +
        'replaced came to disagree with each other.'
    ).toBe(1);
  });

  it('still SPELLS the two checks the guard exists for', () => {
    const guard = read(GUARD);
    // 🔴 THIS IS A SPELLING CHECK, NOT A BEHAVIOURAL ONE — it asserts these three strings
    // are still present, and that is ALL it can see. It is walkable in both directions: a
    // semantically identical rewrite (`status === 'approved' ? … : throw`) FAILS it while
    // the behaviour is intact, and a comparison against the WRONG value spelled this way
    // PASSES it. So it cannot certify either check is correct — it only catches one
    // dropped wholesale while everything still type-checks.
    //
    // What actually pins the behaviour is `blocks.router.bridgeTokenGuard.test.ts` (a
    // different vitest project, which is why this cheap presence check exists at all). If
    // you are tempted to read this test as coverage, read that file instead.
    expect(guard).toMatch(/BlockRevocation\.isRevoked\(\s*claims\.blockInstanceId\s*\)/);
    expect(guard).toMatch(/appBlock\.findUnique/);
    expect(guard).toMatch(/status !== 'approved'/);
  });
});
