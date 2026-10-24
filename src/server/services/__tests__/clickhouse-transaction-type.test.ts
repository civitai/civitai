import { describe, expect, it } from 'vitest';

/**
 * Coverage for the `TransactionType` ⇄ ClickHouse `type` column conversion.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * The ingest MV stores a member it has no name for as `unknown_<n>` — prod holds
 * `AppAuthorFee` (28) only as `'unknown_28'` — so the column is not always the
 * camelCase name. The helpers also accept a bare `'<n>'`, the spelling this file
 * was first written against. A read-only all-time scan of `buzzTransactions` on
 * 2026-10-07 found no bare-digit row, but the arm is kept so a reader never
 * silently mislabels one.
 *
 * Capitalising a non-name and indexing the enum is WRONG in a way no type error
 * can catch: `TransactionType['28']` hits the enum's REVERSE mapping and returns
 * the NAME as a string where a number is declared, and `'Unknown_28'` misses and
 * falls back to `Tip`. Either way the transaction list and the CSV export show
 * the wrong label.
 *
 * 🔴 A GREEN RUN HERE IS NOT A CLAIM THAT PRODUCTION USES ANY OF THIS. Every
 * test below calls the helpers directly; a round-2 audit reverted both production
 * call sites to the expression they replaced and this whole file stayed green. The
 * wiring is pinned in `buzz-transactions-clickhouse-seam.test.ts` instead, which
 * drives the real exported reader. Do not read coverage here as coverage there.
 */

import {
  clickhouseTransactionTypeExclusionPredicate,
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
   * Capitalise-and-index returns the string `'LicenseFee'` / `'AppAuthorFee'` out
   * of the enum's reverse mapping here. `toBe` is `Object.is`, so it separates
   * that from the number on its own; a `typeof` check would add nothing.
   *
   * ⚠️ A re-derivation through the enum (`TransactionType[resolved]`) is subsumed
   * HERE but is not dead everywhere: a duplicate enum value flips the reverse map,
   * and that is the one mutation it catches. The seam suite keeps one for that
   * reason — do not delete it there on the strength of this paragraph.
   */
  it('resolves a member stored as its NUMBER', () => {
    for (const [raw, member] of [
      ['27', TransactionType.LicenseFee],
      ['28', TransactionType.AppAuthorFee],
    ] as const)
      expect(fromClickhouseTransactionType(raw)).toBe(member);
  });

  // 🔴 THE SPELLING PROD ACTUALLY STORES. Before this arm `'unknown_28'` resolved
  // to Tip, so every App Blocks author fee was listed and exported as a tip.
  it('resolves a member stored as unknown_<n>', () => {
    expect(fromClickhouseTransactionType('unknown_28')).toBe(TransactionType.AppAuthorFee);
    expect(fromClickhouseTransactionType('unknown_27')).toBe(TransactionType.LicenseFee);
  });

  it('round-trips every member through the unknown_<n> form', () => {
    const members = Object.values(TransactionType).filter(
      (v): v is TransactionType => typeof v === 'number'
    );
    expect(members.length).toBeGreaterThanOrEqual(29);
    for (const member of members)
      expect(fromClickhouseTransactionType(`unknown_${member}`)).toBe(member);
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
   * rather than blank. Pinned in every arm because dropping it from the numeric
   * one would be silent.
   */
  it('falls back to Tip for a value that names no member, in every arm', () => {
    expect(fromClickhouseTransactionType('notAType')).toBe(TransactionType.Tip);
    expect(fromClickhouseTransactionType('999')).toBe(TransactionType.Tip);
    expect(fromClickhouseTransactionType('unknown_999')).toBe(TransactionType.Tip);
  });

  // The prefix is anchored: only the exact `unknown_<digits>` shape is numeric.
  it('does not read digits out of a value that merely contains them', () => {
    expect(fromClickhouseTransactionType('xunknown_28')).toBe(TransactionType.Tip);
    expect(fromClickhouseTransactionType('unknown_28x')).toBe(TransactionType.Tip);
    expect(fromClickhouseTransactionType('unknown_')).toBe(TransactionType.Tip);
  });

  /**
   * 🔴 A PROTOTYPE KEY IS NOT AN ABSENT KEY, and the case above cannot tell the
   * difference: `TransactionType['NotAType']` really is `undefined`, so the obvious
   * `TransactionType[name] ?? Tip` handles it. `'__proto__'` resolves up the chain
   * to a non-nullish OBJECT, which `??` accepts — so this is the input that makes
   * the `typeof` narrowing killable, and the only one here that does.
   */
  it('does not resolve a prototype key to an object', () => {
    expect(fromClickhouseTransactionType('__proto__')).toBe(TransactionType.Tip);
  });
});

describe('clickhouseTransactionTypePredicate', () => {
  /**
   * 🔴 THE REGRESSION ARM for the filter. A name-only predicate is a silent zero
   * for a member the MV cannot name — the export answers 200 with a header-only
   * body, which is indistinguishable from "this user earned nothing".
   */
  it('matches unknown_<n> and the number as well as the name', () => {
    expect(clickhouseTransactionTypePredicate(TransactionType.AppAuthorFee)).toBe(
      "type IN ('appAuthorFee','28','unknown_28')"
    );
    expect(clickhouseTransactionTypePredicate(TransactionType.LicenseFee)).toBe(
      "type IN ('licenseFee','27','unknown_27')"
    );
  });

  /**
   * Every arm is carried for EVERY member — the builder does not branch, which is
   * what keeps it one rule. That they admit nothing extra for a named member is a
   * premise about what the ingest MV writes, and this test does not establish it;
   * `Number(type)` being a real member integer is what bounds the widening.
   */
  it('carries every arm for a named member too', () => {
    expect(clickhouseTransactionTypePredicate(TransactionType.Fee)).toBe(
      "type IN ('fee','25','unknown_25')"
    );
    expect(clickhouseTransactionTypePredicate(TransactionType.Tip)).toBe(
      "type IN ('tip','0','unknown_0')"
    );
  });
});

describe('clickhouseTransactionTypeExclusionPredicate', () => {
  /**
   * 🔴 BOTH BUILDERS RETURN A WHOLE PREDICATE, NOT A VALUE LIST. Pinned because
   * getting that wrong produced `type NOT IN (type NOT IN ('bank',…))` — a SQL
   * syntax error on the gained/spent chart — while every other test in this file
   * stayed green, since none of them looked at the returned string's shape. The
   * assertion is the full normalised output for exactly that reason.
   */
  it('emits a complete NOT IN predicate carrying every spelling per member', () => {
    expect(
      clickhouseTransactionTypeExclusionPredicate([TransactionType.Bank, TransactionType.Extract])
    ).toBe("type NOT IN ('bank','23','unknown_23','extract','24','unknown_24')");
  });

  // `NOT IN ()` is a syntax error, so an empty list must excuse itself rather
  // than emit one and take the whole query down.
  it('excludes nothing, rather than breaking the query, for an empty list', () => {
    expect(clickhouseTransactionTypeExclusionPredicate([])).toBe('1 = 1');
  });
});
