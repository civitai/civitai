#!/usr/bin/env node
/**
 * Migrate test files off per-file `vi.mock` of a shared infra module and onto the
 * canonical mocks in `src/__tests__/mocks/`. See docs/testing/shared-module-mocks.md.
 *
 *   node scripts/test-perf/codemod-shared-mocks.mjs --dry                 # whole repo, report only
 *   node scripts/test-perf/codemod-shared-mocks.mjs --write <file>...     # convert named files
 *   node scripts/test-perf/codemod-shared-mocks.mjs --report out.json     # machine-readable
 *
 * It converts only the shapes it can prove are equivalent, and REFUSES anything else —
 * every refusal is reported with a reason. A file is either fully converted for a
 * specifier or left completely alone; there is no partial rewrite, because a leftover
 * `vi.mock` on a canonical specifier re-poisons the whole worker.
 */
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { globSync } from 'fs';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const TARGETS = {
  '~/server/db/client': { roots: ['dbRead', 'dbWrite'], mock: 'dbMock', from: '~/__tests__/mocks/db.mock' },
  '~/server/redis/client': { roots: ['redis', 'sysRedis'], mock: 'redisMock', from: '~/__tests__/mocks/redis.mock' },
  '~/server/logging/client': { roots: ['logToAxiom'], mock: 'loggingMock', from: '~/__tests__/mocks/logging.mock', flat: true },
};

const argv = process.argv.slice(2);
const dry = argv.includes('--dry') || !argv.includes('--write');
const reportPath = argv.includes('--report') ? argv[argv.indexOf('--report') + 1] : null;
const listPath = argv.includes('--list') ? argv[argv.indexOf('--list') + 1] : null;
const only = [
  ...argv.filter((a) => !a.startsWith('--') && a !== reportPath && a !== listPath),
  ...(listPath
    ? readFileSync(path.resolve(repoRoot, listPath), 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
    : []),
];

function main() {
  const results = [];

  for (const file of only.length ? only.map((f) => path.resolve(repoRoot, f)) : listTestFiles()) {
    const src = readFileSync(file, 'utf8');
    if (!Object.keys(TARGETS).some((t) => src.includes(`vi.mock('${t}'`) || src.includes(`vi.mock("${t}"`)))
      continue;

    const outcome = convert(file, src);
    results.push(outcome);
    if (!dry && outcome.converted.length) writeFileSync(file, outcome.text);
  }

  const converted = results.filter((r) => r.converted.length);
  const refused = results.filter((r) => r.refusals.length);
  console.log(`${results.length} candidate files | ${converted.length} convertible | ${refused.length} with refusals`);
  const byReason = {};
  for (const r of refused) for (const x of r.refusals) byReason[x.reason] = (byReason[x.reason] ?? 0) + 1;
  for (const [reason, n] of Object.entries(byReason).sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(n).padStart(4)}  ${reason}`);

  // A hand-written constant that DIFFERS from the real one is a test asserting against a
  // key production never emits. Printed separately because it is a finding, not a blocker.
  const drifted = results.flatMap((r) =>
    [...r.refusals, ...(r.findings ?? [])]
      .filter((x) => x.mismatches)
      .map((x) => ({ file: path.relative(repoRoot, r.file), ...x }))
  );
  if (drifted.length) {
    console.log(`\nCONSTANTS THAT DRIFTED FROM THE REAL VALUE (${drifted.length})`);
    for (const d of drifted) {
      console.log(`  ${d.file.replace(/\\/g, '/')}`);
      for (const m of d.mismatches)
        console.log(`    ${m.path}: real ${JSON.stringify(m.expected)} vs test ${JSON.stringify(m.actual)}`);
    }
  }

  if (reportPath) {
    writeFileSync(
      path.resolve(repoRoot, reportPath),
      JSON.stringify(
        results.map((r) => ({ file: path.relative(repoRoot, r.file).replace(/\\/g, '/'), converted: r.converted, refusals: r.refusals })),
        null,
        2
      )
    );
  }
  if (dry) console.log('\n(dry run — pass --write to apply)');
}

/** Real constants a test factory may hand-write beside the client, and where they live. */
const CONSTANT_EXPORTS = {
  REDIS_KEYS: 'REDIS_KEYS_UNPREFIXED',
  REDIS_SYS_KEYS: 'REDIS_SYS_KEYS',
};
const UNKNOWN = Symbol('not-statically-evaluable');

let realConstantsCache = null;
/**
 * Statically evaluate the real key tables out of `@civitai/redis`.
 *
 * Parsed rather than imported: the codemod is plain node and the source is TypeScript. Both
 * tables are nested object literals of string literals, so a static walk is exact.
 *
 * `REDIS_KEYS` is `applyCacheKeyPrefix(REDIS_KEYS_UNPREFIXED)`, which is the identity unless
 * `CACHE_KEY_NAMESPACE` is set — it is not, under test — so the unprefixed table is the value
 * a test sees.
 */
function realConstants() {
  if (realConstantsCache) return realConstantsCache;
  const file = path.join(repoRoot, 'packages/civitai-redis/src/client.ts');
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const found = {};
  for (const stmt of sf.statements) {
    const decls = ts.isVariableStatement(stmt) ? stmt.declarationList.declarations : [];
    for (const d of decls) {
      if (!ts.isIdentifier(d.name) || !d.initializer) continue;
      for (const [exported, source] of Object.entries(CONSTANT_EXPORTS))
        if (d.name.text === source) found[exported] = staticValue(d.initializer);
    }
  }
  for (const [exported, source] of Object.entries(CONSTANT_EXPORTS))
    if (!found[exported] || found[exported] === UNKNOWN)
      throw new Error(`Could not statically read ${source} from ${file} — refusing to guess.`);
  realConstantsCache = found;
  return found;
}

/** Nested object/string literal to a plain value, or UNKNOWN. */
function staticValue(node) {
  let n = node;
  while (ts.isAsExpression(n) || ts.isParenthesizedExpression(n)) n = n.expression;
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isNumericLiteral(n)) return Number(n.text);
  if (n.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (n.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(n)) {
    const out = [];
    for (const el of n.elements) {
      const v = staticValue(el);
      if (v === UNKNOWN) return UNKNOWN;
      out.push(v);
    }
    return out;
  }
  if (ts.isObjectLiteralExpression(n)) {
    const out = {};
    for (const p of n.properties) {
      if (!ts.isPropertyAssignment(p)) return UNKNOWN;
      const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null;
      if (key === null) return UNKNOWN;
      const v = staticValue(p.initializer);
      if (v === UNKNOWN) return UNKNOWN;
      out[key] = v;
    }
    return out;
  }
  return UNKNOWN;
}

/** Every path where `candidate` is not a value-identical subset of `real`. */
function subsetMismatches(candidate, real, prefix) {
  if (candidate === UNKNOWN || real === undefined)
    return [{ path: prefix, expected: real, actual: candidate === UNKNOWN ? '<not literal>' : candidate }];
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate))
    return candidate === real || JSON.stringify(candidate) === JSON.stringify(real)
      ? []
      : [{ path: prefix, expected: real, actual: candidate }];
  if (typeof real !== 'object' || real === null)
    return [{ path: prefix, expected: real, actual: candidate }];
  return Object.entries(candidate).flatMap(([k, v]) => subsetMismatches(v, real[k], `${prefix}.${k}`));
}

function listTestFiles() {
  return globSync('src/**/*.test.ts', { cwd: repoRoot }).map((f) => path.join(repoRoot, f));
}

/** Behaviour assignments to emit for the file currently being converted. Module-level
 * because `convert` is not reentrant and threading it through every helper buried the shape
 * of the walk. Reset at the top of each call. */
let lifts = [];
/** A file that resets implementations between tests cannot carry a module-scope lift: the
 * assignment would be wiped before the first test runs. `clearAllMocks` is fine — it clears
 * calls, not implementations. */
let liftingAllowed = true;

function convert(file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  lifts = [];
  liftingAllowed = !/(resetAllMocks|restoreAllMocks)/.test(text);
  const refusals = [];
  /** Reported alongside the conversion rather than blocking it. */
  const findings = [];
  const convertedTargets = [];
  /** identifier name -> Set of canonical expressions it was bound to */
  const bindings = new Map();
  /** ExpressionStatement ranges to delete */
  const deletions = [];
  const importsNeeded = new Set();

  for (const stmt of sf.statements) {
    const call = asViMockCall(stmt);
    if (!call) continue;
    const target = literalText(call.arguments[0]);
    const spec = TARGETS[target];
    if (!spec) continue;

    // No factory: automock. The canonical registration already covers the module.
    if (call.arguments.length === 1) {
      deletions.push(stmt);
      convertedTargets.push(target);
      importsNeeded.add(target);
      continue;
    }

    const obj = factoryObject(call.arguments[1]);
    if (!obj) {
      refusals.push({ target, reason: 'factory is not a plain object literal (importOriginal / block body)' });
      continue;
    }

    const local = [];
    let ok = true;
    const originalNames = obj.__originalNames ?? new Set();
    for (const prop of obj.properties) {
      if (isOriginalSpread(prop, originalNames)) continue;
      if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) {
        ok = false;
        refusals.push({ target, reason: 'non-literal property in factory (spread or computed key)' });
        break;
      }
      const root = prop.name.text;

      // A factory that hand-writes part of a real constant next to the client. The
      // canonical registration spreads the original, so the hand-written copy is
      // redundant WHEN IT MATCHES — and when it does not, the test has been asserting
      // against a key production never emits, which is a finding rather than an obstacle.
      if (CONSTANT_EXPORTS[root]) {
        // The canonical registration spreads `@civitai/redis/client`, where both tables are
        // defined — so the factory's copy is redundant and can be DELETED rather than
        // translated. Proving the literal equals the real constant was the wrong question:
        // it is unanswerable for a call expression like `completeKeys({ … })`, and it is not
        // what decides safety. What decides safety is whether the test asserts on a key
        // string, and a test that never names the constant cannot. (arabella, taxonomy §2.)
        if (new RegExp(`\b${root}\b`).test(text.replace(prop.getText(), ''))) {
          refusals.push({ target, reason: `${root} is referenced outside the factory — check what it asserts` });
          ok = false;
          break;
        }
        const literal = staticValue(prop.initializer);
        const mismatches =
          literal === UNKNOWN ? [] : subsetMismatches(literal, realConstants()[root], root);
        // Reported, not refused: a divergent copy is a test asserting against a key
        // production never emits, and the redness when the real value swaps in IS the
        // finding.
        if (mismatches.length) findings.push({ target, reason: `${root} differed from the real constant`, mismatches });
        continue;
      }

      // Any export other than the client roots is already supplied by the registration,
      // which spreads the whole package (`safeError`, `withSysReadDeadline`, the key
      // tables). The factory only declared it because replacing the module wholesale meant
      // it had to. Same safety question as the constants: droppable unless the test names it
      // outside the factory, in which case it may be asserting on the stub.
      if (!spec.roots.includes(root)) {
        if (new RegExp(`\b${root}\b`).test(text.replace(prop.getText(), ''))) {
          refusals.push({ target, reason: `factory declares "${root}", and the test references it — check what it asserts` });
          ok = false;
          break;
        }
        continue;
      }
      if (spec.flat) {
        if (!collect(prop.initializer, `${spec.mock}.${root}`, local, refusals, target)) ok = false;
      } else if (ts.isObjectLiteralExpression(prop.initializer)) {
        for (const modelProp of prop.initializer.properties) {
          if (!ts.isPropertyAssignment(modelProp) || !ts.isIdentifier(modelProp.name)) {
            ok = false;
            refusals.push({ target, reason: 'non-literal property inside a client object' });
            break;
          }
          const name = modelProp.name.text;
          if (ts.isObjectLiteralExpression(modelProp.initializer)) {
            for (const m of modelProp.initializer.properties) {
              if (!ts.isPropertyAssignment(m) || !ts.isIdentifier(m.name)) {
                ok = false;
                refusals.push({ target, reason: 'non-literal property inside a model object' });
                break;
              }
              if (!collect(m.initializer, `${spec.mock}.${root}.${name}.${m.name.text}`, local, refusals, target))
                ok = false;
            }
          } else if (!collect(modelProp.initializer, `${spec.mock}.${root}.${name}`, local, refusals, target)) {
            ok = false;
          }
        }
      } else if (!collect(prop.initializer, `${spec.mock}.${root}`, local, refusals, target)) {
        ok = false;
      }
      if (!ok) break;
    }
    if (!ok) continue;

    for (const [name, expr] of local) {
      if (!bindings.has(name)) bindings.set(name, new Set());
      bindings.get(name).add(expr);
    }
    deletions.push(stmt);
    convertedTargets.push(target);
    importsNeeded.add(target);
  }

  if (!convertedTargets.length) return { file, text, converted: [], refusals, findings };

  // A local bound to two canonical paths is the dbRead/dbWrite aliasing case: one spy
  // served both clients, so a write satisfied a read assertion. There is no mechanical
  // rewrite that preserves that — the file has to name the client it exercises.
  const edits = [];
  const hoistedRemovals = [];
  const keepLeadingComment = new Set();
  const lifted = [];
  for (const [name, exprs] of bindings) {
    if (exprs.size > 1) {
      refusals.push({ target: 'multiple', reason: `local "${name}" aliases ${[...exprs].join(' and ')} — needs a human`, alias: [...exprs] });
      return { file, text, converted: [], refusals, findings };
    }
    const expr = [...exprs][0];
    const decl = findDeclaration(sf, name);
    if (decl) {
      if (!isPlainSpyInitializer(decl.initializer, expr)) {
        refusals.push({ target: 'multiple', reason: `declaration of "${name}" is not a bare vi.fn()/vi.hoisted(() => vi.fn())` });
        return { file, text, converted: [], refusals, findings };
      }
      edits.push({ start: decl.initializer.getStart(sf), end: decl.initializer.getEnd(), replacement: expr });
      continue;
    }

    // `const { a, b } = vi.hoisted(() => ({ a: vi.fn(), b: vi.fn() }))` — the dominant
    // shape in this repo. The hoisted object usually also feeds mocks of OTHER modules,
    // so only this name's binding and property come out; the rest of the object stays.
    const hoisted = findHoistedBinding(sf, name);
    if (!hoisted) {
      refusals.push({ target: 'multiple', reason: `no module-scope declaration found for "${name}"` });
      return { file, text, converted: [], refusals, findings };
    }
    if (!isPlainSpyInitializer(hoisted.initializer, expr)) {
      refusals.push({ target: 'multiple', reason: `hoisted entry "${name}" is not a bare vi.fn()` });
      return { file, text, converted: [], refusals, findings };
    }
    hoistedRemovals.push(hoisted);
    lifted.push(`const ${name} = ${expr};`);
  }

  // Group hoisted removals by their statement so a fully-emptied `vi.hoisted` goes away
  // whole rather than leaving `const {} = vi.hoisted(() => ({}))`.
  const byStatement = new Map();
  for (const h of hoistedRemovals) {
    if (!byStatement.has(h.statement)) byStatement.set(h.statement, []);
    byStatement.get(h.statement).push(h);
  }
  for (const [stmt, removals] of byStatement) {
    const { pattern, object } = removals[0];
    if (removals.length === object.properties.length && removals.length === pattern.elements.length) {
      // Keep any comment above it: a comment over a `vi.hoisted` block usually explains the
      // TEST, not the spy declarations, so taking it with the statement loses real prose. A
      // comment over a `vi.mock` is about the mock and goes with it.
      deletions.push(stmt);
      keepLeadingComment.add(stmt);
      continue;
    }
    for (const r of removals) {
      edits.push(dropListItem(r.element, pattern.elements, text));
      edits.push(dropListItem(r.property, object.properties, text));
      // The local the returned property named, when nothing else in the block read it.
      if (r.localStatement) {
        let end = r.localStatement.getEnd();
        while (end < text.length && (text[end] === '\r' || text[end] === '\n')) end++;
        let start = r.localStatement.getStart(sf);
        // Take the indentation with it, or the removal leaves a whitespace-only line.
        while (start > 0 && (text[start - 1] === ' ' || text[start - 1] === '\t')) start--;
        edits.push({ start, end, replacement: '' });
      }
    }
  }

  for (const stmt of deletions) {
    let end = stmt.getEnd();
    while (end < text.length && (text[end] === '\r' || text[end] === '\n')) end++;
    const start =
      stmt.getFullStart() === 0 || keepLeadingComment.has(stmt)
        ? stmt.getStart(sf)
        : leadingStart(stmt, sf, text);
    edits.push({ start, end, replacement: '' });
  }

  // Imports AND the lifted consts go in one insertion after the last import. Anchoring the
  // consts on the `vi.hoisted` statement instead put the insertion point inside a range the
  // deletion pass then removed, and the two edits overlapped — which silently ate the first
  // character of the inserted `const` and the doc comment above it.
  // A test's own local can be named exactly what the canonical mock is imported as —
  // `const { redisMock } = vi.hoisted(...)` is real, and lifting it produced the
  // self-referential `const redisMock = redisMock.redis;`. Where that happens the import is
  // aliased and every generated expression re-prefixed, so the local keeps its name and the
  // test body still needs no edits.
  const taken = new Set([...bindings.keys(), ...topLevelNames(sf)]);
  const alias = {};
  for (const target of importsNeeded) {
    const { mock } = TARGETS[target];
    alias[mock] = taken.has(mock) ? `canonical${mock[0].toUpperCase()}${mock.slice(1)}` : mock;
  }
  const reprefix = (line) =>
    Object.entries(alias).reduce(
      (acc, [from, to]) => (from === to ? acc : acc.replace(new RegExp(`\\b${from}\\.`, 'g'), `${to}.`)),
      line
    );

  const importLines = [...importsNeeded]
    .map((t) => TARGETS[t])
    .map((s) => (alias[s.mock] === s.mock ? `import { ${s.mock} } from '${s.from}';` : `import { ${s.mock} as ${alias[s.mock]} } from '${s.from}';`))
    .filter((line) => !text.includes(line));
  const inserted = [...importLines, ...lifted.map(reprefix), ...lifts.map(reprefix)];
  if (inserted.length) {
    const lastImport = [...sf.statements].reverse().find((s) => ts.isImportDeclaration(s));
    const at = lastImport ? lastImport.getEnd() : 0;
    edits.push({ start: at, end: at, replacement: `\n${inserted.join('\n')}` });
  }

  edits.sort((a, b) => b.start - a.start);
  let out = text;
  for (const e of edits) out = out.slice(0, e.start) + reprefix(e.replacement) + out.slice(e.end);

  return { file, text: out, converted: convertedTargets, refusals, findings };
}

/** Record `name -> canonicalExpr` for an identifier value; accept a bare `vi.fn()` (the
 * canonical node already covers it); refuse anything carrying its own behaviour. */
function collect(init, expr, local, refusals, target) {
  if (ts.isIdentifier(init)) {
    local.push([init.text, expr]);
    return true;
  }
  if (isBareViFn(init)) return true;
  // An anonymous async-noop logToAxiom is the canonical default, and nothing can assert on
  // it (no local name), so it drops.
  if (expr.endsWith('loggingMock.logToAxiom') && isAsyncNoopSpy(init)) return true;
  // `findUnique: vi.fn(async () => null)` and friends restate the canonical default, so
  // dropping them is a no-op. Compared against THIS path's default, not a general one.
  if (isDefaultEquivalent(expr, init)) return true;
  // A pure passthrough — `findMany: (...args) => localFn(...args)` — exists only so the
  // factory can reach a hoisted local. Once the factory is gone the wrapper has no
  // purpose, and binding the local straight to the canonical node is the same function.
  const passthrough = passthroughTarget(init);
  if (passthrough) {
    local.push([passthrough, expr]);
    return true;
  }
  // Behaviour the canonical default does not cover. It does not have to be refused — it is
  // already an expression, so it can be LIFTED onto the canonical node as an explicit
  // assignment. Callers decide whether lifting is safe for this file (see liftGuard).
  const lift = liftingAllowed ? liftedAssignment(init, expr) : null;
  if (lift) {
    lifts.push(lift);
    return true;
  }
  refusals.push({ target, reason: `inline behaviour at ${expr} (${init.getText().slice(0, 60)})` });
  return false;
}

/**
 * Rewrite a factory leaf's behaviour as an assignment on the canonical node.
 *
 *   findMany: vi.fn(async () => [1])          ->  node.mockImplementation(async () => [1])
 *   get: vi.fn().mockResolvedValue(null)      ->  node.mockResolvedValue(null)
 *   findUnique: mocks.userFindUnique          ->  node.mockImplementation((...a) => mocks.userFindUnique(...a))
 *
 * The last form keeps the test's own spy in the call path, so `expect(mocks.userFindUnique)
 * .toHaveBeenCalled()` still holds — the assertions do not move.
 */
function liftedAssignment(init, expr) {
  // `vi.fn(fn)` / `vi.fn(async function* () {})`
  if (isBareViFnWithArgs(init) && init.arguments.length === 1)
    return `${expr}.mockImplementation(${init.arguments[0].getText()});`;

  // `vi.fn().mockResolvedValue(v)` and the other single-call configurators.
  if (
    ts.isCallExpression(init) &&
    ts.isPropertyAccessExpression(init.expression) &&
    /^mock(ResolvedValue|RejectedValue|ReturnValue|Implementation)$/.test(init.expression.name.text) &&
    isBareViFn(init.expression.expression) &&
    init.arguments.length === 1
  )
    return `${expr}.${init.expression.name.text}(${init.arguments[0].getText()});`;

  // A bare function the factory used directly as the export.
  if (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
    return `${expr}.mockImplementation(${init.getText()});`;

  // A spy reached through an object — `mocks.findMany`, `h.get`. Wrapped rather than
  // rebound, because the test asserts on that object's property, not on this node.
  if (ts.isPropertyAccessExpression(init) && ts.isIdentifier(init.expression))
    return `${expr}.mockImplementation((...args: unknown[]) => (${init.getText()} as (...a: unknown[]) => unknown)(...args));`;

  return null;
}

/**
 * The canonical post-reset defaults, keyed on the last path segment. Kept in step with
 * src/__tests__/mocks/{db,redis}.mock.ts — a value here that the mock does not actually
 * default to would make the codemod delete real behaviour.
 */
function canonicalDefaults() {
  return {
    findMany: '[]',
    findUnique: 'null',
    findUniqueOrThrow: 'null',
    findFirst: 'null',
    findFirstOrThrow: 'null',
    count: '0',
    groupBy: '[]',
    aggregate: 'null',
    $queryRaw: '[]',
    $queryRawUnsafe: '[]',
    $executeRaw: '0',
    $executeRawUnsafe: '0',
    get: 'null',
    hGet: 'null',
    hGetAll: '{}',
    mGet: '[]',
    sMembers: '[]',
    zRange: '[]',
    lRange: '[]',
    keys: '[]',
    exists: '0',
    del: '0',
    sCard: '0',
    set: "'OK'",
    setEx: "'OK'",
  };
}

/**
 * A whole client built as an object literal of spies —
 * `mockDbRead: { $queryRaw: vi.fn(), collection: { findFirstOrThrow: vi.fn() } }` — bound to
 * the factory as `dbRead: mockDbRead`.
 *
 * Equivalent to the canonical client root when every leaf is a bare `vi.fn()` or restates
 * that leaf's own canonical default, because binding the root makes each leaf vivify at
 * exactly the path the literal named. A leaf carrying real behaviour is refused: it would be
 * silently dropped.
 */
function isEquivalentClientLiteral(node, canonicalExpr) {
  if (!ts.isObjectLiteralExpression(node)) return false;
  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) return false;
    const childExpr = `${canonicalExpr}.${prop.name.text}`;
    const init = prop.initializer;
    if (isBareViFn(init) || isDefaultEquivalent(childExpr, init)) continue;
    if (isEquivalentClientLiteral(init, childExpr)) continue;
    // A leaf carrying behaviour does not disqualify the literal — the behaviour lifts onto
    // the canonical node. `$executeRaw: vi.fn().mockResolvedValue(undefined)` beside four
    // bare spies was the whole reason these clients refused. (arabella, taxonomy §3.)
    if (liftingAllowed) {
      const lift = liftedAssignment(init, childExpr);
      if (lift) {
        lifts.push(lift);
        continue;
      }
    }
    return false;
  }
  return node.properties.length > 0;
}

/** True when an inline spy just restates this path's canonical default. */
function isDefaultEquivalent(canonicalExpr, node) {
  const expected = canonicalDefaults()[canonicalExpr.slice(canonicalExpr.lastIndexOf('.') + 1)];
  if (!expected || !ts.isCallExpression(node)) return false;

  let returned = null;
  if (isBareViFnWithArgs(node) && node.arguments.length === 1) {
    const fn = node.arguments[0];
    if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && fn.body && !ts.isBlock(fn.body))
      returned = fn.body;
  } else if (
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'mockResolvedValue' &&
    isBareViFn(node.expression.expression) &&
    node.arguments.length === 1
  ) {
    returned = node.arguments[0];
  }
  if (!returned) return false;
  while (ts.isParenthesizedExpression(returned) || ts.isAsExpression(returned)) returned = returned.expression;
  return returned.getText().replace(/\s+/g, '') === expected.replace(/\s+/g, '');
}

/** `(...args) => ident(...args)`, including the `(...(args as X))` cast spelling. */
function passthroughTarget(node) {
  const fn = ts.isCallExpression(node) && isBareViFnWithArgs(node) && node.arguments.length === 1 ? node.arguments[0] : node;
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return null;
  if (fn.parameters.length !== 1 || !fn.parameters[0].dotDotDotToken) return null;
  const param = fn.parameters[0].name;
  if (!ts.isIdentifier(param)) return null;
  let body = fn.body;
  if (!body || ts.isBlock(body)) return null;
  while (ts.isParenthesizedExpression(body)) body = body.expression;
  if (!ts.isCallExpression(body) || !ts.isIdentifier(body.expression)) return null;
  if (body.arguments.length !== 1) return null;
  const arg = body.arguments[0];
  if (!ts.isSpreadElement(arg)) return null;
  let spread = arg.expression;
  while (ts.isParenthesizedExpression(spread) || ts.isAsExpression(spread)) spread = spread.expression;
  if (!ts.isIdentifier(spread) || spread.text !== param.text) return null;
  return body.expression.text;
}

function isBareViFnWithArgs(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'vi' &&
    node.expression.name.text === 'fn'
  );
}

/** `vi.fn().mockResolvedValue(undefined)`, `vi.fn(async () => undefined)`,
 * `vi.fn(() => Promise.resolve())` — all the spellings of "resolves to nothing". */
function isAsyncNoopSpy(node) {
  if (!ts.isCallExpression(node)) return false;
  const text = node.getText().replace(/\s+/g, '');
  return (
    text === 'vi.fn().mockResolvedValue(undefined)' ||
    text === 'vi.fn(async()=>undefined)' ||
    text === 'vi.fn(async()=>{})' ||
    text === 'vi.fn(()=>Promise.resolve())' ||
    text === 'vi.fn(()=>Promise.resolve(undefined))'
  );
}

function isBareViFn(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'vi' &&
    node.expression.name.text === 'fn' &&
    node.arguments.length === 0
  );
}

/** Delete one element of a comma-separated list, taking the separator with it. */
function dropListItem(item, list, text) {
  const index = list.indexOf(item);
  const start = item.getStart();
  let end = item.getEnd();
  if (index < list.length - 1) {
    while (end < text.length && text[end] !== ',') end++;
    end++; // the comma
    while (end < text.length && (text[end] === ' ' || text[end] === '\r' || text[end] === '\n')) end++;
  } else {
    // Last item: eat the PRECEDING comma instead, or a trailing one if present.
    if (text[end] === ',') end++;
  }
  return { start, end, replacement: '' };
}

/** Every name declared at the top level of the file — imports, consts, functions, classes. */
function topLevelNames(sf) {
  const names = new Set();
  const add = (node) => {
    if (!node) return;
    if (ts.isIdentifier(node)) names.add(node.text);
    else if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node))
      for (const el of node.elements) if (ts.isBindingElement(el)) add(el.name);
  };
  for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt)) for (const d of stmt.declarationList.declarations) add(d.name);
    else if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) add(stmt.name);
    else if (ts.isImportDeclaration(stmt) && stmt.importClause) {
      add(stmt.importClause.name);
      const b = stmt.importClause.namedBindings;
      if (b && ts.isNamedImports(b)) for (const el of b.elements) add(el.name);
      else if (b && ts.isNamespaceImport(b)) add(b.name);
    }
  }
  return names;
}

function findHoistedBinding(sf, name) {
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const d of stmt.declarationList.declarations) {
      if (!ts.isObjectBindingPattern(d.name) || !d.initializer) continue;
      const call = d.initializer;
      if (
        !ts.isCallExpression(call) ||
        !ts.isPropertyAccessExpression(call.expression) ||
        !ts.isIdentifier(call.expression.expression) ||
        call.expression.expression.text !== 'vi' ||
        call.expression.name.text !== 'hoisted'
      )
        continue;
      const fn = call.arguments[0];
      if (!fn || (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) || !fn.body) continue;

      // A block body builds its clients as locals and returns them by name:
      //   vi.hoisted(() => { const dbRead = {...}; return { mockDbRead: dbRead }; })
      // Track those locals so the returned identifier can be resolved to its literal.
      const locals = new Map();
      let body = fn.body;
      if (ts.isBlock(body)) {
        let returned = null;
        for (const s of body.statements) {
          if (ts.isVariableStatement(s)) {
            for (const local of s.declarationList.declarations)
              if (ts.isIdentifier(local.name) && local.initializer)
                locals.set(local.name.text, { declaration: local, statement: s });
            continue;
          }
          if (ts.isReturnStatement(s) && s.expression) returned = s.expression;
        }
        if (!returned) continue;
        body = returned;
      }
      while (ts.isParenthesizedExpression(body)) body = body.expression;
      if (!ts.isObjectLiteralExpression(body)) continue;

      const element = d.name.elements.find(
        (e) => ts.isIdentifier(e.name) && e.name.text === name && !e.propertyName && !e.dotDotDotToken
      );
      const property = body.properties.find(
        (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name
      );
      if (!element || !property) continue;

      // Resolve `mockDbRead: dbRead` to `dbRead`'s literal. The local is only removable if
      // nothing else in the block reads it — counted textually, and conservatively: two
      // occurrences means the declaration plus this one reference.
      let initializer = property.initializer;
      let localStatement = null;
      if (ts.isIdentifier(initializer) && locals.has(initializer.text)) {
        const local = locals.get(initializer.text);
        const uses = (fn.getText().match(new RegExp(`\\b${initializer.text}\\b`, 'g')) ?? []).length;
        if (uses === 2) localStatement = local.statement;
        initializer = local.declaration.initializer;
      }

      return { statement: stmt, pattern: d.name, object: body, element, property, initializer, localStatement };
    }
  }
  return null;
}

function isPlainSpyInitializer(node, canonicalExpr = '') {
  if (!node) return false;
  if (isBareViFn(node)) return true;
  if (canonicalExpr && isEquivalentClientLiteral(node, canonicalExpr)) return true;
  // `vi.fn().mockResolvedValue(undefined)` is exactly the canonical logToAxiom default,
  // so binding it to the canonical node loses nothing. Deliberately NOT generalised: for
  // any other node the default differs and dropping the behaviour would change the test.
  if (canonicalExpr.endsWith('loggingMock.logToAxiom') && isAsyncNoopSpy(node)) return true;
  // vi.hoisted(() => vi.fn())
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'vi' &&
    node.expression.name.text === 'hoisted' &&
    node.arguments.length === 1
  ) {
    const fn = node.arguments[0];
    if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && fn.body && !ts.isBlock(fn.body))
      return isBareViFn(fn.body);
  }
  return false;
}

function findDeclaration(sf, name) {
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const d of stmt.declarationList.declarations)
      if (ts.isIdentifier(d.name) && d.name.text === name) return d;
  }
  return null;
}

function asViMockCall(stmt) {
  if (!ts.isExpressionStatement(stmt)) return null;
  const call = stmt.expression;
  if (!ts.isCallExpression(call)) return null;
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  if (!ts.isIdentifier(callee.expression) || callee.expression.text !== 'vi') return null;
  if (callee.name.text !== 'mock') return null;
  return call;
}

function literalText(node) {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
}

/**
 * The object literal a `vi.mock` factory returns, in every spelling this repo uses:
 *
 *   () => ({ … })
 *   async (importOriginal) => ({ ...(await importOriginal()), … })
 *   async (importOriginal) => { const actual = await importOriginal(); return { ...actual, … }; }
 *
 * The `importOriginal` spread is dropped rather than refused: the canonical registration in
 * setup.ts spreads the original itself, so a file re-spreading it adds nothing. Only the
 * OVERRIDES have to be accounted for.
 */
function factoryObject(node) {
  if (!node || (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node))) return null;
  const originalNames = new Set();
  if (node.parameters.length) {
    if (node.parameters.length > 1) return null;
    const p = node.parameters[0].name;
    if (!ts.isIdentifier(p)) return null;
    originalNames.add(p.text);
  }

  let body = node.body;
  if (!body) return null;

  if (ts.isBlock(body)) {
    // Collect `const actual = await importOriginal()` so the return's `...actual` is
    // recognised as the original rather than as unknown state.
    let returned = null;
    for (const stmt of body.statements) {
      if (ts.isVariableStatement(stmt)) {
        // A local that IS the original gets remembered, so the return's `...actual` is
        // recognised. Any other local — a `make()` key-proxy helper, a shared spy — is left
        // alone rather than refused: the whole factory is being deleted, so its locals go
        // with it and their role does not need to be knowable.
        for (const d of stmt.declarationList.declarations)
          if (ts.isIdentifier(d.name) && d.initializer && isOriginalCall(d.initializer, originalNames))
            originalNames.add(d.name.text);
        continue;
      }
      if (ts.isReturnStatement(stmt) && stmt.expression) {
        returned = stmt.expression;
        continue;
      }
      return null;
    }
    if (!returned) return null;
    body = returned;
  }

  while (ts.isParenthesizedExpression(body)) body = body.expression;
  if (!ts.isObjectLiteralExpression(body)) return null;
  body.__originalNames = originalNames;
  return body;
}

/** `await importOriginal()`, `importOriginal()`, `await vi.importActual('…')`. */
function isOriginalCall(node, originalNames) {
  let call = node;
  if (ts.isAwaitExpression(call)) call = call.expression;
  if (!ts.isCallExpression(call)) return false;
  if (ts.isIdentifier(call.expression)) return originalNames.has(call.expression.text);
  return (
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === 'vi' &&
    call.expression.name.text === 'importActual'
  );
}

function isOriginalSpread(prop, originalNames) {
  if (!ts.isSpreadAssignment(prop)) return false;
  let expr = prop.expression;
  while (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr)) expr = expr.expression;
  if (ts.isIdentifier(expr)) return originalNames.has(expr.text);
  return isOriginalCall(expr, originalNames);
}

/** Start of the statement including any comment lines directly above it, so deleting a
 * `vi.mock` takes its explanatory comment with it rather than orphaning it. */
function leadingStart(stmt, sf, text) {
  const ranges = ts.getLeadingCommentRanges(text, stmt.getFullStart()) ?? [];
  return ranges.length ? ranges[0].pos : stmt.getStart(sf);
}

// Called LAST, after every `const` table below is initialised — a call up top reads them
// in their temporal dead zone.
main();
