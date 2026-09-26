import { describe, expect, it } from 'vitest';

/**
 * Coverage for the `TransactionType` ⇄ ClickHouse `type` column conversion.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * The ingest MV's int→string map enumerates only `0..26` and falls back to
 * `toString(Type)`, so every member above 26 is stored as its DIGITS rather than
 * its camelCase name. `LicenseFee` (27) has been in that state since 2026-05-21;
 * `AppAuthorFee` (28) joins it.
 *
 * The read side was open-coded at both hydrator call sites as
 * `TransactionType[capitalise(row.type)]`, which is WRONG for a numeric string in
 * a way no type error can catch: capitalising `'28'` is a no-op, and
 * `TransactionType['28']` hits the enum's REVERSE mapping, so it returns the
 * NAME as a string where a `TransactionType` number is declared. The value then
 * renders as the raw `28` in the user's transaction list and in the CSV export
 * instead of a label. `buzz.schema.ts` already carried this rule for the
 * buzz-service API read path; neither ClickHouse site had it.
 *
 * 🔴 NOT A PURE REGRESSION SUITE, AND THE BASE RED IS DEGENERATE. These symbols
 * do not exist at the base commit, so running this file there produces
 * `is not a function`, not a failed assertion — which is evidence about the
 * import, not about behaviour. What demonstrates the defect in-tree is dropping
 * the numeric arm from the helper and watching the numeric case redden on its own
 * assertion. The name arm and the round-trips are invariant guards over behaviour
 * the base already had, and are labelled as such.
 *
 * 🔴 AND A GREEN RUN HERE IS NOT A CLAIM THAT PRODUCTION USES ANY OF THIS. Every
 * test below calls the helpers directly; a round-2 audit reverted both production
 * call sites to the expression they replaced and this whole file stayed green. The
 * wiring is pinned in `buzz-transactions-clickhouse-seam.test.ts` instead, which
 * drives the real exported reader. Do not read coverage here as coverage there.
 */

import {
  clickhouseTransactionTypeExclusion,
  clickhouseTransactionTypePredicate,
  fromClickhouseTransactionType,
  toClickhouseTransactionType,
} from '~/server/services/buzz.service';
import { TransactionType } from '~/shared/constants/buzz.constants';

describe('toClickhouseTransactionType', () => {
  // INVARIANT GUARD — unchanged behaviour, pinned because the round-trip below
  // is only meaningful if this half is what the column actually holds.
  it('lower-camels the member name', () => {
    expect(toClickhouseTransactionType(TransactionType.Fee)).toBe('fee');
    expect(toClickhouseTransactionType(TransactionType.LicenseFee)).toBe('licenseFee');
    expect(toClickhouseTransactionType(TransactionType.AppAuthorFee)).toBe('appAuthorFee');
  });
});

describe('fromClickhouseTransactionType', () => {
  it('resolves a camelCase name to its member', () => {
    expect(fromClickhouseTransactionType('fee')).toBe(TransactionType.Fee);
    expect(fromClickhouseTransactionType('tip')).toBe(TransactionType.Tip);
    expect(fromClickhouseTransactionType('compensation')).toBe(TransactionType.Compensation);
  });

  /**
   * 🔴 THE ARM THAT CARRIES THE DEFECT. The open-coded expression this replaced
   * returned the string `'LicenseFee'` / `'AppAuthorFee'` out of the enum's
   * reverse mapping where a number was declared. `toBe` is `Object.is`, so it
   * separates the two on its own — which is why there is one assertion here and
   * not four: a `typeof` check and a `not.toBe` against the name were both
   * subsumed by this line and could never report.
   *
   * ⚠️ A re-derivation through the enum (`TransactionType[resolved]`) is subsumed
   * HERE but is not dead everywhere: a duplicate enum value flips the reverse map,
   * and that is the one mutation it catches. The seam suite keeps one for that
   * reason — do not delete it there on the strength of this paragraph.
   */
  it('resolves a member stored as its NUMBER — the 0..26 ingest gap', () => {
    for (const [raw, member] of [
      ['27', TransactionType.LicenseFee],
      ['28', TransactionType.AppAuthorFee],
    ] as const)
      expect(fromClickhouseTransactionType(raw)).toBe(member);
  });

  it('round-trips every member through the name form', () => {
    const members = Object.values(TransactionType).filter(
      (v): v is TransactionType => typeof v === 'number'
    );
    // A positive control on the loop itself: a silent zero here would make the
    // assertion inside it unreachable and the test green for no reason.
    expect(members.length).toBeGreaterThanOrEqual(29);
    for (const member of members)
      expect(fromClickhouseTransactionType(toClickhouseTransactionType(member))).toBe(member);
  });

  it('round-trips every member through the NUMBER form', () => {
    const members = Object.values(TransactionType).filter(
      (v): v is TransactionType => typeof v === 'number'
    );
    expect(members.length).toBeGreaterThanOrEqual(29);
    for (const member of members)
      expect(fromClickhouseTransactionType(String(member))).toBe(member);
  });

  /**
   * INVARIANT GUARD. The `Tip` fallback is long-standing and deliberate — it
   * predates this change and exists so an unrecognised value renders a label
   * rather than blank. Pinned in both arms because the numeric arm is new code
   * and dropping the fallback there would be silent.
   */
  it('falls back to Tip for a value that names no member, in either arm', () => {
    expect(fromClickhouseTransactionType('notAType')).toBe(TransactionType.Tip);
    expect(fromClickhouseTransactionType('999')).toBe(TransactionType.Tip);
  });

  /**
   * 🔴 A PROTOTYPE KEY IS NOT AN ABSENT KEY, and the two cases above cannot tell
   * the difference: `TransactionType['NotAType']` really is `undefined`, so `??`
   * fires and they pass under the unguarded expression too. `'__proto__'` resolves
   * up the chain to a non-nullish OBJECT, which `??` accepts — so without this
   * line the `Object.hasOwn` guard is untestable and reverting it is invisible.
   */
  it('does not resolve a prototype key to an object', () => {
    const resolved = fromClickhouseTransactionType('__proto__');
    expect(resolved).toBe(TransactionType.Tip);
    expect(typeof resolved).toBe('number');
    expect(fromClickhouseTransactionType('constructor')).toBe(TransactionType.Tip);
  });
});

describe('clickhouseTransactionTypePredicate', () => {
  /**
   * 🔴 THE REGRESSION ARM for the filter. A name-only predicate is a silent zero
   * for a member past the ingest map — the export answers 200 with a header-only
   * body, which is indistinguishable from "this user earned nothing".
   */
  it('matches the NUMBER as well as the name, so a past-26 member is not a silent zero', () => {
    expect(clickhouseTransactionTypePredicate(TransactionType.AppAuthorFee)).toBe(
      "type IN ('appAuthorFee','28')"
    );
    expect(clickhouseTransactionTypePredicate(TransactionType.LicenseFee)).toBe(
      "type IN ('licenseFee','27')"
    );
  });

  /**
   * The numeric arm is carried for EVERY member, not only the past-26 ones — the
   * builder does not branch, which is what keeps it one rule. That it admits
   * nothing extra for an enumerated member is a premise about what the ingest MV
   * writes, and this test does not establish it; `Number(type)` being a real
   * member integer is what bounds the widening.
   */
  it('carries the numeric arm for an enumerated member too', () => {
    expect(clickhouseTransactionTypePredicate(TransactionType.Fee)).toBe("type IN ('fee','25')");
    expect(clickhouseTransactionTypePredicate(TransactionType.Tip)).toBe("type IN ('tip','0')");
  });
});

describe('clickhouseTransactionTypeExclusion', () => {
  /**
   * 🔴 BOTH BUILDERS RETURN A WHOLE PREDICATE, NOT A VALUE LIST. Pinned because
   * getting that wrong produced `type NOT IN (type NOT IN ('bank',…))` — a SQL
   * syntax error on the gained/spent chart — while every other test in this file
   * stayed green, since none of them looked at the returned string's shape. The
   * assertion is the full normalised output for exactly that reason.
   */
  it('emits a complete NOT IN predicate carrying both spellings per member', () => {
    expect(
      clickhouseTransactionTypeExclusion([TransactionType.Bank, TransactionType.Extract])
    ).toBe("type NOT IN ('bank','23','extract','24')");
  });

  // `NOT IN ()` is a syntax error, so an empty list must excuse itself rather
  // than emit one and take the whole query down.
  it('excludes nothing, rather than breaking the query, for an empty list', () => {
    expect(clickhouseTransactionTypeExclusion([])).toBe('1 = 1');
  });
});
