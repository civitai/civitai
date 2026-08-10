import path from 'path';
import { RuleTester } from 'eslint';
// The rule lives at the repo root (loaded in prod via eslint-plugin-local-rules).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const localRules = require(path.resolve(__dirname, '../../../../eslint-local-rules.js'));

const rule = localRules['no-io-in-transaction'];

// RuleTester drives its own describe/it via the test framework's globals, so
// `ruleTester.run(...)` must be called at the top level of the module (NOT
// nested inside a vitest `it()` — that throws "Calling the suite function
// inside test function is not allowed"). @typescript-eslint/parser is already
// a dev dependency used by .eslintrc.js.
// `parser` is a valid top-level RuleTester option in ESLint 8 (eslintrc mode),
// but @types/eslint's RuleTester config type lags and omits it — build the
// config untyped and cast so `tsc --noEmit` (CI) stays green without losing the
// runtime behavior.
const ruleTesterConfig: Record<string, unknown> = {
  parser: require.resolve('@typescript-eslint/parser'),
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
};
const ruleTester = new RuleTester(ruleTesterConfig as ConstructorParameters<typeof RuleTester>[0]);

ruleTester.run('no-io-in-transaction', rule, {
  valid: [
    // ---- Allowed: transaction-client-only / out-of-transaction I/O ----
    // Only tx.* / tx.$queryRaw inside the callback.
    `async function f(){ await db.$transaction(async (tx) => { await tx.user.update({}); await tx.$queryRaw\`x\`; }); }`,
    // I/O performed OUTSIDE / AFTER the transaction (the prescribed pattern).
    `async function f(){ const r = await db.$transaction(async (tx) => tx.user.findFirst()); await fetch('x'); }`,
    // Returned-then-used: capture ids in the txn, do I/O after commit.
    `async function f(){ const r = await db.$transaction(async (tx) => tx.user.create({})); await ingestImage(r); }`,
    // A denylisted NAME that is actually a method on the tx client must be allowed.
    `async function f(){ await db.$transaction(async (tx) => { await tx.thing.refresh(); }); }`,
    // The array/batch form of $transaction is not an interactive callback — ignore it.
    `async function f(){ await db.$transaction([fetch('a'), fetch('b')]); }`,
    // tx param renamed: tx-client calls under the alias are still allowed.
    `async function f(){ await db.$transaction(async (trx) => { await trx.user.update({}); }); }`,
    // Local var shadowing a denylisted name, never called -> no false positive.
    `async function f(){ await db.$transaction(async (tx) => { const refresh = async () => 1; await tx.user.update({}); }); }`,
    // Awaited .map whose body only touches tx.* -> allowed.
    `async function f(){ await db.$transaction(async (tx) => { await Promise.all(ids.map((i) => tx.user.update({ where: { id: i } }))); }); }`,
    // Non-awaited (fire-and-forget) I/O is out of scope: the rule only governs
    // awaited calls that consume the txn's wall-clock budget.
    `async function f(){ await db.$transaction(async (tx) => { fetch('x'); await tx.user.update({}); }); }`,

    // ---- Kysely: db.transaction().execute(cb) ----
    // Only trx.* query-builder calls inside the callback.
    `async function f(){ await db.transaction().execute(async (trx) => { await trx.updateTable('User').set({}).execute(); }); }`,
    // I/O performed AFTER the transaction resolves.
    `async function f(){ const r = await db.transaction().execute(async (trx) => trx.selectFrom('User').execute()); await fetch('x'); }`,
    // A denylisted NAME that is actually a method on the trx client must be allowed.
    `async function f(){ await db.transaction().execute(async (trx) => { await trx.thing.refresh(); }); }`,
    // NEGATIVE CONTROL for the Kysely matcher: `.execute(cb)` is only a transaction
    // when its receiver chain contains `.transaction()`. Without that, an unrelated
    // `execute`-named API taking a callback must NOT open a transaction context —
    // otherwise the matcher flags I/O in every such callback in the repo.
    `async function f(){ await queue.execute(async () => { await fetch('x'); }); }`,
    // Both matchers require an INLINE callback. Drop that check and these reach
    // `fn.params` with `fn === undefined` and crash the rule against whatever file
    // is being linted — a failure with no violation attached to it. RuleTester
    // reports a rule crash as a test failure, so these are what kill that mutation.
    `async function f(){ await db.transaction().execute(); }`,
    `async function f(){ await db.$transaction(); }`,

    // ---- REGRESSION GUARD (FALSE NEGATIVE, current behavior) ----
    // A non-inline (named) $transaction callback is NOT analyzed: the rule only
    // inspects inline arrow/function-expression callbacks, so I/O inside a named
    // reference is missed. Pinned VALID to reflect current behavior — flip to
    // `invalid` if/when the rule learns to resolve named callbacks.
    `async function cb(tx){ await fetch('x'); }\nasync function f(){ await db.$transaction(cb); }`,
  ],
  invalid: [
    // Bare fetch.
    {
      code: `async function f(){ await db.$transaction(async (tx) => { await fetch('x'); }); }`,
      errors: [{ messageId: 'ioInTx', data: { name: 'fetch' } }],
    },
    // logToAxiom().catch(...) — passthrough .catch must be unwrapped.
    {
      code: `async function f(){ await db.$transaction(async (tx) => { await logToAxiom({}).catch(() => {}); }); }`,
      errors: [{ messageId: 'ioInTx', data: { name: 'logToAxiom' } }],
    },
    // Image ingestion helper.
    {
      code: `async function f(){ await db.$transaction(async (tx) => { await ingestImage({}); }); }`,
      errors: [{ messageId: 'ioInTx', data: { name: 'ingestImage' } }],
    },
    // Cache .refresh() — the exact class of bug this PR moves out of the txn.
    {
      code: `async function f(){ await db.$transaction(async (tx) => { await userModelCountCache.refresh(1); }); }`,
      errors: [{ messageId: 'ioInTx', data: { name: 'refresh' } }],
    },
    // Buzz call awaited inside a nested .map within the txn (awardBountyEntry shape).
    {
      code: `async function f(){ await db.$transaction(async (tx) => { await Promise.allSettled(ids.map(async (i) => { await createBuzzTransaction(i); })); }); }`,
      errors: [{ messageId: 'ioInTx', data: { name: 'createBuzzTransaction' } }],
    },
    // Explicit { timeout } second arg must not defeat detection.
    {
      code: `async function f(){ await db.$transaction(async (tx) => { await fetch('x'); }, { timeout: 30000 }); }`,
      errors: [{ messageId: 'ioInTx', data: { name: 'fetch' } }],
    },
    // FunctionExpression (non-arrow) callback form.
    {
      code: `async function f(){ await db.$transaction(async function (tx) { await fetch('x'); }); }`,
      errors: [{ messageId: 'ioInTx', data: { name: 'fetch' } }],
    },
    // Nested $transaction: inner-callback I/O is still inside a transaction.
    {
      code: `async function f(){ await db.$transaction(async (tx) => { await db.$transaction(async (tx2) => { await fetch('x'); }); }); }`,
      errors: [{ messageId: 'ioInTx', data: { name: 'fetch' } }],
    },
    // search-index queueUpdate (report.service CSAM path shape).
    {
      code: `async function f(){ await db.$transaction(async (tx) => { await imagesSearchIndex.queueUpdate([]); }); }`,
      errors: [{ messageId: 'ioInTx', data: { name: 'queueUpdate' } }],
    },

    // ---- Kysely: db.transaction().execute(cb) ----
    // Bare fetch inside a Kysely interactive transaction.
    {
      code: `async function f(){ await db.transaction().execute(async (trx) => { await fetch('x'); }); }`,
      errors: [{ messageId: 'ioInTx', data: { name: 'fetch' } }],
    },
    // Builder chain between .transaction() and .execute() must not defeat detection.
    {
      code: `async function f(){ await db.transaction().setIsolationLevel('serializable').execute(async (trx) => { await logToAxiom({}); }); }`,
      errors: [{ messageId: 'ioInTx', data: { name: 'logToAxiom' } }],
    },
    // trx.* work is allowed; the search-index queue call beside it is not.
    {
      code: `async function f(){ await db.transaction().execute(async (trx) => { await trx.updateTable('Image').set({}).execute(); await imagesSearchIndex.queueUpdate([]); }); }`,
      errors: [{ messageId: 'ioInTx', data: { name: 'queueUpdate' } }],
    },
    // Nested Kysely transactions: inner-callback I/O is still inside a transaction.
    {
      code: `async function f(){ await kyselyWrite.transaction().execute(async (trx) => { await kyselyWrite.transaction().execute(async (trx2) => { await fetch('x'); }); }); }`,
      errors: [{ messageId: 'ioInTx', data: { name: 'fetch' } }],
    },
    // Mixed nesting, with the I/O in the OUTER (Kysely) callback so that only the
    // Kysely matcher can flag it. Putting the I/O inside the inner Prisma callback
    // instead would be VACUOUS — `$transaction` alone already establishes a context
    // there, so that fixture passes even with Kysely support removed (verified by
    // mutation; it is why this one is shaped this way).
    {
      code: `async function f(){ await kyselyWrite.transaction().execute(async (trx) => { await db.$transaction(async (tx) => { await tx.user.update({}); }); await fetch('x'); }); }`,
      errors: [{ messageId: 'ioInTx', data: { name: 'fetch' } }],
    },

    // ---- REGRESSION GUARD (FALSE POSITIVE, current behavior) ----
    // A deferred handler DEFINED (but not executed) inside the txn callback —
    // e.g. setTimeout / emitter.on — runs LATER, outside the txn budget, yet the
    // function-stack logic inherits the parent tx context and wrongly flags its
    // awaited I/O. Pinned INVALID to reflect the current over-flag — move this to
    // the `valid` array if/when the rule stops descending into non-executed
    // nested functions.
    {
      code: `async function f(){ await db.$transaction(async (tx) => { await tx.user.update({}); setTimeout(async () => { await fetch('x'); }, 0); }); }`,
      errors: [{ messageId: 'ioInTx', data: { name: 'fetch' } }],
    },
  ],
});
