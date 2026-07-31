/**
 * Local ESLint rules for civitai.
 *
 * Loaded via `eslint-plugin-local-rules` (referenced as the `local-rules`
 * plugin in .eslintrc.js). Add new rules to the exported object below.
 */

'use strict';

/**
 * no-io-in-transaction
 *
 * Flags awaited external / non-database I/O inside a Prisma interactive
 * transaction callback — `db.$transaction(async (tx) => { ... })`.
 *
 * Interactive transactions hold a DB connection open under a wall-clock
 * timeout (Prisma default 5000ms, or an explicit `{ timeout }`). An awaited
 * network call inside the callback (HTTP fetch, image scanner, Buzz API,
 * Axiom logging, Redis cache busts, search-index queueing, …) adds its latency
 * to that budget and, when slow, blows it: "Transaction already closed: a
 * commit cannot be executed on an expired transaction". A Postgres rollback
 * also can't undo external side effects, so the atomicity is usually illusory.
 *
 * Fix: do the external work AFTER the transaction commits (return the needed
 * ids from the callback, then act on them), or make pure-logging calls
 * fire-and-forget. See PRs #2375 / #2377 / #2379 for the established pattern.
 *
 * Detection is a curated denylist of known I/O call names (low false-positive,
 * extend as new I/O helpers appear). Calls on the transaction client itself
 * (`tx.*`, including `tx.$queryRaw` / `tx.$executeRaw`) are always allowed.
 * Intentional exceptions should use:
 *   // eslint-disable-next-line local-rules/no-io-in-transaction -- <reason>
 */
const IO_CALL_NAMES = new Set([
  // HTTP / generic
  'fetch',
  // image ingestion / scanner
  'ingestImage',
  'ingestImageBulk',
  'createImageIngestionRequest',
  // orchestrator
  'submitWorkflow',
  // Buzz / payments (external ledger via buzzApiFetch)
  'buzzApiFetch',
  'createBuzzTransaction',
  'createBuzzTransactionMany',
  'createMultiAccountBuzzTransaction',
  'refundTransaction',
  'refundMultiAccountTransaction',
  'getMultiAccountTransactionsByPrefix',
  'deleteBidsForModelVersion',
  // observability (Axiom HTTP ingest)
  'logToAxiom',
  // search index + redis cache (network)
  'queueUpdate',
  'updateDocs',
  'refresh', // *Cache.refresh(...) — Redis + cross-pool read
  'bust', // bustMvCache etc.
  'bustMvCache',
  'invalidateManyImageExistence',
  // email
  'sendEmail',
]);

// Promise-combinator wrappers whose argument we should unwrap to find the
// underlying call (e.g. `await foo().catch(() => null)` -> inspect `foo()`).
const PASSTHROUGH_MEMBERS = new Set(['catch', 'then', 'finally']);

/** Walk a member chain to its root object identifier name (e.g. tx.user.x -> "tx"). */
function rootObjectName(node) {
  let cur = node;
  while (cur && cur.type === 'MemberExpression') cur = cur.object;
  if (cur && cur.type === 'CallExpression') return rootObjectName(cur.callee);
  return cur && cur.type === 'Identifier' ? cur.name : null;
}

/** Given a CallExpression, return the called name (identifier or member property). */
function calleeName(callExpr) {
  const callee = callExpr.callee;
  if (!callee) return null;
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && callee.property) {
    return callee.property.type === 'Identifier' ? callee.property.name : null;
  }
  return null;
}

/**
 * Resolve the "effective" I/O call inside an awaited expression, unwrapping
 * `.catch()/.then()/.finally()` passthroughs. Returns { name, node } or null.
 */
function resolveIoCall(expr, txParamNames) {
  if (!expr || expr.type !== 'CallExpression') return null;
  const name = calleeName(expr);

  // Unwrap promise passthroughs: await foo().catch(...) -> inspect foo()
  if (
    name &&
    PASSTHROUGH_MEMBERS.has(name) &&
    expr.callee.type === 'MemberExpression' &&
    expr.callee.object
  ) {
    return resolveIoCall(expr.callee.object, txParamNames);
  }

  // Allow calls on the transaction client itself: tx.*(...), tx.$queryRaw`...`
  const root = rootObjectName(expr.callee);
  if (root && txParamNames.has(root)) return null;

  if (name && IO_CALL_NAMES.has(name)) return { name, node: expr };
  return null;
}

const noIoInTransaction = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow awaited external/network I/O inside a Prisma interactive $transaction callback (blows the txn timeout budget).',
      recommended: true,
    },
    schema: [],
    messages: {
      ioInTx:
        "Awaited '{{name}}(...)' performs external I/O inside a $transaction callback — it consumes the transaction's timeout budget. Do this after the transaction commits, or make it fire-and-forget. If intentional, add: // eslint-disable-next-line local-rules/no-io-in-transaction -- <reason>",
    },
  },
  create(context) {
    // Stack of active transaction-callback contexts. Each entry holds the set
    // of param names treated as the tx client (usually just {"tx"}).
    const txStack = [];
    // Function nodes that are transaction callbacks -> their tx param name set.
    const txCallbackFns = new WeakMap();

    function isTransactionCall(node) {
      return (
        node.type === 'CallExpression' &&
        node.callee.type === 'MemberExpression' &&
        node.callee.property &&
        node.callee.property.type === 'Identifier' &&
        node.callee.property.name === '$transaction' &&
        node.arguments.length > 0 &&
        (node.arguments[0].type === 'ArrowFunctionExpression' ||
          node.arguments[0].type === 'FunctionExpression')
      );
    }

    return {
      CallExpression(node) {
        if (!isTransactionCall(node)) return;
        const fn = node.arguments[0];
        const params = new Set();
        const first = fn.params && fn.params[0];
        if (first && first.type === 'Identifier') params.add(first.name);
        txCallbackFns.set(fn, params);
      },
      // Track entering/leaving any function so we know if we're lexically
      // inside a transaction callback (including nested arrows/maps).
      ':function'(node) {
        if (txCallbackFns.has(node)) txStack.push(txCallbackFns.get(node));
        else if (txStack.length) txStack.push(txStack[txStack.length - 1]);
      },
      ':function:exit'(node) {
        if (txStack.length) txStack.pop();
      },
      AwaitExpression(node) {
        if (txStack.length === 0) return;
        const txParamNames = txStack[txStack.length - 1];
        const io = resolveIoCall(node.argument, txParamNames);
        if (io) {
          context.report({ node: io.node, messageId: 'ioInTx', data: { name: io.name } });
        }
      },
    };
  },
};

/**
 * no-wholesale-module-mock
 *
 * Flags a `vi.mock('<module>', () => ({ ... }))` whose factory hand-writes a
 * replacement object instead of spreading the REAL module via `importOriginal`.
 *
 * Why this is a test-infrastructure hazard and not a style nit:
 *
 * A wholesale factory pins the module's export surface to whatever the author
 * happened to need on the day they wrote it. The moment the real module gains a
 * new export that some OTHER file in the test's module graph imports, that
 * import resolves to `undefined` and the ENTIRE test file fails to LOAD. A file
 * that fails to load produces no failing assertion — it collects **0 tests**.
 * Nothing goes red; the suite just quietly stops existing.
 *
 * That is exactly what happened to `~/utils/trpc`: adding `trpcVanilla` (and,
 * separately, `OffsiteReviewModalBody`) silently disabled five browser suites
 * and ~36 tests. It went undiagnosed partly because a cold Vite `optimizeDeps`
 * cache ALSO yields "0 tests collected" ("Vitest failed to find the runner"),
 * so the signature is ambiguous at runtime — which is the argument for catching
 * it statically, here, instead.
 *
 * TypeScript cannot catch this. On the string-path overload Vitest types the
 * factory's return as `Promisable<Partial<M>>` with `M = unknown`, so an
 * omitted export is not a type error — not even under Vitest 4's typed
 * `vi.mock(import('...'))` form. This rule is the only static gate available.
 *
 * The fix is to override narrowly and keep every other export real:
 *
 *   import type * as TrpcModule from '~/utils/trpc';
 *
 *   vi.mock('~/utils/trpc', async (importOriginal) => ({
 *     ...(await importOriginal<typeof TrpcModule>()),
 *     trpc: { ...only what this test overrides... },
 *   }));
 *
 * Canonical in-repo example (with the same warning in a comment):
 *   src/components/Challenge/__tests__/ChallengeUpsertForm.browser.test.tsx
 *
 * ---------------------------------------------------------------------------
 * How the check works, and why it is structural rather than textual
 * ---------------------------------------------------------------------------
 *
 * The question the rule answers is: "can I PROVE, from the AST, that everything
 * this factory returns carries the original module's exports forward?" It is
 * deliberately proof-based, so the failure mode is a false POSITIVE (a noisy
 * squiggle on an exotic-but-safe factory, fixable with a disable comment) and
 * never a false NEGATIVE (a silently-broken suite, which is the whole point).
 *
 * Two consequences worth stating, because both were real holes in the first cut
 * of this rule:
 *
 *  1. The `importOriginal` reference is matched as a BINDING, not as text. The
 *     factory's first parameter IS `importOriginal` whatever the author named
 *     it (`async (orig) => ...` is correct and must pass), and conversely the
 *     mere presence of the word — an unused parameter, a comment, a string —
 *     proves nothing. A textual `/\bimportOriginal\b/` over the factory source
 *     accepts `(importOriginal) => ({ ...localStub })` and rejects
 *     `(orig) => ({ ...(await orig()) })`: wrong in both directions.
 *
 *  2. "Returns something I can't read" is NOT a pass. `return {...} as any`,
 *     `return out`, `Object.assign({}, {...})`, `cached || {...}` and a factory
 *     with no `return` at all are all wholesale mocks wearing a hat. Anything
 *     the analysis cannot walk to an original-bearing spread is reported (as
 *     `unprovableMock`, with a message that says so) rather than assumed safe.
 *
 * What counts as "carries the original forward" (`isOriginalPreserving`):
 *   - `importOriginal(...)` where the callee resolves to the factory's own
 *     first parameter, or `vi.importActual('<the same module>')`;
 *   - an `await` of either;
 *   - a local `const` whose initialiser is one of those (the common
 *     `const actual = await importOriginal()` shape) — as long as the name is
 *     not redeclared or reassigned;
 *   - an object literal with a top-level spread of something original-bearing;
 *   - `Object.assign(...)` where any argument is original-bearing (every source
 *     argument's keys land on the result);
 *   - a conditional / logical / sequence expression where every branch that can
 *     be the value is itself original-bearing.
 * Everything else is not provable, and is reported.
 *
 * Notably NOT accepted: `await import('<the mocked module>')` inside its own
 * factory. Vitest intercepts that import and hands back the mock, so it is a
 * self-reference, not the original — `importOriginal`/`vi.importActual` exist
 * precisely because a plain dynamic import does not work here.
 *
 * `vi.mock('mod')` with no factory (automock) is untouched: it preserves the
 * real export shape by construction. So is `vi.mock('mod', { spy: true })`.
 *
 * Scoped by the `modules` option (default: just `~/utils/trpc`) rather than
 * applied to every mock in the repo — see the .eslintrc.js note. Extend the
 * list rather than broadening the rule. Specifiers are compared after
 * canonicalisation, so the `~/utils/trpc` target also matches a template
 * literal and an equivalent relative path (`../../utils/trpc`).
 *
 * Known gaps (deliberate, documented rather than papered over):
 *   - a factory passed as an identifier (`vi.mock(mod, factoryFn)`) is not
 *     analysed — the definition may be anywhere, and the shape is unused here.
 *     DO NOT reach for it to get past this rule: `const f = () => ({ trpc: {} });
 *     vi.mock('~/utils/trpc', f)` is silently accepted and, unlike a disable
 *     comment, leaves NOTHING for a reviewer or a later grep to find. If a
 *     factory genuinely has to be exempt, use the disable comment below — it is
 *     greppable and it carries your reason;
 *   - `modules` entries are matched per-module, not by glob;
 *   - only files ESLint already covers (`src/`, `packages/`) are seen at all.
 *
 * Known FALSE POSITIVES — safe shapes the analysis cannot walk, so they report
 * `unprovableMock`. None exist in the tree today; they are listed so an author
 * who hits one recognises their own shape and reaches for the disable comment
 * instead of reshaping working code (or switching the rule off):
 *   - destructure-and-rebuild: `const { trpc, ...rest } = await importOriginal();
 *     return { ...rest, trpc: {} }` — `rest` comes from a destructuring pattern,
 *     not an initialiser this rule tracks;
 *   - `const [actual] = await Promise.all([importOriginal()])` — same reason;
 *   - an aliased binding: `const f = importOriginal; return { ...(await f()) }`
 *     — only the parameter itself is recognised as the original call;
 *   - the `vi.hoisted` idiom, where the spread source is built outside the
 *     factory entirely.
 * Each is a one-line disable away, which is the intended cost: a false positive
 * costs a comment, a false negative costs a silently-empty test suite.
 *
 * Intentional exceptions should use:
 *   // eslint-disable-next-line local-rules/no-wholesale-module-mock -- <reason>
 */
const DEFAULT_WHOLESALE_MOCK_MODULES = ['~/utils/trpc'];

/** Is this `vi.mock(...)` / `vitest.mock(...)` / `.doMock(...)`? */
function isViMockCall(node) {
  const callee = node.callee;
  return (
    callee &&
    callee.type === 'MemberExpression' &&
    callee.object &&
    callee.object.type === 'Identifier' &&
    (callee.object.name === 'vi' || callee.object.name === 'vitest') &&
    callee.property &&
    callee.property.type === 'Identifier' &&
    (callee.property.name === 'mock' || callee.property.name === 'doMock')
  );
}

/** Is this `vi.importActual(...)` / `vitest.importActual(...)`? */
function isImportActualCallee(callee) {
  return (
    callee &&
    callee.type === 'MemberExpression' &&
    callee.object &&
    callee.object.type === 'Identifier' &&
    (callee.object.name === 'vi' || callee.object.name === 'vitest') &&
    callee.property &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'importActual'
  );
}

/**
 * Strip the wrappers that change an expression's TYPE but not its VALUE, so the
 * shape underneath can be inspected. `return { trpc: {} } as any` must be read
 * as the object literal it is — reaching for `as any` is the first thing an
 * author does when fighting a squiggle, which makes it the likeliest bypass.
 */
function unwrapExpression(node) {
  let current = node;
  while (
    current &&
    (current.type === 'TSAsExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'TSTypeAssertion' ||
      current.type === 'TSInstantiationExpression' ||
      current.type === 'ChainExpression')
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * Generic AST walk that does NOT descend into nested functions — so a
 * `return` belonging to an inner callback is never mistaken for the factory's
 * own return value, and an inner `const actual = ...` never leaks out.
 */
function walkSkippingFunctions(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;
    const value = node[key];
    const children = Array.isArray(value) ? value : [value];
    for (const child of children) {
      if (!child || typeof child.type !== 'string') continue;
      if (
        child.type === 'FunctionDeclaration' ||
        child.type === 'FunctionExpression' ||
        child.type === 'ArrowFunctionExpression'
      ) {
        continue;
      }
      walkSkippingFunctions(child, visit);
    }
  }
}

/** Read a static module specifier: a string literal or an expressionless template. */
function readModuleSpecifier(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (
    node.type === 'TemplateLiteral' &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  ) {
    return node.quasis[0].value.cooked;
  }
  return null;
}

/**
 * Reduce a module specifier to a comparable form so that the configured target
 * `~/utils/trpc` also matches `` `~/utils/trpc` `` and `../../utils/trpc`.
 *
 * `~/x` is this repo's tsconfig alias for `src/x`, so both are reduced to their
 * `src/`-relative path; a relative specifier is resolved against the linted
 * file first. Anything that does not reduce (a bare package name, a path that
 * resolves outside `src/`) is compared verbatim, which is the conservative
 * outcome: it simply will not match a `~/`-style target.
 *
 * The `src/` that `~` aliases is the ONE at the repo root — the directory
 * beside this file — not any `src/` anywhere in the path. A workspace package
 * has its own: from `packages/blocks-react/src/foo/x.test.tsx`, the specifier
 * `../utils/trpc` means `packages/blocks-react/src/utils/trpc`, a DIFFERENT
 * module from `~/utils/trpc`, and matching it would flag a file for mocking
 * something the rule was never pointed at. Resolving against `REPO_SRC` rather
 * than "the last `/src/` in the string" keeps the alias inside its own package
 * boundary.
 */
function stripModuleExtension(modulePath) {
  return modulePath.replace(/\.(?:m|c)?[jt]sx?$/, '').replace(/\/index$/, '');
}

function canonicalModulePath(specifier, fromFile) {
  if (typeof specifier !== 'string' || specifier.length === 0) return null;
  if (specifier.startsWith('~/')) return stripModuleExtension(specifier.slice(2));
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    if (!fromFile) return null;
    const posixFile = String(fromFile).split(pathSep).join('/');
    const resolved = posixNormalize(`${posixDirname(posixFile)}/${specifier}`);
    // Absolute (how ESLint actually invokes the rule): must land under the
    // repo's OWN src/, not a workspace package's.
    if (resolved.startsWith('/')) {
      return resolved.startsWith(`${REPO_SRC}/`)
        ? stripModuleExtension(resolved.slice(REPO_SRC.length + 1))
        : null;
    }
    // A repo-relative filename (RuleTester, or eslint invoked with relative
    // paths) is already rooted at the repo, so a leading `src/` is the alias
    // root and a leading `packages/` is not.
    if (resolved.startsWith('src/')) return stripModuleExtension(resolved.slice('src/'.length));
    return null;
  }
  return stripModuleExtension(specifier);
}

// Tiny posix path helpers — `eslint-local-rules.js` is loaded by ESLint in
// contexts where pulling in node:path is fine, but keeping these local makes
// the reduction above explicit and platform-independent.
const pathSep = require('path').sep;
// The repo root is this file's own directory (ESLint loads `eslint-local-rules`
// from it), so `<root>/src` is exactly what the `~` alias points at.
const REPO_SRC = require('path').resolve(__dirname, 'src').split(pathSep).join('/');
function posixDirname(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? '.' : p.slice(0, i) || '/';
}
function posixNormalize(p) {
  const out = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return `${p.startsWith('/') ? '/' : ''}${out.join('/')}`;
}

/**
 * Build the "does this expression carry the original module forward?" predicate
 * for one factory. Everything it needs is factory-local: the `importOriginal`
 * BINDING (the first parameter, whatever its name) and the factory's own
 * top-level `const` initialisers.
 */
function createOriginalAnalyzer(factory, targetCanonical, filename) {
  // The first parameter IS importOriginal, whatever it is named. A default
  // value (`async (importOriginal = x) => ...`) parses as an AssignmentPattern
  // wrapping the identifier, so unwrap that too — otherwise a correct factory
  // written with a default is reported. A destructured or rest parameter has no
  // single binding to call, and stays unrecognised.
  let firstParam = factory.params && factory.params[0];
  if (firstParam && firstParam.type === 'AssignmentPattern') firstParam = firstParam.left;
  const originalBinding = firstParam && firstParam.type === 'Identifier' ? firstParam.name : null;

  // Local `const actual = await importOriginal()` bindings. A name that is
  // declared twice or reassigned is poisoned: we can no longer say which value
  // reaches the spread, and "unsure" must mean "report".
  const locals = new Map();
  const poisoned = new Set();
  if (factory.body && factory.body.type === 'BlockStatement') {
    walkSkippingFunctions(factory.body, (n) => {
      if (n.type === 'VariableDeclarator' && n.id && n.id.type === 'Identifier') {
        if (locals.has(n.id.name)) poisoned.add(n.id.name);
        locals.set(n.id.name, n.init || null);
      } else if (n.type === 'AssignmentExpression' && n.left && n.left.type === 'Identifier') {
        poisoned.add(n.left.name);
      } else if (n.type === 'UpdateExpression' && n.argument && n.argument.type === 'Identifier') {
        // `actual++` / `--actual` rebinds the name to a number.
        poisoned.add(n.argument.name);
      } else if (n.type === 'UnaryExpression' && n.operator === 'delete') {
        // `delete actual.trpcVanilla` is the ONLY unary that mutates, and it is
        // precisely the historical bug: the spread still looks right, but an
        // export has been removed from the object being spread. Every other
        // unary on a bare identifier — `!actual`, `typeof actual`, `void actual`,
        // `-actual` — reads the value and cannot change it, so it must NOT
        // poison: `if (!actual) throw ...` is correct defensive code and used to
        // be reported.
        let target = n.argument;
        while (
          target &&
          (target.type === 'MemberExpression' || target.type === 'ChainExpression')
        ) {
          target = target.type === 'ChainExpression' ? target.expression : target.object;
        }
        if (target && target.type === 'Identifier') poisoned.add(target.name);
      }
    });
  }

  /** `importOriginal()` or `vi.importActual('<the module being mocked>')`. */
  function isOriginalCall(call) {
    if (call.type !== 'CallExpression') return false;
    const callee = call.callee;
    if (originalBinding && callee.type === 'Identifier' && callee.name === originalBinding) {
      return true;
    }
    if (isImportActualCallee(callee)) {
      // Must be the SAME module. `vi.importActual('~/utils/other')` spread into
      // a `~/utils/trpc` mock leaves every trpc export missing.
      const spec = readModuleSpecifier(call.arguments && call.arguments[0]);
      return canonicalModulePath(spec, filename) === targetCanonical;
    }
    return false;
  }

  const seen = new Set();

  function isOriginalPreserving(node) {
    const expr = unwrapExpression(node);
    if (!expr || typeof expr.type !== 'string') return false;
    // Cycle guard: `let a = a` and friends must terminate, not blow the stack.
    if (seen.has(expr)) return false;
    seen.add(expr);
    try {
      switch (expr.type) {
        case 'AwaitExpression':
          return isOriginalPreserving(expr.argument);

        case 'CallExpression': {
          if (isOriginalCall(expr)) return true;
          // `Object.assign(target, ...sources)` — every source's own enumerable
          // keys land on the result, so one original-bearing argument is enough.
          const callee = expr.callee;
          if (
            callee.type === 'MemberExpression' &&
            callee.object &&
            callee.object.type === 'Identifier' &&
            callee.object.name === 'Object' &&
            callee.property &&
            callee.property.type === 'Identifier' &&
            callee.property.name === 'assign'
          ) {
            // A `...sources` argument needs no special case: `SpreadElement`
            // is not an expression type this analysis accepts, so it falls
            // through to `false` on its own. (An explicit exclusion here was
            // redundant — no input could distinguish it.)
            return (expr.arguments || []).some((arg) => isOriginalPreserving(arg));
          }
          return false;
        }

        case 'ObjectExpression':
          return expr.properties.some(
            (p) => p.type === 'SpreadElement' && isOriginalPreserving(p.argument)
          );

        case 'Identifier': {
          if (poisoned.has(expr.name) || !locals.has(expr.name)) return false;
          const init = locals.get(expr.name);
          return init ? isOriginalPreserving(init) : false;
        }

        case 'ConditionalExpression':
          // Either branch can be the value, so BOTH must be safe.
          return isOriginalPreserving(expr.consequent) && isOriginalPreserving(expr.alternate);

        case 'LogicalExpression':
          return isOriginalPreserving(expr.left) && isOriginalPreserving(expr.right);

        case 'SequenceExpression':
          return isOriginalPreserving(expr.expressions[expr.expressions.length - 1]);

        default:
          // ImportExpression (`await import('~/utils/trpc')` returns the MOCK,
          // not the original), member access, `new`, template literals, ...
          return false;
      }
    } finally {
      seen.delete(expr);
    }
  }

  return isOriginalPreserving;
}

/**
 * Every expression the factory itself can return. `null` marks a bare `return;`
 * or a block with no reachable `return` at all — both hand Vitest `undefined`,
 * which is as wholesale as it gets.
 */
function collectFactoryReturns(factory) {
  if (!factory.body) return [null];
  if (factory.body.type !== 'BlockStatement') return [factory.body];

  const returns = [];
  walkSkippingFunctions(factory.body, (n) => {
    if (n.type === 'ReturnStatement') returns.push(n.argument || null);
  });
  return returns.length ? returns : [null];
}

const noWholesaleModuleMock = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require vi.mock factories for sensitive modules to spread the real module via importOriginal — a wholesale factory breaks the whole test FILE (0 tests collected) the day the module gains an export it omits.',
      recommended: true,
    },
    schema: [
      {
        type: 'object',
        properties: {
          modules: { type: 'array', items: { type: 'string' }, minItems: 1 },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      wholesaleMock:
        "Wholesale vi.mock('{{module}}') factory — it replaces the module with a hand-written object, so the day '{{module}}' gains an export this factory omits, every importer in this test's module graph gets `undefined` and the whole FILE fails to load: 0 tests collected, no failing assertion, silently 'green' (this disabled ~36 tests via `trpcVanilla`). TypeScript cannot catch it — the factory's return is typed `Partial<unknown>`. Spread the real module and override only what you need: add `import type * as Mod from '{{module}}';` then `vi.mock('{{module}}', async (importOriginal) => ({ ...(await importOriginal<typeof Mod>()), /* overrides */ }));` — use the type-only namespace import, NOT `typeof import('...')`, which @typescript-eslint/consistent-type-imports rejects. If this factory really is intentional and safe, silence it explicitly rather than reshaping it: `// eslint-disable-next-line local-rules/no-wholesale-module-mock -- <reason>`. Canonical example: src/components/Challenge/__tests__/ChallengeUpsertForm.browser.test.tsx",
      unprovableMock:
        "vi.mock('{{module}}') factory returns a value this rule cannot prove carries the real module's exports ({{shape}}). That is reported rather than assumed safe: if '{{module}}' gains an export the factory omits, the whole test FILE fails to load and collects 0 tests with nothing turning red. Return an object literal that spreads the original directly — `vi.mock('{{module}}', async (importOriginal) => ({ ...(await importOriginal<typeof Mod>()), /* overrides */ }))` (with `import type * as Mod from '{{module}}';`) — so the spread is visible statically. Note `... as any` / `satisfies` do not change this; the spread itself is what has to be there. If this factory really is safe, silence it explicitly: `// eslint-disable-next-line local-rules/no-wholesale-module-mock -- <reason>`. Canonical example: src/components/Challenge/__tests__/ChallengeUpsertForm.browser.test.tsx",
    },
  },
  create(context) {
    const options = context.options[0] || {};
    const filename = (context.filename || (context.getFilename && context.getFilename())) ?? null;
    const targets = new Set(
      (options.modules || DEFAULT_WHOLESALE_MOCK_MODULES)
        .map((m) => canonicalModulePath(m, filename))
        .filter(Boolean)
    );

    return {
      CallExpression(node) {
        if (!isViMockCall(node)) return;

        const [moduleArg, factory] = node.arguments;
        const specifier = readModuleSpecifier(moduleArg);
        const targetCanonical = canonicalModulePath(specifier, filename);
        if (!targetCanonical || !targets.has(targetCanonical)) return;

        // Only an inline function factory is analysable. Everything else here
        // is intentionally left alone:
        //   - `vi.mock('mod')` (automock) and `vi.mock('mod', { spy: true })`
        //     keep the real export shape by construction;
        //   - a factory passed by reference (`vi.mock('mod', makeFactory)`) is
        //     the documented gap above — its definition may be anywhere.
        if (!factory) return;
        if (factory.type !== 'ArrowFunctionExpression' && factory.type !== 'FunctionExpression') {
          return;
        }

        const isOriginalPreserving = createOriginalAnalyzer(factory, targetCanonical, filename);

        // Classify each un-provable return so the AUTHOR gets advice they can
        // act on. The split is "did you even try to spread?":
        //
        //   no top-level spread at all -> `wholesaleMock`, whose advice is
        //     "spread the real module" — exactly what is missing;
        //   a spread the analysis cannot walk to the original (`...localStub`,
        //     `...(actual ?? {})`, `...(await import('./elsewhere'))`), or any
        //     non-object return -> `unprovableMock`, which says the spread is
        //     unprovable and names the escape hatch.
        //
        // Telling an author who ALREADY spreads to "spread the real module" is
        // how a rule gets switched off, and at 'error' that advice blocks them.
        let wholesale = false;
        let unprovable = null;
        for (const returned of collectFactoryReturns(factory)) {
          if (returned && isOriginalPreserving(returned)) continue;
          const shape = returned ? unwrapExpression(returned) : null;
          if (shape && shape.type === 'ObjectExpression') {
            const spreads = shape.properties.filter((p) => p.type === 'SpreadElement');
            if (spreads.length === 0) {
              wholesale = true;
            } else if (!unprovable) {
              unprovable =
                'an object literal whose spread does not provably carry the original module';
            }
          } else if (!unprovable) {
            unprovable = shape ? shape.type : 'no return value';
          }
        }

        if (!wholesale && !unprovable) return;

        context.report({
          node,
          messageId: wholesale ? 'wholesaleMock' : 'unprovableMock',
          data: { module: specifier, shape: unprovable || 'ObjectExpression' },
        });
      },
    };
  },
};

/**
 * no-module-scope-cache
 *
 * Flags a `createCachedObject(...)` / `createCachedArray(...)` call that runs at
 * MODULE SCOPE — i.e. during module evaluation, as a side effect of anyone
 * merely importing the file.
 *
 * This is the OTHER end of the same failure that `no-wholesale-module-mock`
 * catches. That rule guards the mock; this one guards the trigger.
 *
 * A test suite that wholesale-mocks `~/server/utils/cache-helpers` or
 * `~/server/redis/client` replaces the entire module, so any export the factory
 * omits is simply absent. If a service builds its cache at module scope, then
 * every suite that mocks one of those modules and imports that service — even
 * TRANSITIVELY, three hops down an import chain it never mentions — fails
 * during COLLECTION, before a single test runs:
 *
 *   "No createCachedObject export is defined on the mock"   (cache-helpers)
 *   "Cannot read properties of undefined (reading 'PAID_ACCESS_CAP_TIER')"
 *                                                           (REDIS_KEYS.CACHES)
 *
 * Collection errors are reported one file at a time, so the causes peel off one
 * per fix, and the blast radius is not the file you edited — it is every suite
 * whose import graph happens to reach it. ~150 suites mock `redis/client` and
 * ~26 mock `cache-helpers` today, so this is a broad live tripwire, not a
 * hypothetical: adding one eager `capTierCache` to paid-access.service.ts
 * killed three model-service suites (57 tests) and turned `Unit tests` red on
 * `main` for every open PR (PRs #3505 / #3506).
 *
 * Fixing the ~150 mocks is the wrong end of the problem — each one is correct
 * for what it tests, and the list only grows. Building the cache lazily is a
 * three-line change that makes the whole class impossible.
 *
 * The fix — the house pattern, already documented in the file that broke:
 *
 *   function createCapTierCache() {
 *     return createCachedObject<CachedCapTier>({ key: ..., lookupFn: ... });
 *   }
 *   let capTierCacheInstance: ReturnType<typeof createCapTierCache> | undefined;
 *   function capTierCache() {
 *     return (capTierCacheInstance ??= createCapTierCache());
 *   }
 *
 * Call sites become `capTierCache().fetch(...)`. Nothing about runtime
 * behaviour changes — the cache is still a per-process singleton, it is just
 * built on first USE instead of on first IMPORT.
 *
 * Canonical in-repo example: `paidAccessCache` in
 * src/server/services/paid-access.service.ts, whose comment gives this exact
 * reasoning — the eager `capTierCache` was added directly beneath it.
 *
 * ---------------------------------------------------------------------------
 * Scope, and why it is narrow
 * ---------------------------------------------------------------------------
 *
 * Applied via an `overrides` entry in .eslintrc.js to `src/server/services/**`
 * and `src/server/redis/**` — the two places module-scope caches actually live.
 *
 * There are 29 of them today. 7 are reported; the 22 in
 * `src/server/redis/caches.ts` are silenced by a documented file-level disable
 * in that file. Do NOT read that disable as "caches.ts is safe" — it is the
 * hotter tripwire, not the exempt one: all 22 are keyed off `REDIS_KEYS` at
 * module scope, and the module is imported far more widely than
 * paid-access.service.ts was. The three suites #3505 repaired stay green only
 * because they ALSO mock `~/server/redis/caches`; the next suite that mocks
 * `~/server/redis/client` without `CACHES` and reaches caches.ts unmocked dies
 * the same way, and making one service's cache lazy does not prevent that.
 *
 * The disable is a blast-radius decision, written down where the next author
 * will read it: converting 22 call sites in the busiest cache module wants to be
 * its own reviewable change. What the rule buys meanwhile is that the backlog
 * stops GROWING — a new eager cache in a service creates a brand-new transitive
 * tripwire on a module no suite knows to mock, which is exactly how one
 * `capTierCache` took out three unrelated suites.
 *
 * "Module scope" is decided structurally, by walking to the nearest enclosing
 * function. A call inside a function is deferred and therefore fine — EXCEPT
 * when that function is immediately invoked (`(() => createCachedObject())()`),
 * which runs at module scope after all and is handled.
 *
 * Known gaps (deliberate):
 *   - eager invocation through a callback the rule cannot classify:
 *     `TYPES.map(() => createCachedObject(...))` at module scope is eager, but
 *     the arrow makes it look deferred. Detecting this needs to know which
 *     callees run their argument synchronously;
 *   - the callee is matched by NAME, not resolved to its import. A local helper
 *     that happens to be called `createCachedObject` is reported (one disable
 *     comment), and a cache built through an aliased import is not;
 *   - a cache built at module scope by a helper the rule can't see through
 *     (`const c = makeCache()` where makeCache calls createCachedObject) is not
 *     reported. The hazard is real there too, but the shape is not in the tree.
 *
 * Intentional exceptions should use:
 *   // eslint-disable-next-line local-rules/no-module-scope-cache -- <reason>
 */
const DEFAULT_CACHE_CREATORS = ['createCachedObject', 'createCachedArray'];

/** `(() => ...)()` / `(function () { ... })()` — the function runs where it sits. */
function isImmediatelyInvoked(fn) {
  const parent = fn.parent;
  return !!parent && parent.type === 'CallExpression' && parent.callee === fn;
}

/**
 * Does this node evaluate during module evaluation?
 *
 * Walk to the Program. Any enclosing function DEFERS the call (its body runs
 * when it is called, not when the module loads) — unless the function is itself
 * immediately invoked, in which case we keep walking from the invocation. A
 * non-static class property initialiser runs per instantiation, so it defers
 * too; a static one does not.
 */
function isEvaluatedAtModuleScope(node) {
  let current = node;
  let parent = current.parent;

  while (parent) {
    if (
      parent.type === 'FunctionDeclaration' ||
      parent.type === 'FunctionExpression' ||
      parent.type === 'ArrowFunctionExpression'
    ) {
      if (!isImmediatelyInvoked(parent)) return false;
      // An IIFE: resume the walk from the call that invokes it.
      current = parent.parent;
      parent = current.parent;
      continue;
    }

    if (parent.type === 'PropertyDefinition' && parent.value === current && !parent.static) {
      return false;
    }

    current = parent;
    parent = current.parent;
  }

  return current.type === 'Program';
}

const noModuleScopeCache = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require createCachedObject/createCachedArray in services to be built lazily — a module-scope call breaks test COLLECTION for every suite that wholesale-mocks cache-helpers or redis/client and transitively imports the service.',
      recommended: true,
    },
    schema: [
      {
        type: 'object',
        properties: {
          creators: { type: 'array', items: { type: 'string' }, minItems: 1 },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      moduleScopeCache:
        '`{{creator}}(...)` at MODULE SCOPE — it runs when this file is IMPORTED, not when the cache is used. ~150 suites wholesale-mock `~/server/redis/client` and ~26 mock `~/server/utils/cache-helpers`; every one of them that reaches this service transitively then fails at COLLECTION, before any test runs, with "No {{creator}} export is defined on the mock" or "Cannot read properties of undefined (reading \'<KEY>\')". Nothing in the failing suite mentions this file. Build it lazily instead: `function createX() { return {{creator}}({ ... }); }` plus `let xInstance: ReturnType<typeof createX> | undefined; function x() { return (xInstance ??= createX()); }`, and call `x().fetch(...)`. Runtime behaviour is unchanged — still one instance per process, built on first USE instead of first IMPORT. Canonical example: `paidAccessCache` in src/server/services/paid-access.service.ts. If this one really must be eager, silence it explicitly: `// eslint-disable-next-line local-rules/no-module-scope-cache -- <reason>`',
    },
  },
  create(context) {
    const options = context.options[0] || {};
    const creators = new Set(options.creators || DEFAULT_CACHE_CREATORS);

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (!callee || callee.type !== 'Identifier' || !creators.has(callee.name)) return;
        if (!isEvaluatedAtModuleScope(node)) return;

        context.report({
          node,
          messageId: 'moduleScopeCache',
          data: { creator: callee.name },
        });
      },
    };
  },
};

module.exports = {
  'no-io-in-transaction': noIoInTransaction,
  'no-module-scope-cache': noModuleScopeCache,
  'no-wholesale-module-mock': noWholesaleModuleMock,
};
