import { TransactionType } from '~/shared/constants/buzz.constants';

// The buzz service caps at 200 transactions per call and takes a single account
// type, so a multi-account view or an export would need hundreds of sequential
// round-trips. ClickHouse answers the same question in one query.
export function toClickhouseTransactionType(type: TransactionType) {
  const name = TransactionType[type];
  return name.charAt(0).toLowerCase() + name.slice(1);
}

/**
 * The inverse, and it MUST also accept a member the ingest MV has no name for.
 *
 * 🔴 The MV writes a member missing from its int→string map as `unknown_<n>`, not
 * by name: prod holds `AppAuthorFee` (28) only as `'unknown_28'`. Without this arm
 * those rows fall through to the `Tip` fallback in the transaction list and the
 * CSV export. A bare `'<n>'` is accepted too, as `buzz.schema.ts` does for the
 * buzz-service API read path.
 */
export function fromClickhouseTransactionType(raw: string): TransactionType {
  const digits = /^(?:unknown_)?(\d+)$/.exec(raw)?.[1];
  if (digits !== undefined) {
    const numeric = Number(digits);
    // A reverse-mapped name proves it is a real member; anything else keeps the
    // long-standing Tip fallback rather than rendering blank.
    return TransactionType[numeric] != null ? numeric : TransactionType.Tip;
  }
  const name = (raw.charAt(0).toUpperCase() + raw.slice(1)) as keyof typeof TransactionType;
  // 🔴 A `typeof` test, not `??`. `TransactionType['__proto__']` resolves up the
  // prototype chain to a non-nullish OBJECT, which `??` accepts — so the obvious
  // `TransactionType[name] ?? Tip` returns `Object.prototype` typed as a
  // `TransactionType`.
  //
  // Narrowing on the RESULT rejects that, and no input STRING can defeat it: every
  // `Object.prototype` key that survives the capitalisation above starts with `_`
  // and holds a function or an accessor. What it does NOT cover — stated because an
  // earlier revision of this comment claimed nothing could — is a numeric-valued
  // own property added to `Object.prototype` by something else in the process.
  // That is prototype pollution, out of scope for this function rather than
  // impossible; an `Object.hasOwn` check here would catch it and was removed as
  // untestable by any reachable input.
  const resolved: unknown = TransactionType[name];
  return typeof resolved === 'number' ? resolved : TransactionType.Tip;
}

/**
 * 🔴 EVERY SPELLING the column can hold for one member. A name-only `type = '…'`
 * predicate is a SILENT ZERO for a member the MV writes as `unknown_<n>`: the
 * transaction list renders empty and the CSV export answers 200 with a
 * header-only body.
 *
 * The non-name arms admitting nothing extra is a premise about what the MV writes,
 * NOT something any test here establishes: `Number(type)` is always a real member
 * integer (both entry points gate `type` through `z.enum(TransactionType)`), so
 * they can only ever match rows of that same type.
 */
function clickhouseTransactionTypeSpellings(type: TransactionType) {
  const numeric = Number(type);
  return [toClickhouseTransactionType(type), String(numeric), `unknown_${numeric}`];
}

export function clickhouseTransactionTypePredicate(type: TransactionType) {
  const spellings = clickhouseTransactionTypeSpellings(type);
  return `type IN (${spellings.map((s) => `'${s}'`).join(',')})`;
}

/**
 * The exclusion form of the same rule. Inert today, since every excluded member
 * is stored by name, but it keeps an exclusion list correct the day it gains a
 * member the MV cannot name.
 */
export function clickhouseTransactionTypeExclusionPredicate(types: TransactionType[]) {
  // `NOT IN ()` is a syntax error, not an empty exclusion. Today's only caller
  // passes a non-empty constant, but this is exported, and a caller that filtered
  // its list down to nothing would take out the whole query rather than excluding
  // nothing.
  if (!types.length) return '1 = 1';
  const spellings = types.flatMap(clickhouseTransactionTypeSpellings);
  return `type NOT IN (${spellings.map((s) => `'${s}'`).join(',')})`;
}
