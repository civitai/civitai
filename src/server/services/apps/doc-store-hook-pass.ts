// The proof that a write to a collection with a permission hook went through the hook.
//
// The document store refuses every viewer write to a collection whose declaration has a `hook`
// unless the caller hands it a HookPass for exactly that write: the same app, namespace,
// collection, key and operation (`requireHookPass` in `doc-store.ts`). The store also writes
// under the document version the pass carries, so a change that lands between the hook's read
// and the write is a `version_conflict`, never a write the hook did not see.
//
// A pass is only ever minted by `doc-store-hook.ts`, after the hook allowed the write (or, for a
// delete or a tally on a document that does not exist, after it found nothing for the hook to
// decide). That is pinned by a ledger test on the importers of `mintHookPass`. Passes are held in
// a module-private WeakSet, so an object literal of the same shape is not a pass, and each pass is
// spent by the first store write that accepts it.
//
// Pure: no I/O, so the store can import it without pulling in the hook client.

export type HookOp = 'create' | 'put' | 'delete' | 'increment' | 'mark' | 'unmark';

/** What one pass allows: one operation on one key, at one document version. */
export type HookPassScope = {
  appId: string;
  ns: string;
  collection: string;
  key: string;
  op: HookOp;
  /** The version the hook was shown (0: no document). The store writes only at this version. */
  version: number;
};

export type HookPass = Readonly<HookPassScope> & { readonly __hookPass: true };

const issued = new WeakSet<object>();

/** Mint a pass. Called only by `doc-store-hook.ts` (pinned by `doc-store-hook.ledger.test.ts`). */
export function mintHookPass(scope: HookPassScope): HookPass {
  const pass = Object.freeze({ ...scope, __hookPass: true as const });
  issued.add(pass);
  return pass;
}

/**
 * Spend `pass` for one write, returning the version the write must be pinned to. Throws (a
 * programming error, not a refusal about the caller) when `pass` is not a live pass for exactly
 * this write.
 */
export function spendHookPass(pass: unknown, write: Omit<HookPassScope, 'version'>): number {
  if (typeof pass !== 'object' || pass === null || !issued.has(pass)) {
    throw new Error(
      `doc-store: ${write.op} on ${write.collection} has a permission hook and needs a HookPass`
    );
  }
  const p = pass as HookPass;
  if (
    p.appId !== write.appId ||
    p.ns !== write.ns ||
    p.collection !== write.collection ||
    p.key !== write.key ||
    p.op !== write.op
  ) {
    throw new Error(`doc-store: the HookPass does not cover this ${write.op}`);
  }
  issued.delete(pass);
  return p.version;
}
