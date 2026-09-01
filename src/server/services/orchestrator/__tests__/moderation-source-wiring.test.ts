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
 *      🔴 A row pins a COUNT of call sites, not just a key. The key is `file::enclosingFunction`,
 *      which is coarser than a call site — `generateFromGraph` and `enhancePrompt` each audit
 *      TWICE — so key-presence alone cannot see a deletion INSIDE a key. See `ExpectedCallSite`.
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
  /**
   * The call's first argument is not an INLINE object literal — a hoisted `const opts = {...}`, a
   * spread, a variable, a function call. Behaviour-identical for the app; opaque to this guard,
   * which reads `moderationSource` as a property of the literal at the call site. Kept distinct
   * from `other` because the two need OPPOSITE remedies: `other` means "the value you declared is
   * not one of the approved shapes", this means "I cannot see what you declared at all".
   */
  | { kind: 'unreadable'; text: string }
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
    : a.kind === 'unreadable'
    ? `options this guard cannot read (${a.text})`
    : a.text;

interface ExpectedCallSite {
  /**
   * 🔴 HOW MANY `auditPromptServer` CALLS THIS KEY COVERS — and the reason this field exists.
   *
   * A key is `file::enclosingFunction`, which is NOT 1:1 with call sites: a function may audit more
   * than once. Without a count, every check in this file degrades to "does the key still exist",
   * and a DELETION INSIDE an existing key is invisible. Measured in the round-2 audit: deleting the
   * ACE Audio `auditPromptServer` call from `generateFromGraph` — which silently stops moderating
   * `musicDescription` and `lyrics` — took the ledger from 9 live sites to 8 and left it 10/10
   * GREEN, because `generateFromGraph` still had its other call.
   */
  sites: number;
  /**
   * What the `sites` calls under this key ARE, in source order. Purely for the failure message: a
   * count mismatch can only report "expected N, found M", so this is what lets the message name the
   * call that vanished instead of sending the reader to diff the function by hand.
   */
  siteNote: string;
  /** The expression EVERY call under this key must pass in the `moderationSource` slot. */
  arg: SourceArg;
}

/**
 * What each production caller must declare.
 *
 * 🔴 ADDING A ROW IS THE REVIEWABLE ACT. `'absent'` is a real choice, not a gap: it says "this
 * funnel is deliberately part of the `other` mixture", which the metric's own doc comment describes
 * as a mixture that must not be read as any single path. Choosing it for a HIGH-VOLUME caller is
 * what dilutes `other` into uselessness, so it has to be written down rather than defaulted into.
 *
 * 🔴 CHANGING A `sites` COUNT IS EQUALLY REVIEWABLE. Lowering one is how a removed audit gets
 * waved through; do it only when the removal itself is the intended change.
 */
const EXPECTED_SOURCE_BY_CALL_SITE: Record<CallSiteKey, ExpectedCallSite> = {
  // 🔴 DERIVED, NOT LITERAL. Both audits inside `generateFromGraph` (the prompt gate and the ACE
  // Audio creative fields) serve every surface the procedure serves — `onsite`, `api`, `block` and
  // `preset` — and which one it is is a property of the REQUEST. Hardcoding any member here is the
  // round-1 mutant: `'preset'` files every on-site generation under the cron's population, and
  // `'generate'` files the comics cron under the request path. Either way the one division this
  // metric supports is corrupted, and nothing else in the suite moves.
  'src/server/services/orchestrator/orchestration-new.service.ts::generateFromGraph': {
    sites: 2,
    siteNote:
      '(1) the prompt gate on `data.prompt`, and (2) the ACE Audio creative-field audit on ' +
      '`musicDescription` + `lyrics`. Losing (2) stops moderating audio prompts entirely and ' +
      'changes NOTHING that any behavioural test observes',
    arg: { kind: 'derived' },
  },
  // The comics cron's explicit pre-submit gate. It runs OUTSIDE the tRPC request path and is the
  // second of the two external-moderation calls this job makes per panel — the other one is the
  // derived site above, reached through `submitPresetImageGen`. A literal is correct here precisely
  // because there is no request and therefore no surface to derive from; leaving it absent (which is
  // what shipped before round 1) made `preset` undercount this cron by half.
  'src/server/jobs/process-enqueued-comic-panels.ts::processEnqueuedComicPanelsJob': {
    sites: 1,
    siteNote: 'the explicit pre-submit gate, before `submitPresetImageGen`',
    arg: { kind: 'literal', value: 'preset' },
  },
  // ── Deliberately part of the `other` mixture ────────────────────────────────────────────────
  // The App Blocks host-side audits. These are pre-checks the block host runs before it ever
  // reaches `generateFromGraph`; the generation they precede is labelled `generate` at the derived
  // site above, via surface `block`. Labelling them `generate` too would double-count the block
  // population against one submission.
  'src/server/routers/blocks.router.ts::submitWorkflow': {
    sites: 1,
    siteNote: "the block host's pre-check on the submitted workflow prompt",
    arg: { kind: 'absent' },
  },
  'src/server/routers/blocks.router.ts::submitCustomComfyWorkflow': {
    sites: 1,
    siteNote: "the block host's pre-check on the custom-comfy prompt",
    arg: { kind: 'absent' },
  },
  // Shared app content safety, block moderation steps and prompt enhancement: none of these is a
  // generation submission, so none belongs in a population that gets divided against
  // `generateFromGraph`'s wall time.
  'src/server/services/apps/shared-content-safety.ts::assertSharedTextSafe': {
    sites: 1,
    siteNote: 'the shared-text safety audit',
    arg: { kind: 'absent' },
  },
  'src/server/services/blocks/steps/moderation.ts::submit': {
    sites: 1,
    siteNote: "the 'promptAudit' step's submit-phase audit",
    arg: { kind: 'absent' },
  },
  'src/server/services/orchestrator/promptEnhancement.ts::enhancePrompt': {
    sites: 2,
    siteNote:
      '(1) the audit of `prompt` + `negativePrompt`, and (2) the audit of the user-supplied ' +
      '`input.instruction`, which is separately user-controlled free text',
    arg: { kind: 'absent' },
  },
};

/** Total `auditPromptServer` calls the ledger claims to cover — sites, not keys. */
const EXPECTED_SITE_TOTAL = Object.values(EXPECTED_SOURCE_BY_CALL_SITE).reduce(
  (n, e) => n + e.sites,
  0
);

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
 *
 * Separately from those: an argument that is not an inline object literal at all yields
 * `{ kind: 'unreadable' }`, which is a claim about this guard's VISIBILITY rather than about the
 * caller's label, and carries its own failure message.
 */
function describeSourceArg(call: ts.CallExpression, src: ts.SourceFile): SourceArg {
  const arg = call.arguments[0];
  // 🔴 `unreadable`, NOT `other`. An argument that is not an inline object literal (a hoisted
  // `const opts = {...}`, a spread, a variable) is behaviour-identical for the app but opaque to
  // this AST guard — it is a statement about what this FILE can see, not about what the caller
  // declared. Reporting it as `other` sent a maintainer looking for a label that was never removed.
  if (!arg) return { kind: 'unreadable', text: 'called with no arguments at all' };
  if (!ts.isObjectLiteralExpression(arg))
    return {
      kind: 'unreadable',
      text: `its first argument is a ${ts.SyntaxKind[arg.kind]}, not an inline object literal`,
    };

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
    ).toBeGreaterThanOrEqual(EXPECTED_SITE_TOTAL);
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

  it('🔴 every pinned key covers EXACTLY the number of call sites it claims (no silent SHRINK, and no add hiding inside a key)', () => {
    // 🔴 COUNTED PER KEY, NOT MERELY PRESENT. The key is `file::enclosingFunction`, so a function
    // that audits twice occupies ONE key: a set-membership check goes green the moment ANY of its
    // calls survives. That is not a hypothetical — deleting `generateFromGraph`'s ACE Audio audit
    // (dropping `musicDescription`/`lyrics` moderation entirely) left the previous version of this
    // ledger fully green. The count is what makes a within-key deletion fail.
    const liveByKey = new Map<CallSiteKey, CallSite[]>();
    for (const c of sites) {
      const k = keyOf(c);
      const bucket = liveByKey.get(k);
      if (bucket) bucket.push(c);
      else liveByKey.set(k, [c]);
    }

    const wrong = Object.entries(EXPECTED_SOURCE_BY_CALL_SITE)
      .map(([key, pin]) => {
        const live = liveByKey.get(key) ?? [];
        if (live.length === pin.sites) return null;
        const where = live.length
          ? `remaining at line(s) ${live.map((c) => c.line).join(', ')}`
          : 'NONE remain';
        if (live.length < pin.sites)
          return (
            `${key} — pinned as covering ${pin.sites} ${NEEDLE} call(s), found ${live.length}. ` +
            `${where}. The pinned calls are: ${pin.siteNote}. An audit was DELETED from inside ` +
            `this function: the key still exists, so nothing else in this file or the suite can ` +
            `see it. If the removal is intended, lower \`sites\` on this row in the same change ` +
            `and say why — do not lower it to make this pass.`
          );
        return (
          `${key} — pinned as covering ${pin.sites} ${NEEDLE} call(s), found ${live.length} ` +
          `(at line(s) ${live.map((c) => c.line).join(', ')}). The pinned calls are: ` +
          `${pin.siteNote}. A new audit was added inside an ALREADY-pinned function, so the ` +
          `"set cannot GROW" check above did not see it — its moderationSource is still pinned ` +
          `by this row, which may or may not be the label it wants. Raise \`sites\` on purpose.`
        );
      })
      .filter((m): m is string => m !== null);

    expect(
      wrong,
      'a stale row guards nothing, and keeps this table reading as coverage while providing none'
    ).toEqual([]);
  });

  it('🔴 every pinned call site passes the moderationSource expression it must', () => {
    const wrong = sites
      .filter((c) => keyOf(c) in EXPECTED_SOURCE_BY_CALL_SITE)
      .map((c) => {
        const pin = EXPECTED_SOURCE_BY_CALL_SITE[keyOf(c)].arg;
        const at = `${c.file}:${c.line} inside ${c.fn}()`;
        const got = describeArg(c.sourceArg);
        // 🔴 ITS OWN MESSAGE, ahead of every pin branch. This is not "the declared label is wrong";
        // it is "this guard cannot READ the declaration". Folding it into the branches below
        // reported a hoisted `const opts = {...}` — behaviour-identical to the inline literal — as
        // a caller "pinned as deliberately UNDECLARED", which sends a maintainer hunting for a
        // label nobody removed.
        if (c.sourceArg.kind === 'unreadable')
          return (
            `${at} does not pass its options as an INLINE OBJECT LITERAL — ${c.sourceArg.text}. ` +
            `NOTHING IS NECESSARILY WRONG WITH THE LABEL: this guard reads \`moderationSource\` ` +
            `as a property of the literal written at the call site, so against a hoisted object ` +
            `(\`const opts = {...}; await ${NEEDLE}(opts)\`), a spread, or a variable it cannot ` +
            `see what this caller declares at all — and a ledger that cannot read a site cannot ` +
            `pin it. Do not go looking for a missing label. Inline the object literal at the call ` +
            `site (hoisting it is behaviour-identical, so nothing is lost by inlining it back). ` +
            `If this caller genuinely must build its options dynamically, that changes what this ` +
            `ledger can guarantee about it and needs a deliberate row design — not a loosened check.`
          );
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
