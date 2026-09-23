import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import ts from 'typescript';

import { GENERATION_SURFACES } from '~/shared/data-graph/generation/model-substitution';
import { REQUEST_RESOLVED_GENERATION_SURFACES } from '~/server/services/orchestrator/generation-surface';

/**
 * 🔴 POPULATION GUARD for the `surface` label of
 * `civitai_generation_model_substitutions_total` (issue #3520).
 *
 * `validateInput` is the single choke point every SERVER-side
 * `generationGraph.safeParse` runs through, and it structurally cannot tell which
 * caller it is serving. The surface therefore has to be fixed by whoever builds
 * the request's context — `buildGenerationContext(userTier, flags, user, surface)`
 * — and the guarantee this test protects is that EVERY such call site does so,
 * with the surface that matches what that call site actually is.
 *
 * WHY A SOURCE-LEVEL GUARD AND NOT ONLY BEHAVIOURAL TESTS. The behavioural tests
 * exist too (the App Blocks bridge in `blocks.router.workflow.test.ts`, preset
 * generation in `preset-image-gen.surface.test.ts`), but each of those can only
 * cover a call site that ALREADY EXISTS. The failure this signal is most exposed
 * to is a SIXTH entry point added later and labelled with whatever surface was
 * nearest to hand — which silently contaminates exactly the number phase 3's
 * policy decision is gated on. That is a claim about the population, so it is
 * checked against the population: every occurrence in `src/`, enumerated from the
 * tree rather than from a list someone maintains.
 *
 * TypeScript already forces the argument to EXIST (it is required, not
 * defaulted). What it cannot check is that the value is the RIGHT one for that
 * call site, which is what the expectation table below pins.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 WHY THE PIN IS PER-FUNCTION AND NOT PER-FILE.
 *
 * The first cut of this guard keyed the expectation on the FILE. But the
 * property it is standing in for is a property of the CALL SITE, and the two
 * came apart the moment `blocks.router.ts` grew a second generation-submitting
 * handler (`submitStepWorkflow`, the `kind:'step'` bridge from #3538).
 *
 * Concretely, under a file-keyed table: a `buildGenerationContext(..., 'block')`
 * added inside `submitStepWorkflow` PASSES — the file already claims `'block'` —
 * and the counter's `surface="block"` incidence starts rising. But
 * `submitStepWorkflow` calls `snapshotFromWorkflow(submitted)` with no `extra`
 * and writes no `modelSubstitutions` key into the submitted `body.metadata`, so
 * NO block can see which generation was substituted. The metric moves, the wire
 * does not, and the gap #3520 exists to close is silently reopened — with a
 * green guard.
 *
 * The honest property is therefore: A PATH THAT BUILDS A GENERATION CONTEXT (and
 * can therefore record a substitution) MUST ALSO PLUMB THAT RECORD TO THE WIRE.
 * That coupling cannot be checked by a grep, but its trigger can: pin the
 * ENCLOSING FUNCTION of every call site, so that adding one inside a handler
 * that does not plumb fails loudly and names the handler, and the author has to
 * either wire it up or amend the table on purpose. A new row here is the
 * reviewable act — the same design as before, moved to the granularity the
 * property actually has.
 *
 * MECHANISM: the TypeScript AST, not a regex. Call sites are matched by
 * IDENTIFIER (so `mockBuildGenerationContext(...)` is not a call to
 * `buildGenerationContext`, which a substring needle cannot distinguish),
 * arguments are counted by `node.arguments.length` (so a prettier reflow cannot
 * change the answer), and comments and string literals are excluded by
 * construction rather than by a hand-rolled stripper. Walking up `node.parent`
 * for the nearest named function/method/`const fn = () =>`/object-property is
 * what yields the enclosing name — including through a tRPC procedure builder,
 * where the arrow passed to `.mutation(...)` resolves to its procedure key.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../../..');

const NEEDLE = 'buildGenerationContext';

/** The declaration itself — not a call site. */
const DEFINITION_FILE = 'src/server/services/orchestrator/orchestration-new.service.ts';
/**
 * This guard's own source. It mentions `buildGenerationContext` only in comments
 * and string literals, which the AST walk already ignores, but it is excluded by
 * path as well so the enumeration can never depend on that.
 */
const GUARD_FILE = 'src/server/services/orchestrator/__tests__/generation-surface-wiring.test.ts';

/** `file::enclosingFunction` — the key the expectation table is written in. */
type CallSiteKey = string;

interface CallSite {
  /** Repo-relative path. */
  file: string;
  /** Nearest named enclosing function / method / procedure key. */
  fn: string;
  /** 1-based line of the call, for a failure message a human can act on. */
  line: number;
  /** Number of top-level arguments actually passed. */
  arity: number;
  /** What sits in the surface slot (argument index 3). */
  surfaceArg: SurfaceArg;
  /** Whether this FILE imports the approved resolver from the module defining it. */
  importsResolver: boolean;
}

type SurfaceArg =
  | { kind: 'literal'; value: string }
  | { kind: 'call'; callee: string }
  | { kind: 'other'; text: string };

const describeArg = (a: SurfaceArg): string =>
  a.kind === 'literal' ? `literal '${a.value}'` : a.kind === 'call' ? `${a.callee}(...)` : a.text;

/**
 * What a pinned call site must pass as its surface.
 *
 * A bare string is the original, strictest form: that call site is that surface,
 * always, checked against the AST.
 *
 * 🔴 THE RESOLVED FORM, AND WHY IT IS NOT A HOLE (#3665). One call site cannot
 * be pinned to a literal: `orchestrator.router`'s two procedures each serve BOTH
 * the on-site generator and every bearer-token caller, because `AIServicesRead`/
 * `AIServicesWrite` are user-grantable scopes. Its surface is a property of the
 * REQUEST, so the honest pin is "resolved by exactly this function, whose range
 * is exactly these surfaces".
 *
 * What it keeps:
 *   - a NEW call site anywhere still fails (`EXPECTED_SURFACE_BY_CALL_SITE`
 *     membership is checked first, and is unchanged);
 *   - a DIFFERENT expression in the surface slot — a variable, a ternary, an
 *     inlined `ctx.subject ? 'api' : 'onsite'`, a cast, a second resolver — fails;
 *   - a LITERAL where a resolver is pinned (i.e. re-hardcoding the bug #3665
 *     fixes) fails, and vice versa;
 *   - a MODULE-SCOPE local function or alias named `generationSurfaceForRequest`
 *     fails, via the import-provenance check — see
 *     {@link importsResolverFromDefiningModule}. 🔴 Read "module-scope"
 *     literally: the check is per FILE, so a BLOCK-scoped shadow declared inside
 *     ONE procedure, while the real import stays at the top and is still used by
 *     the sibling procedure, satisfies it and reinstates #3665 for that
 *     procedure alone (measured: guard 6/6 green, `tsc` 0 errors, eslint clean).
 *     Closing that would need real scope resolution; it is left open deliberately
 *     because it is an adversarial shape, not a refactor anyone reaches for — but
 *     it is written down rather than implied away, because an earlier revision of
 *     this list said "a LOCAL function or alias fails" full stop, which was false.
 *
 * 🔴 WHAT IT GENUINELY GIVES UP, STATED HONESTLY BECAUSE AN EARLIER REVISION OF
 * THIS COMMENT DID NOT. It claimed to keep "every mutation this guard exists to
 * catch". An audit disproved that with three measured mutants that passed 84/84
 * plus a clean `tsc`: the resolver called with `{}` instead of `ctx`, a local
 * shadowing function, and an alias binding. The first is now a compile error
 * (`GenerationSurfaceRequest` was made non-weak) and the other two are caught
 * here; the general point survives — a name-matching AST guard cannot verify
 * that the ARGUMENT is the real request, only that the callee is the approved
 * name from the approved module. `tsc` is what checks the argument, and it only
 * has teeth because the parameter type is non-weak. If you relax that type back
 * to all-optional fields, THIS guard silently stops covering the argument.
 *
 * It also cannot know WHICH of the resolver's two surfaces a given request
 * produces — not knowable statically, covered by execution in
 * `generation-surface.test.ts`. `REQUEST_RESOLVED_GENERATION_SURFACES` is
 * imported here rather than restated, so the range cannot drift.
 */
type SurfacePin = string | { readonly resolvedBy: string; readonly range: readonly string[] };

interface ExpectedCallSite {
  /**
   * 🔴 HOW MANY `buildGenerationContext` CALLS THIS KEY COVERS — and the reason this field exists.
   *
   * A key is `file::enclosingFunction`, which is NOT 1:1 with call sites: a function may build a
   * context more than once. Without a count, the membership checks in this file degrade to "does
   * the key still exist", and TWO mutations become invisible:
   *
   *   · a DELETION INSIDE an existing key — the key survives on its remaining call, so the
   *     "has not disappeared" check this field replaces stayed green;
   *   · an ADDITION INSIDE an existing key — the "cannot GROW" check above filters on
   *     `!(keyOf(c) in EXPECTED_SURFACE_BY_CALL_SITE)`, so a second call added inside an
   *     ALREADY-PINNED function is not "unexpected" and is never reviewed as a new site.
   *
   * ⚠️ SCOPE, STATED HONESTLY: every key below is currently `sites: 1`, so the DELETION half is an
   * invariant guard rather than a live fix — with one call per key, removing it also removes the
   * key, which the previous membership check already caught. The ADDITION half closes a hole that
   * is live today. The deletion half arms itself the moment any pinned function gains a second
   * call, which is exactly when nobody would think to re-check this file. The identical guard in
   * `moderation-source-wiring.test.ts` was NOT preventative — there, deleting the ACE Audio audit
   * from `generateFromGraph` took a 9-site ledger to 8 and left it 10/10 green.
   */
  sites: number;
  /**
   * What the `sites` calls under this key ARE, in source order. Purely for the failure message: a
   * count mismatch can only report "expected N, found M", so this is what lets the message name the
   * call that vanished instead of sending the reader to diff the function by hand.
   */
  siteNote: string;
  /** The expression EVERY call under this key must pass in the `surface` slot. */
  surface: SurfacePin;
}

/** The ONE approved resolver. Anything else in the surface slot fails. */
const SURFACE_RESOLVER = 'generationSurfaceForRequest';
/** …and the ONE module it may be imported from. See {@link importsResolverFromDefiningModule}. */
const SURFACE_RESOLVER_MODULE = '~/server/services/orchestrator/generation-surface';

/**
 * Every PRODUCTION call site allowed to build a generation context, keyed by
 * `file::enclosingFunction`, with the surface it must declare.
 *
 * 🔴 Adding a row means asserting that the enclosing function plumbs a recorded
 * substitution onward in whatever way its surface requires — for `'block'`, onto
 * the `BlockWorkflowSnapshot` wire (see
 * `src/server/schema/blocks/workflow.schema.ts`'s `modelSubstitutions` contract).
 * A row added without that is the failure described above, just made official.
 *
 * 🔴 CHANGING A `sites` COUNT IS EQUALLY REVIEWABLE. Lowering one is how a removed
 * context build gets waved through; do it only when the removal itself is the
 * intended change, and say why in the same commit.
 */
const EXPECTED_SURFACE_BY_CALL_SITE: Record<CallSiteKey, ExpectedCallSite> = {
  // 🔴 RESOLVED, NOT LITERAL (#3665). These two procedures serve the on-site
  // generator AND every bearer-token caller — same code path, opposite meanings.
  // On-site, #3520 calls the substitution CORRECT (a stale localStorage id after
  // an ecosystem switch, picker visibly snapping back). Via a CLI or any API
  // integration, neither property holds: the id is deliberate and nothing snaps.
  //
  // They were pinned to a hardcoded `'onsite'`, which meant every API
  // substitution was filed under the one case everyone agrees is working as
  // intended — and thereby excluded from the incidence number gating phase 3.
  'src/server/routers/orchestrator.router.ts::generateFromGraph': {
    sites: 1,
    siteNote: 'the graph-submit context build, before the workflow is submitted',
    surface: { resolvedBy: SURFACE_RESOLVER, range: REQUEST_RESOLVED_GENERATION_SURFACES },
  },
  'src/server/routers/orchestrator.router.ts::whatIfFromGraph': {
    sites: 1,
    siteNote: 'the cost-estimate context build (no submit on this path)',
    surface: { resolvedBy: SURFACE_RESOLVER, range: REQUEST_RESOLVED_GENERATION_SURFACES },
  },
  // The App Blocks bridge — the surface the issue is about. The id was written
  // by an app author and the correction was unobservable. This ONE function is
  // also the only place the block wire contract's `modelSubstitutions` field
  // originates: it returns the collected records to the router, which persists
  // them on `body.metadata` and passes them to `snapshotFromWorkflow`.
  //
  // 🔴 `submitStepWorkflow` / the `customComfy` handlers are DELIBERATELY ABSENT.
  // They live in this same file and quote costs on four exits each, and neither
  // builds a context nor plumbs the record. Adding a call site there without the
  // plumbing must fail — that is the whole reason this table is keyed on the
  // function and not on the file.
  'src/server/routers/blocks.router.ts::createBlockTextToImageStep': {
    sites: 1,
    siteNote: 'the single block text-to-image context build, whose records reach the block wire',
    surface: 'block',
  },
  // Comics / preset image generation: server-composed graph input.
  'src/server/services/orchestrator/preset-image-gen.service.ts::submitPresetImageGen': {
    sites: 1,
    siteNote: 'the preset submit context build',
    surface: 'preset',
  },
  'src/server/services/orchestrator/preset-image-gen.service.ts::whatIfPresetImageGen': {
    sites: 1,
    siteNote: 'the preset cost-estimate context build',
    surface: 'preset',
  },
};

/** Total pinned call sites — the floor the enumeration guard must clear. */
const EXPECTED_TOTAL_SITES = Object.values(EXPECTED_SURFACE_BY_CALL_SITE).reduce(
  (n, pin) => n + pin.sites,
  0
);

/**
 * Candidate files, enumerated from the TREE rather than from a hand-kept list.
 *
 * The needle is the BARE identifier (no trailing paren): it only has to
 * over-approximate, because the AST walk below decides what is really a call.
 * That removes every formatting dependency from the enumeration.
 *
 * `includeTests: false` is the PRODUCTION population (what the surface table
 * pins). `includeTests: true` adds the test tree, which `tsconfig.json` EXCLUDES
 * (`src/**\/__tests__/**`) — see the arity guard for why that matters.
 */
function candidateFiles({ includeTests }: { includeTests: boolean }): string[] {
  const found: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(path.join(REPO_ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (
        /\.tsx?$/.test(entry.name) &&
        readFileSync(path.join(REPO_ROOT, child), 'utf8').includes(NEEDLE)
      )
        found.push(child);
    }
  };
  walk('src');
  return found
    .filter((f) => f !== DEFINITION_FILE && f !== GUARD_FILE)
    .filter((f) => includeTests || !(f.includes('__tests__') || f.endsWith('.test.ts')));
}

/**
 * The nearest NAMED enclosing scope of `node`, walking up the parent chain.
 *
 * Handles the four shapes this repo actually uses:
 *   - `async function createBlockTextToImageStep(...)`   → FunctionDeclaration
 *   - `const submitPresetImageGen = async () => {}`      → VariableDeclaration
 *   - `{ method() {} }`                                  → MethodDeclaration
 *   - `generateFromGraph: proc.mutation(async () => {})` → PropertyAssignment
 *
 * The last one is why an anonymous function-like node does not terminate the
 * walk: the arrow handed to `.mutation(...)` has a CallExpression for a parent,
 * and the procedure key sits several nodes further up. A name is only accepted
 * from a variable/property once a function boundary has been crossed, so a call
 * sitting directly in an object literal is not mislabelled as "inside" it.
 */
function enclosingFunctionName(node: ts.Node): string {
  let sawFunctionBoundary = false;
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isFunctionDeclaration(cur)) {
      if (cur.name) return cur.name.text;
      sawFunctionBoundary = true;
    } else if (ts.isMethodDeclaration(cur) && ts.isIdentifier(cur.name)) {
      return cur.name.text;
    } else if (ts.isFunctionExpression(cur)) {
      if (cur.name) return cur.name.text;
      sawFunctionBoundary = true;
    } else if (ts.isArrowFunction(cur)) {
      sawFunctionBoundary = true;
    } else if (sawFunctionBoundary && ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) {
      return cur.name.text;
    } else if (sawFunctionBoundary && ts.isPropertyAssignment(cur) && ts.isIdentifier(cur.name)) {
      return cur.name.text;
    }
    cur = cur.parent;
  }
  return '<module scope>';
}

/**
 * What sits in the surface slot: a `GENERATION_SURFACES` string literal, a call
 * and its callee name, or neither. Anything not in these two shapes — a bare
 * variable, a ternary, an `as` cast, an `await` — is `{ kind: 'other' }` and
 * fails every pin, which is the intended conservatism.
 */
function describeSurfaceArg(arg: ts.Expression | undefined): SurfaceArg {
  if (!arg) return { kind: 'other', text: '<missing>' };
  if (ts.isStringLiteral(arg)) {
    return (GENERATION_SURFACES as readonly string[]).includes(arg.text)
      ? { kind: 'literal', value: arg.text }
      : { kind: 'other', text: `literal '${arg.text}' (not a surface)` };
  }
  if (ts.isCallExpression(arg)) {
    const callee = arg.expression;
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)
      ? callee.name.text
      : null;
    return name ? { kind: 'call', callee: name } : { kind: 'other', text: 'call of an expression' };
  }
  return { kind: 'other', text: ts.SyntaxKind[arg.kind] };
}

/**
 * Does `file` import {@link SURFACE_RESOLVER} from the module that DEFINES it?
 *
 * 🔴 WHY NAME EQUALITY IS NOT ENOUGH. The resolved pin matches on the callee's
 * identifier, and an identifier is just a name in scope. THREE measured mutants
 * reinstated the #3665 defect with the guard green AND a clean `tsc`: a LOCAL
 * `function generationSurfaceForRequest(_ctx: unknown) { return 'onsite'; }`
 * shadowing the import, `const generationSurfaceForRequest = alwaysOnsite`, and
 * — found only after the first two were closed — `import { alwaysOnsite as
 * generationSurfaceForRequest }` from THIS module, which defeated a check that
 * read the local binding instead of the exported name.
 *
 * A full symbol resolution would need a Program (slow, and this guard runs off
 * plain source files); requiring the EXPORTED name {@link SURFACE_RESOLVER} to
 * be imported from {@link SURFACE_RESOLVER_MODULE} closes all three without one.
 *
 * 🔴 IT FAILS CLOSED, AND TWO LEGITIMATE SHAPES ARE COLLATERAL. A namespace
 * import (`import * as gs` → `gs.generationSurfaceForRequest(ctx)`) and a
 * RELATIVE specifier for the same module (`'../services/orchestrator/…'`, a
 * shape used ~358× elsewhere in `src/server`) both fail this check even though
 * both are correct code. That is deliberate — a false RED costs one confused
 * minute and a green mutant costs the metric — but if you are adding a 5th call
 * site and hit it, the fix is to use the `~/`-aliased named import, not to
 * loosen this. The failure message says so.
 */
function importsResolverFromDefiningModule(source: ts.SourceFile): boolean {
  return source.statements.some((st) => {
    if (!ts.isImportDeclaration(st)) return false;
    if (!ts.isStringLiteral(st.moduleSpecifier)) return false;
    if (st.moduleSpecifier.text !== SURFACE_RESOLVER_MODULE) return false;
    const named = st.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) return false;
    // 🔴 THE EXPORTED NAME, NOT THE LOCAL BINDING. On an `import { a as b }`,
    // `el.propertyName` is `a` (what the module exports) and `el.name` is `b`
    // (the local alias); on a plain `import { a }`, `propertyName` is undefined
    // and `name` is `a`. An earlier revision read `el.name` and a comment here
    // asserted that an alias "would still be this module's export, which is
    // fine" — that was WRONG, and a delta audit produced the mutant that proves
    // it: `import { alwaysOnsite as generationSurfaceForRequest }` from this
    // very module resolved every request to 'onsite' — the exact #3665 defect —
    // with the guard suite 6/6 GREEN and `tsc` at 0 errors. *This module's
    // export* is not the same claim as *the approved resolver*. Reading
    // `propertyName ?? name` asks the question that was always meant.
    return named.elements.some((el) => (el.propertyName ?? el.name).text === SURFACE_RESOLVER);
  });
}

/** Every real `buildGenerationContext(...)` call in `file`, with its context. */
function callSitesIn(file: string): CallSite[] {
  const text = readFileSync(path.join(REPO_ROOT, file), 'utf8');
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const found: CallSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      // Identifier equality — NOT a substring match, so `mockBuildGenerationContext(...)`
      // (a real pattern in this repo's test tree) is correctly not a call site.
      const calleeName = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)
        ? callee.name.text
        : null;
      if (calleeName === 'buildGenerationContext') {
        found.push({
          file,
          fn: enclosingFunctionName(node),
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          arity: node.arguments.length,
          // 🔴 THE SURFACE ARGUMENT BY POSITION, not "any argument that looks
          // like one". An earlier revision scanned ALL arguments for a string
          // literal / a call, which was wrong in both directions: it accepted a
          // resolver call passed in the WRONG SLOT, and it false-failed the
          // moment any OTHER argument became a call (measured: changing arg 0 to
          // `resolveTier(user)` at a `'preset'` site failed with a message about
          // surfaces). `buildGenerationContext(userTier, flags, user, surface)`
          // — the surface is index 3, and tsc already pins the signature.
          surfaceArg: describeSurfaceArg(node.arguments[3]),
          importsResolver: importsResolverFromDefiningModule(source),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function collectCallSites({ includeTests }: { includeTests: boolean }): CallSite[] {
  return candidateFiles({ includeTests }).flatMap(callSitesIn);
}

const keyOf = (c: CallSite): CallSiteKey => `${c.file}::${c.fn}`;

describe('generation-context surface wiring', () => {
  // A throw in the describe BODY happens during registration, so no `it` below
  // is declared and the file collects zero while reading green — which is how
  // the `grep` shell-out this replaced hid on Windows. Catching it keeps
  // registration total, so the guard below reports the breakage instead.
  let sites: CallSite[] = [];
  let enumerationError: unknown;
  try {
    sites = collectCallSites({ includeTests: false });
  } catch (e) {
    enumerationError = e;
  }

  it('finds the call sites at all (guard the guard)', () => {
    if (enumerationError) throw enumerationError;
    // Without this, a broken enumeration would make every assertion below pass
    // vacuously over an empty list.
    // Against the SUM of pinned sites, not the number of keys: with per-key counts
    // the keys are a weaker floor than the sites they claim.
    expect(sites.length).toBeGreaterThanOrEqual(EXPECTED_TOTAL_SITES);
    // And no call site may resolve to an unnamed scope — that would collapse
    // distinct handlers onto one key and re-create the file-scoped hole.
    expect(sites.filter((c) => c.fn === '<module scope>')).toEqual([]);
  });

  it('🔴 every FUNCTION that builds a generation context is a pinned call site', () => {
    // The mutation this exists for: a `buildGenerationContext(..., "block")`
    // added inside `submitStepWorkflow` (or any other handler in an
    // already-listed file) that does NOT plumb the record onto the wire. A
    // file-keyed table passes that; this one names the offending function.
    const unexpected = sites
      .filter((c) => !(keyOf(c) in EXPECTED_SURFACE_BY_CALL_SITE))
      .map((c) => `${c.file}:${c.line} inside ${c.fn}()`);
    expect(unexpected).toEqual([]);
  });

  it('🔴 every pinned key covers EXACTLY the number of call sites it claims (no silent SHRINK, and no add hiding inside a key)', () => {
    // 🔴 COUNTED PER KEY, NOT MERELY PRESENT. This REPLACES a set-membership check
    // ("no pinned call site has disappeared"), which could only ever ask whether a
    // key still exists. The key is `file::enclosingFunction`, so a function that
    // builds two contexts occupies ONE key: membership goes green the moment ANY of
    // its calls survives, and it is blind in the other direction too, because the
    // "cannot GROW" check above only looks at keys NOT in the table.
    //
    // A stale row still fails here — a row whose function is gone reads as 0 found
    // against a pinned 1 — so nothing the replaced check covered is given up.
    const liveByKey = new Map<CallSiteKey, CallSite[]>();
    for (const c of sites) {
      const k = keyOf(c);
      const bucket = liveByKey.get(k);
      if (bucket) bucket.push(c);
      else liveByKey.set(k, [c]);
    }

    const wrong = Object.entries(EXPECTED_SURFACE_BY_CALL_SITE)
      .map(([key, pin]) => {
        const live = liveByKey.get(key) ?? [];
        if (live.length === pin.sites) return null;
        const where = live.length
          ? `remaining at line(s) ${live.map((c) => c.line).join(', ')}`
          : 'NONE remain';
        if (live.length < pin.sites)
          return (
            `${key} — pinned as covering ${pin.sites} ${NEEDLE} call(s), found ${live.length}. ` +
            `${where}. The pinned calls are: ${pin.siteNote}. A context build was DELETED from ` +
            `inside this function: if the key still exists, nothing else in this file or the ` +
            `suite can see it. If the removal is intended, lower \`sites\` on this row in the ` +
            `same change and say why — do not lower it to make this pass.`
          );
        return (
          `${key} — pinned as covering ${pin.sites} ${NEEDLE} call(s), found ${live.length} ` +
          `(at line(s) ${live.map((c) => c.line).join(', ')}). The pinned calls are: ` +
          `${pin.siteNote}. A new context build was added inside an ALREADY-pinned function, so ` +
          `the "set cannot GROW" check above did not see it — its key is already in the table. ` +
          `Confirm the new call plumbs its recorded substitutions onward exactly as this row's ` +
          `surface requires, then raise \`sites\` in the same change.`
        );
      })
      .filter((m): m is string => m !== null);
    expect(wrong).toEqual([]);
  });

  it('🔴 every call site passes the surface its pinned function must declare', () => {
    const wrong = sites
      .filter((c) => keyOf(c) in EXPECTED_SURFACE_BY_CALL_SITE)
      .map((c) => {
        const pin = EXPECTED_SURFACE_BY_CALL_SITE[keyOf(c)].surface;
        const at = `${c.file}:${c.line} inside ${c.fn}()`;
        const got = describeArg(c.surfaceArg);
        if (typeof pin === 'string') {
          // Literal pin: the surface slot holds exactly that literal. Swapping a
          // hardcoded surface for a resolved one without amending the table
          // fails here rather than passing quietly.
          if (c.surfaceArg.kind === 'literal' && c.surfaceArg.value === pin) return null;
          return `${at} passes ${got} in the surface slot, expected the literal '${pin}'`;
        }
        // Resolved pin: the slot holds a call to the ONE approved resolver, AND
        // this file imports that name from the module that defines it. Both
        // halves are load-bearing — re-hardcoding `'onsite'` fails the first
        // (even though 'onsite' is a legitimate value of the range), and a local
        // function or alias of the same name fails the second.
        if (c.surfaceArg.kind === 'call' && c.surfaceArg.callee === pin.resolvedBy) {
          if (c.importsResolver) return null;
          return (
            `${at} calls ${pin.resolvedBy}(...), but ${c.file} has no ` +
            `\`import { ${pin.resolvedBy} } from '${SURFACE_RESOLVER_MODULE}'\`. ` +
            `Either the name is bound to something else locally (a shadowing function, ` +
            `an alias of a DIFFERENT export) — which is the bug this checks for — or the ` +
            `import is written in a shape this guard deliberately does not accept ` +
            `(a namespace import, or a relative specifier for the same module). ` +
            `If it is the latter, switch to the '~/'-aliased named import above; do not loosen this check.`
          );
        }
        return `${at} passes ${got} in the surface slot, expected a call to ${pin.resolvedBy}(...)`;
      })
      .filter((m): m is string => m !== null);
    expect(wrong).toEqual([]);
  });

  /**
   * 🔴 THE TEST-CODE HOLE. "Required, not defaulted, so a new entry point is a
   * compile error" is a claim about what `tsc` sees — and `tsconfig.json`
   * EXCLUDES `src/[**]/__tests__/[**]`. A three-argument call inside a test tree
   * therefore typechecks clean, builds a collector with `surface: undefined`,
   * and no gate anywhere notices. Harmless while such a call only ever runs in a
   * test, but a test HELPER that wraps `buildGenerationContext` would propagate
   * unlabelled collectors with nothing catching it.
   *
   * Deliberately an ARITY check, NOT a surface-value or enclosing-function
   * check. Pinning either of those for a test would false-alarm on legitimate
   * fixtures — a table-driven test sweeping `GENERATION_SURFACES`, one passing
   * the value through a variable, and a call sitting directly in an `it(...)`
   * body (no named enclosing function at all) are all perfectly valid. Arity is
   * exactly the guarantee `tsc` gives the production tree, extended to the part
   * of the tree `tsc` never reads, and it constrains nothing else.
   */
  it('🔴 EVERY call site — test code included — passes the 4th `surface` argument', () => {
    const allSites = collectCallSites({ includeTests: true });
    const offenders = allSites
      .filter((c) => c.arity !== 4)
      .map((c) => `${c.file}:${c.line}: ${c.arity} args`);

    // Guard the guard: a broken enumeration must not pass vacuously.
    expect(allSites.length).toBeGreaterThanOrEqual(sites.length);
    expect(sites.length).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  it('the expectation table covers every declared surface (no orphan label)', () => {
    // A surface value with no call site would be a series that can never be
    // emitted — an alert keyed on it would then be structurally silent, which is
    // the exact failure class this counter exists to avoid.
    //
    // A resolved pin contributes its whole RANGE, because any of those values can
    // reach the counter from that one call site. The range is imported from
    // beside the resolver, and `generation-surface.test.ts` proves by execution
    // that the resolver actually produces every value in it — without that, a
    // range could list a surface nothing emits and this assertion would certify
    // the orphan instead of catching it.
    const covered = new Set<string>();
    for (const { surface } of Object.values(EXPECTED_SURFACE_BY_CALL_SITE)) {
      if (typeof surface === 'string') covered.add(surface);
      else for (const s of surface.range) covered.add(s);
    }
    expect([...covered].sort()).toEqual([...GENERATION_SURFACES].sort());
  });
});
