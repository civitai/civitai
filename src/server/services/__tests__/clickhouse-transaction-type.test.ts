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
 * 🔴 NOT A PURE REGRESSION SUITE. The numeric arm is red at the base commit for
 * `'27'` AND `'28'`; the name arm and the round-trip are invariant guards over
 * behaviour the base already had, and are labelled below.
 */

import {
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
   * 🔴 THE REGRESSION ARM. Red at the base commit, which returned the string
   * `'LicenseFee'` / `'AppAuthorFee'` from the enum's reverse mapping instead of
   * a number — so the assertions below pin the TYPE as well as the value, because
   * `27 == '27'` is not what went wrong: a string that happens to look right
   * still renders as a bare number downstream.
   */
  it('resolves a member stored as its NUMBER — the 0..26 ingest gap', () => {
    for (const [raw, member] of [
      ['27', TransactionType.LicenseFee],
      ['28', TransactionType.AppAuthorFee],
    ] as const) {
      const resolved = fromClickhouseTransactionType(raw);
      expect(resolved).toBe(member);
      expect(typeof resolved).toBe('number');
      // What the base produced, and what a badge or a CSV cell renders from it.
      expect(resolved).not.toBe(TransactionType[member]);
      expect(TransactionType[resolved]).toBe(TransactionType[member]);
    }
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
   * The other half of the same claim, and the one that stops the fix being a
   * blanket widening: for a member the map DOES enumerate, the numeric arm can
   * never match a row, so nothing new is admitted.
   */
  it('stays exact for a member the ingest map enumerates', () => {
    expect(clickhouseTransactionTypePredicate(TransactionType.Fee)).toBe("type IN ('fee','25')");
    expect(clickhouseTransactionTypePredicate(TransactionType.Tip)).toBe("type IN ('tip','0')");
  });
});
