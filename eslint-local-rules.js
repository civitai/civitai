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

module.exports = {
  'no-io-in-transaction': noIoInTransaction,
};
