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
 * 🔴 WHAT IS STILL OUT OF REACH — do not read this file as wider than it is.
 *   - A bridge proc that carries the token under some other input field name. The
 *     population is derived from the literal field `blockToken`; a `token:` or `jwt:`
 *     field is invisible here. That spelling is the repo's convention across all 15
 *     procs, but it is a convention, not something this test enforces.
 *   - Verification performed in a module this file does not read. Reachability is
 *     computed inside `blocks.router.ts` only: a proc that delegates to an imported
 *     helper which calls the guard reads as UNGUARDED here and will fail. That is
 *     deliberate (fail-closed), but it means the answer is "reaches the guard from within
 *     the router", not "is authorized".
 *   - An import alias for `verifyBlockToken` still defeats `DIRECT_CALL_RE`, which is a
 *     spelling check. It is closed for this file by a separate structural assertion — the
 *     router must not import `verifyBlockToken` under ANY local name — rather than by
 *     teaching the regex about aliases.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const ROUTER = 'src/server/routers/blocks.router.ts';
const GUARD = 'src/server/services/blocks/block-bridge-auth.service.ts';

/**
 * The bridge call sites, by owning procedure. `authorizeBlockBuzzRead` is the router's
 * own buzz self-read helper — it is a call SITE like any other (the procs behind it,
 * `getMyBuzzTransactions` and friends, reach the guard through it).
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
 * `blockToken` field — 12 spelled inline in the router, 3 (`getMyBuzz*`) arriving through
 * schemas imported from `~/server/schema/buzz.schema`. Derived, not hand-listed: this
 * ledger is the SET the derivation must reproduce, so adding a bridge proc fails here
 * whether or not its author knew this file existed.
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

/** `  someProc: publicProcedure` — the router's procedure definitions. */
const PROC_RE = /^ {2}([A-Za-z0-9_]+):\s*[A-Za-z0-9_]*[Pp]rocedure\b/;
/** `async function someHelper(` at module scope. */
const FN_RE = /^(?:export )?(?:async )?function ([A-Za-z0-9_]+)/;

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
      const owner = PROC_RE.exec(lines[j]) ?? FN_RE.exec(lines[j]);
      if (owner) {
        guarded.push(owner[1]);
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
 * module-scope `function someHelper(`. A chunk ends at the next chunk, or at the next line
 * that starts in COLUMN ZERO with a letter or `}` — which is `});` closing the router,
 * or a following `const`/`export`/`function`. Everything inside a proc or a function body
 * is indented, so that boundary is the file's own formatting rather than a brace count.
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
    const fn = FN_RE.exec(line);
    if (fn) {
      close(i);
      open = { name: fn[1], kind: 'fn', start: i };
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
 * DEPTH is capped at 5. A schema chain longer than that returns `false`, so the cap is a
 * blind spot in principle; the real corpus resolves every `.input()` identifier within 2.
 */
function schemaCarriesBlockToken(
  ident: string,
  file: string,
  seen = new Set<string>(),
  depth = 0
): boolean | null {
  const key = `${file}#${ident}`;
  if (seen.has(key) || depth > 5) return false;
  seen.add(key);

  const def = definitionText(file, ident);
  if (def == null) {
    const imported = importsOf(file).get(ident);
    if (!imported) return null;
    const target = resolveModule(imported.spec);
    if (!target) return null;
    return schemaCarriesBlockToken(imported.imported, target, seen, depth + 1);
  }

  if (/\bblockToken\b/.test(def)) return true;

  const localImports = importsOf(file);
  for (const other of new Set(def.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? [])) {
    if (other === ident) continue;
    if (definitionText(file, other) == null && !localImports.has(other)) continue;
    if (schemaCarriesBlockToken(other, file, seen, depth + 1) === true) return true;
  }
  return false;
}

/**
 * The procedures whose input carries a block token, plus any `.input()` identifier whose
 * definition could not be found. `unresolved` is asserted EMPTY: a schema we cannot read is
 * indistinguishable from a schema with no `blockToken` in it, and silently scoring it as
 * "not a bridge proc" is how a population check quietly stops covering things.
 */
function bridgeInputProcs(
  routerFile: string,
  source: string
): { procs: string[]; unresolved: string[] } {
  const procs: string[] = [];
  const unresolved: string[] = [];

  for (const chunk of chunks(source)) {
    if (chunk.kind !== 'proc') continue;
    const arg = inputArg(chunk.text);
    if (arg == null) continue;
    if (/\bblockToken\b/.test(arg)) {
      procs.push(chunk.name);
      continue;
    }
    let carries = false;
    for (const ident of new Set(arg.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? [])) {
      const verdict = schemaCarriesBlockToken(ident, routerFile);
      if (verdict === true) {
        carries = true;
        break;
      }
      // Only a BARE identifier argument — `.input(someSchema)` — has to resolve. An
      // inline `z.object({...})` is full of words (`z`, `object`, field names) that are
      // not schemas and are not expected to.
      if (verdict === null && /^\s*[A-Za-z_][A-Za-z0-9_]*\s*$/.test(arg)) {
        unresolved.push(`${chunk.name} -> ${ident}`);
      }
    }
    if (carries) procs.push(chunk.name);
  }
  return { procs: procs.sort(), unresolved };
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

  it('resolves an imported schema, not just an inline z.object', () => {
    // The three `getMyBuzz*` procs carry their token through a schema imported from
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
    const { procs, unresolved } = bridgeInputProcs(ROUTER, read(ROUTER));

    expect(
      unresolved,
      'An .input(<schema>) identifier on a bridge-shaped procedure could not be resolved ' +
        'to a definition, so this scan cannot say whether it carries a blockToken. An ' +
        'unreadable schema scores the same as one with no token in it, which is how a ' +
        'population check stops covering things without going red. Listed as proc -> ident.'
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

  it('does not let an import alias hide the bare verify — the router may not import it at all', () => {
    // DIRECT_CALL_RE is a spelling check, so `import { verifyBlockToken as verify }` walks
    // through it. Rather than teach the regex about aliases (which the next alias spelling
    // would defeat again), pin the structural fact: the router has no business importing
    // the bare verifier under ANY name.
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
