import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import ts from 'typescript';

import { GENERATION_SURFACES } from '~/shared/data-graph/generation/model-substitution';

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
  /** Every `GENERATION_SURFACES` member passed as a bare string literal. */
  surfaceLiterals: string[];
}

/**
 * Every PRODUCTION call site allowed to build a generation context, keyed by
 * `file::enclosingFunction`, with the surface it must declare.
 *
 * 🔴 Adding a row means asserting that the enclosing function plumbs a recorded
 * substitution onward in whatever way its surface requires — for `'block'`, onto
 * the `BlockWorkflowSnapshot` wire (see
 * `src/server/schema/blocks/workflow.schema.ts`'s `modelSubstitutions` contract).
 * A row added without that is the failure described above, just made official.
 */
const EXPECTED_SURFACE_BY_CALL_SITE: Record<CallSiteKey, string> = {
  // The on-site generator. #3520 calls this substitution CORRECT: the only way
  // the form holds an out-of-list id is a stale localStorage value after an
  // ecosystem switch, and the user visibly sees the picker snap back.
  'src/server/routers/orchestrator.router.ts::generateFromGraph': 'onsite',
  'src/server/routers/orchestrator.router.ts::whatIfFromGraph': 'onsite',
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
  'src/server/routers/blocks.router.ts::createBlockTextToImageStep': 'block',
  // Comics / preset image generation: server-composed graph input.
  'src/server/services/orchestrator/preset-image-gen.service.ts::submitPresetImageGen': 'preset',
  'src/server/services/orchestrator/preset-image-gen.service.ts::whatIfPresetImageGen': 'preset',
};

/**
 * Candidate files, enumerated from the TREE rather than from a hand-kept list.
 *
 * The grep needle is the BARE identifier (no trailing paren): it only has to
 * over-approximate, because the AST walk below decides what is really a call.
 * That removes every formatting dependency from the enumeration.
 *
 * `includeTests: false` is the PRODUCTION population (what the surface table
 * pins). `includeTests: true` adds the test tree, which `tsconfig.json` EXCLUDES
 * (`src/**\/__tests__/**`) — see the arity guard for why that matters.
 */
function candidateFiles({ includeTests }: { includeTests: boolean }): string[] {
  const out = execFileSync(
    'grep',
    ['-rl', '--include=*.ts', '--include=*.tsx', 'buildGenerationContext', 'src'],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  );
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
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
          surfaceLiterals: node.arguments
            .filter((a): a is ts.StringLiteral => ts.isStringLiteral(a))
            .map((a) => a.text)
            .filter((v) => (GENERATION_SURFACES as readonly string[]).includes(v)),
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
  const sites = collectCallSites({ includeTests: false });

  it('finds the call sites at all (guard the guard)', () => {
    // Without this, a broken enumeration would make every assertion below pass
    // vacuously over an empty list.
    expect(sites.length).toBeGreaterThanOrEqual(Object.keys(EXPECTED_SURFACE_BY_CALL_SITE).length);
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

  it('no pinned call site has disappeared (the table describes the live tree)', () => {
    // The other direction: a stale row would silently stop guarding anything,
    // and would also keep the surface-coverage assertion below green off a
    // function that no longer exists.
    const live = new Set(sites.map(keyOf));
    const missing = Object.keys(EXPECTED_SURFACE_BY_CALL_SITE).filter((k) => !live.has(k));
    expect(missing).toEqual([]);
  });

  it('🔴 every call site passes the surface its pinned function must declare', () => {
    const wrong = sites
      .filter((c) => keyOf(c) in EXPECTED_SURFACE_BY_CALL_SITE)
      .filter((c) => {
        const expected = EXPECTED_SURFACE_BY_CALL_SITE[keyOf(c)];
        return c.surfaceLiterals.length !== 1 || c.surfaceLiterals[0] !== expected;
      })
      .map(
        (c) =>
          `${c.file}:${c.line} inside ${c.fn}() passes [${c.surfaceLiterals.join(', ')}], ` +
          `expected exactly ['${EXPECTED_SURFACE_BY_CALL_SITE[keyOf(c)]}']`
      );
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
    expect([...new Set(Object.values(EXPECTED_SURFACE_BY_CALL_SITE))].sort()).toEqual(
      [...GENERATION_SURFACES].sort()
    );
  });
});
