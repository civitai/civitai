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
 * The fix is to override narrowly and keep every other export real:
 *
 *   vi.mock('~/utils/trpc', async (importOriginal) => ({
 *     ...(await importOriginal<typeof import('~/utils/trpc')>()),
 *     trpc: { ...only what this test overrides... },
 *   }));
 *
 * Canonical in-repo example (with the same warning in a comment):
 *   src/components/Challenge/__tests__/ChallengeUpsertForm.browser.test.tsx
 *
 * A factory is accepted when the object it returns has a top-level spread AND
 * the factory actually references `importOriginal`/`importActual` — a spread of
 * some local stub object is not a fix. `vi.mock('mod')` with no factory
 * (automock) is untouched: it preserves the real export shape by construction.
 *
 * Scoped by the `modules` option (default: just `~/utils/trpc`) rather than
 * applied to every mock in the repo — see the .eslintrc.js note. Extend the
 * list rather than broadening the rule.
 *
 * Intentional exceptions should use:
 *   // eslint-disable-next-line local-rules/no-wholesale-module-mock -- <reason>
 */
const DEFAULT_WHOLESALE_MOCK_MODULES = ['~/utils/trpc'];

/** Is this `vi.mock(...)` / `vitest.mock(...)`? */
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

/**
 * Generic AST walk that does NOT descend into nested functions — so a
 * `return` belonging to an inner callback is never mistaken for the factory's
 * own return value.
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

/** Does this ObjectExpression have a top-level `...spread`? */
function hasTopLevelSpread(objectExpression) {
  return (
    objectExpression.type === 'ObjectExpression' &&
    objectExpression.properties.some((p) => p.type === 'SpreadElement')
  );
}

const noWholesaleModuleMock = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "Require vi.mock factories for sensitive modules to spread the real module via importOriginal — a wholesale factory breaks the whole test FILE (0 tests collected) the day the module gains an export it omits.",
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
        "Wholesale vi.mock('{{module}}') factory — it replaces the module with a hand-written object, so the day '{{module}}' gains an export this factory omits, every importer in this test's module graph gets `undefined` and the whole FILE fails to load: 0 tests collected, no failing assertion, silently 'green' (this disabled ~36 tests via `trpcVanilla`). Spread the real module and override only what you need: add `import type * as Mod from '{{module}}';` then `vi.mock('{{module}}', async (importOriginal) => ({ ...(await importOriginal<typeof Mod>()), /* overrides */ }));` — use the type-only namespace import, NOT `typeof import('...')`, which @typescript-eslint/consistent-type-imports rejects. Canonical example: src/components/Challenge/__tests__/ChallengeUpsertForm.browser.test.tsx",
    },
  },
  create(context) {
    const options = context.options[0] || {};
    const targets = new Set(options.modules || DEFAULT_WHOLESALE_MOCK_MODULES);
    const sourceCode = context.sourceCode || context.getSourceCode();

    return {
      CallExpression(node) {
        if (!isViMockCall(node)) return;

        const [moduleArg, factory] = node.arguments;
        if (!moduleArg || moduleArg.type !== 'Literal' || !targets.has(moduleArg.value)) return;
        // `vi.mock('mod')` (automock) keeps the real export shape — nothing to do.
        if (
          !factory ||
          (factory.type !== 'ArrowFunctionExpression' && factory.type !== 'FunctionExpression')
        ) {
          return;
        }

        // The factory must actually reach for the original module. A spread of
        // a locally-built object is not a fix, so check this over the factory
        // subtree only (a sibling mock's `importActual` must not count).
        const factoryText = sourceCode.getText(factory);
        const usesOriginal =
          /\bimportOriginal\b/.test(factoryText) || /\bimportActual\b/.test(factoryText);

        // Collect the object literal(s) the factory itself returns.
        const returnedObjects = [];
        if (factory.body.type === 'ObjectExpression') {
          returnedObjects.push(factory.body); // concise arrow: () => ({ ... })
        } else if (factory.body.type !== 'BlockStatement') {
          // Concise body that isn't an object literal, e.g. `() => makeMock()`
          // (wholesale, still caught below via `usesOriginal`) or
          // `async (importOriginal) => importOriginal()` (a full passthrough).
        } else {
          walkSkippingFunctions(factory.body, (n) => {
            if (n.type === 'ReturnStatement' && n.argument) returnedObjects.push(n.argument);
          });
        }

        // Safe iff the factory reaches for the original AND every object
        // literal it returns spreads at the top level. When it returns no
        // object literal at all there is nothing to inspect, so `importOriginal`
        // usage alone is the signal (e.g. a straight passthrough).
        const objectLiterals = returnedObjects.filter((n) => n.type === 'ObjectExpression');
        const spreadsOriginal =
          usesOriginal && (objectLiterals.length === 0 || objectLiterals.every(hasTopLevelSpread));

        if (spreadsOriginal) return;

        context.report({
          node,
          messageId: 'wholesaleMock',
          data: { module: String(moduleArg.value) },
        });
      },
    };
  },
};

module.exports = {
  'no-io-in-transaction': noIoInTransaction,
  'no-wholesale-module-mock': noWholesaleModuleMock,
};
