import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { clampExternalModerationSource } from '~/server/prom/external-moderation.metrics';
import { submitSourceForSurface } from '~/server/services/orchestrator/orchestrator-submit-metrics';
import { GENERATION_SURFACES } from '~/shared/data-graph/generation/model-substitution';

/**
 * 🔴 POPULATION + WIRING GUARD for the `source` label of
 * `civitai_app_external_moderation_duration_seconds`.
 *
 * The label is decided at the CALL SITE, travels through `auditPromptServer` as an
 * observability-only option, and is only read again inside `moderatePrompt`. Nothing about the
 * verdict, the deadline or the control flow depends on it — which is exactly why it can rot without
 * a single behavioural test noticing. Measured in the round-1 audit: hardcoding `'preset'` at the
 * `generateFromGraph` call site survived the entire unit suite, as did dropping the argument
 * altogether one level down. `tsc` cannot see either: `moderationSource` is optional, so `undefined`
 * is assignable, and `'preset'` is a legal member of the union.
 *
 * This file pins the two halves a behavioural test cannot reach:
 *
 *   1. THE MAPPING — what a `GenerationSurface` must become. Executed, not asserted about, so a
 *      change to `submitSourceForSurface` that re-buckets a surface fails here.
 *   2. THE LEDGER — every production `auditPromptServer` call site in `src/`, enumerated from the
 *      TREE rather than from a list someone maintains, each pinned to the `moderationSource`
 *      expression it must pass. It fails when the set GROWS (a new caller labelled by whatever was
 *      nearest to hand, or left undeclared and silently inflating `other`), when it SHRINKS (a stale
 *      row that has stopped guarding anything), and when any pinned site's expression changes.
 *
 * MECHANISM, and why it is the TypeScript AST rather than a regex: call sites are matched by
 * IDENTIFIER (so a `mockAuditPromptServer(...)` is not a call site), the option is read as an
 * object-literal PROPERTY (so a `moderationSource` appearing in a comment or a string cannot
 * satisfy it), and comments/string literals are excluded by construction. Same design as
 * `generation-surface-wiring.test.ts`, which guards the sibling `surface` label; read that file's
 * header for the full rationale on why the key is `file::enclosingFunction` and not the file.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../../..');

const NEEDLE = 'auditPromptServer';

/** The declaration itself — not a call site. */
const DEFINITION_FILE = 'src/server/services/orchestrator/promptAuditing.ts';
/** This guard's own source: it mentions the needle only in comments and strings. */
const GUARD_FILE = 'src/server/services/orchestrator/__tests__/moderation-source-wiring.test.ts';

/** The approved derivation, and the ONE module each half may be imported from. */
const CLAMP = 'clampExternalModerationSource';
const CLAMP_MODULE = '~/server/prom/external-moderation.metrics';
const MAPPER = 'submitSourceForSurface';
const MAPPER_MODULE = '~/server/services/orchestrator/orchestrator-submit-metrics';

type CallSiteKey = string;

type SourceArg =
  /** No `moderationSource` property at all — the caller takes the `other` default on purpose. */
  | { kind: 'absent' }
  /** A `ExternalModerationSource` string literal written at the call site. */
  | { kind: 'literal'; value: string }
  /** `clampExternalModerationSource(submitSourceForSurface(...))` — the surface-derived form. */
  | { kind: 'derived' }
  /** Anything else: a variable, a ternary, a cast, a different call, a shorthand property. */
  | { kind: 'other'; text: string };

interface CallSite {
  file: string;
  fn: string;
  line: number;
  sourceArg: SourceArg;
  /** Does this FILE import both halves of the derivation from the modules that define them? */
  importsDerivation: boolean;
}

const describeArg = (a: SourceArg): string =>
  a.kind === 'absent'
    ? 'no moderationSource property'
    : a.kind === 'literal'
    ? `the literal '${a.value}'`
    : a.kind === 'derived'
    ? `${CLAMP}(${MAPPER}(...))`
    : a.text;

/**
 * What each production caller must declare.
 *
 * 🔴 ADDING A ROW IS THE REVIEWABLE ACT. `'absent'` is a real choice, not a gap: it says "this
 * funnel is deliberately part of the `other` mixture", which the metric's own doc comment describes
 * as a mixture that must not be read as any single path. Choosing it for a HIGH-VOLUME caller is
 * what dilutes `other` into uselessness, so it has to be written down rather than defaulted into.
 */
const EXPECTED_SOURCE_BY_CALL_SITE: Record<CallSiteKey, SourceArg> = {
  // 🔴 DERIVED, NOT LITERAL. Both audits inside `generateFromGraph` (the prompt gate and the ACE
  // Audio creative fields) serve every surface the procedure serves — `onsite`, `api`, `block` and
  // `preset` — and which one it is is a property of the REQUEST. Hardcoding any member here is the
  // round-1 mutant: `'preset'` files every on-site generation under the cron's population, and
  // `'generate'` files the comics cron under the request path. Either way the one division this
  // metric supports is corrupted, and nothing else in the suite moves.
  'src/server/services/orchestrator/orchestration-new.service.ts::generateFromGraph': {
    kind: 'derived',
  },
  // The comics cron's explicit pre-submit gate. It runs OUTSIDE the tRPC request path and is the
  // second of the two external-moderation calls this job makes per panel — the other one is the
  // derived site above, reached through `submitPresetImageGen`. A literal is correct here precisely
  // because there is no request and therefore no surface to derive from; leaving it absent (which is
  // what shipped before round 1) made `preset` undercount this cron by half.
  'src/server/jobs/process-enqueued-comic-panels.ts::processEnqueuedComicPanelsJob': {
    kind: 'literal',
    value: 'preset',
  },
  // ── Deliberately part of the `other` mixture ────────────────────────────────────────────────
  // The App Blocks host-side audits. These are pre-checks the block host runs before it ever
  // reaches `generateFromGraph`; the generation they precede is labelled `generate` at the derived
  // site above, via surface `block`. Labelling them `generate` too would double-count the block
  // population against one submission.
  'src/server/routers/blocks.router.ts::submitWorkflow': { kind: 'absent' },
  'src/server/routers/blocks.router.ts::submitCustomComfyWorkflow': { kind: 'absent' },
  // Shared app content safety, block moderation steps and prompt enhancement: none of these is a
  // generation submission, so none belongs in a population that gets divided against
  // `generateFromGraph`'s wall time.
  'src/server/services/apps/shared-content-safety.ts::assertSharedTextSafe': { kind: 'absent' },
  'src/server/services/blocks/steps/moderation.ts::submit': { kind: 'absent' },
  'src/server/services/orchestrator/promptEnhancement.ts::enhancePrompt': { kind: 'absent' },
};

function candidateFiles(): string[] {
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
    .filter((f) => !(f.includes('__tests__') || f.endsWith('.test.ts')));
}

/** Nearest named enclosing function/method/`const fn = …`/object property. */
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

const calleeNameOf = (expr: ts.Expression): string | null =>
  ts.isIdentifier(expr)
    ? expr.text
    : ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)
    ? expr.name.text
    : null;

/**
 * Classify the `moderationSource` value at one call site.
 *
 * Conservative by construction: only the two approved shapes are recognised. A shorthand property,
 * a variable, a ternary, an `as` cast, a bare `MAPPER(...)` without the clamp, or a clamp wrapping
 * anything other than the mapper all land in `{ kind: 'other' }` and fail every pin — including
 * `clampExternalModerationSource('preset')`, which is the hardcode mutant wearing the right hat.
 */
function describeSourceArg(call: ts.CallExpression, src: ts.SourceFile): SourceArg {
  const arg = call.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg))
    return { kind: 'other', text: 'a non-literal options object' };

  const prop = arg.properties.find(
    (p) => p.name && ts.isIdentifier(p.name) && p.name.text === 'moderationSource'
  );
  if (!prop) return { kind: 'absent' };
  if (!ts.isPropertyAssignment(prop))
    return { kind: 'other', text: `a ${ts.SyntaxKind[prop.kind]} property` };

  const init = prop.initializer;
  if (ts.isStringLiteral(init)) return { kind: 'literal', value: init.text };
  if (ts.isCallExpression(init) && calleeNameOf(init.expression) === CLAMP) {
    const inner = init.arguments[0];
    if (inner && ts.isCallExpression(inner) && calleeNameOf(inner.expression) === MAPPER)
      return { kind: 'derived' };
    return {
      kind: 'other',
      text: `${CLAMP}(...) wrapping ${inner ? inner.getText(src).slice(0, 60) : 'nothing'}`,
    };
  }
  return { kind: 'other', text: ts.SyntaxKind[init.kind] };
}

/**
 * 🔴 NAME EQUALITY IS NOT ENOUGH — an identifier is just a name in scope. A module-local
 * `function submitSourceForSurface() { return 'preset'; }` shadowing the import would satisfy the
 * AST shape above and reinstate the exact mutant this guard exists for, with `tsc` clean. Requiring
 * the EXPORTED name to be imported from the module that DEFINES it closes that without a Program.
 * It fails CLOSED: a namespace import or a relative specifier for the same module fails too. That is
 * deliberate — if you hit it while adding a call site, switch to the `~/`-aliased named import
 * rather than loosening this.
 */
function importsNamedFrom(source: ts.SourceFile, moduleSpecifier: string, name: string): boolean {
  return source.statements.some((st) => {
    if (!ts.isImportDeclaration(st)) return false;
    if (!ts.isStringLiteral(st.moduleSpecifier)) return false;
    if (st.moduleSpecifier.text !== moduleSpecifier) return false;
    const named = st.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) return false;
    // The EXPORTED name, not the local binding: on `import { a as b }`, `propertyName` is `a`.
    return named.elements.some((el) => (el.propertyName ?? el.name).text === name);
  });
}

function callSitesIn(file: string): CallSite[] {
  const text = readFileSync(path.join(REPO_ROOT, file), 'utf8');
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const importsDerivation =
    importsNamedFrom(source, CLAMP_MODULE, CLAMP) &&
    importsNamedFrom(source, MAPPER_MODULE, MAPPER);
  const found: CallSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && calleeNameOf(node.expression) === NEEDLE) {
      found.push({
        file,
        fn: enclosingFunctionName(node),
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        sourceArg: describeSourceArg(node, source),
        importsDerivation,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const keyOf = (c: CallSite): CallSiteKey => `${c.file}::${c.fn}`;

/**
 * PART 1 — the mapping, executed.
 *
 * The AST ledger below can only prove that the derived call sites call this pair; it cannot know
 * what the pair RETURNS. That is what these cases pin, and they are what make the `derived` pin mean
 * something rather than merely being a shape.
 */
describe('surface → external-moderation source mapping', () => {
  const derive = (surface: Parameters<typeof submitSourceForSurface>[0]) =>
    clampExternalModerationSource(submitSourceForSurface(surface));

  it.each([
    ['onsite', 'generate'],
    ['api', 'generate'],
    // 🔴 `block` — the App Blocks bridge — maps to `generate`, NOT to a surface of its own. This is
    // the row the metric's doc comment used to contradict (it described `generate` as "surface
    // onsite/api"), and getting it wrong in the other direction means attributing App Blocks
    // latency to the on-site generator.
    ['block', 'generate'],
    ['preset', 'preset'],
  ] as const)('maps surface %s to source %s', (surface, expected) => {
    expect(
      derive(surface),
      `surface '${surface}' must be recorded as source '${expected}' on ` +
        `civitai_app_external_moderation_duration_seconds. Re-bucketing it silently moves an entire ` +
        `population between two series that operators divide against each other.`
    ).toBe(expected);
  });

  it('falls an ABSENT surface to other, never to generate', () => {
    expect(
      derive(undefined),
      'an unknown caller inflating the headline `generate` population is the failure nobody would ' +
        'notice; an absent surface must take the `other` default.'
    ).toBe('other');
  });

  it('covers every declared GenerationSurface (no surface left unmapped)', () => {
    // Guard the guard: a surface added later with no row above would otherwise be silently
    // untested, and would reach the histogram through the derived call sites regardless.
    const mapped = new Set(GENERATION_SURFACES.map((s) => derive(s)));
    expect(
      [...GENERATION_SURFACES].sort(),
      'every GENERATION_SURFACES member must appear in the table above'
    ).toEqual(['api', 'block', 'onsite', 'preset']);
    // …and each must land inside the bounded vocabulary, not on the clamp's fallback by accident.
    expect([...mapped].sort()).toEqual(['generate', 'preset']);
  });
});

/** PART 2 — the ledger of production call sites. */
describe('auditPromptServer moderationSource wiring', () => {
  let sites: CallSite[] = [];
  let enumerationError: unknown;
  try {
    sites = candidateFiles().flatMap(callSitesIn);
  } catch (e) {
    // A throw in the describe BODY happens during registration, so no `it` below would be declared
    // and the file would collect zero tests while reading green. Catch it and report it from a test.
    enumerationError = e;
  }

  it('finds the call sites at all (guard the guard)', () => {
    if (enumerationError) throw enumerationError;
    expect(
      sites.length,
      'a broken enumeration would make every assertion below pass vacuously over an empty list'
    ).toBeGreaterThanOrEqual(Object.keys(EXPECTED_SOURCE_BY_CALL_SITE).length);
    expect(
      sites.filter((c) => c.fn === '<module scope>'),
      'a call site with no named enclosing function would collapse distinct callers onto one key'
    ).toEqual([]);
  });

  it('🔴 every function that audits a prompt is a pinned call site (the set cannot GROW silently)', () => {
    const unexpected = sites
      .filter((c) => !(keyOf(c) in EXPECTED_SOURCE_BY_CALL_SITE))
      .map((c) => `${c.file}:${c.line} inside ${c.fn}() passes ${describeArg(c.sourceArg)}`);
    expect(
      unexpected,
      'a new auditPromptServer caller must declare its moderationSource on purpose — add a row to ' +
        'EXPECTED_SOURCE_BY_CALL_SITE. Left undeclared it joins the `other` mixture, which the ' +
        'metric documents as unreadable as any single path; labelled `generate` by reflex it ' +
        'inflates the one population the histogram exists to size.'
    ).toEqual([]);
  });

  it('no pinned call site has disappeared (the set cannot SHRINK silently)', () => {
    const live = new Set(sites.map(keyOf));
    const missing = Object.keys(EXPECTED_SOURCE_BY_CALL_SITE).filter((k) => !live.has(k));
    expect(
      missing,
      'a stale row guards nothing, and keeps this table reading as coverage while providing none'
    ).toEqual([]);
  });

  it('🔴 every pinned call site passes the moderationSource expression it must', () => {
    const wrong = sites
      .filter((c) => keyOf(c) in EXPECTED_SOURCE_BY_CALL_SITE)
      .map((c) => {
        const pin = EXPECTED_SOURCE_BY_CALL_SITE[keyOf(c)];
        const at = `${c.file}:${c.line} inside ${c.fn}()`;
        const got = describeArg(c.sourceArg);
        if (pin.kind === 'derived') {
          if (c.sourceArg.kind !== 'derived')
            return (
              `${at} passes ${got} in the moderationSource slot, expected ` +
              `${CLAMP}(${MAPPER}(<request surface>)). This call site serves EVERY surface, so any ` +
              `literal here files one population under another's series — the exact mutation this ` +
              `guard was added for.`
            );
          if (!c.importsDerivation)
            return (
              `${at} calls ${CLAMP}(${MAPPER}(...)), but ${c.file} does not import BOTH ` +
              `\`${CLAMP}\` from '${CLAMP_MODULE}' and \`${MAPPER}\` from '${MAPPER_MODULE}'. ` +
              `Either one of those names is bound to something else locally (a shadowing function ` +
              `or an alias of a different export) — which is the bug this checks for — or the ` +
              `import is written in a shape this guard deliberately does not accept (a namespace ` +
              `import, or a relative specifier). If it is the latter, switch to the ` +
              `'~/'-aliased named import; do not loosen this check.`
            );
          return null;
        }
        if (pin.kind === 'literal') {
          if (c.sourceArg.kind === 'literal' && c.sourceArg.value === pin.value) return null;
          return (
            `${at} passes ${got} in the moderationSource slot, expected the literal ` +
            `'${pin.value}'. This caller has no request surface to derive from, so the label is ` +
            `only ever as correct as this literal; dropping it sends the caller to 'other'.`
          );
        }
        if (c.sourceArg.kind === 'absent') return null;
        return (
          `${at} passes ${got}, but is pinned as deliberately UNDECLARED (part of the 'other' ` +
          `mixture). If this caller should now be labelled, change its row on purpose — a label ` +
          `added here moves observations into a series operators divide against a procedure's ` +
          `wall time.`
        );
      })
      .filter((m): m is string => m !== null);
    expect(wrong).toEqual([]);
  });
});
