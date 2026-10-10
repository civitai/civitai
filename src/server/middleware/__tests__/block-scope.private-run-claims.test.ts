import { describe, expect, it } from 'vitest';
import { blockPerCallBudget } from '~/server/middleware/block-scope.middleware';
import {
  isPrivateRunAudience,
  PRIVATE_RUN_AUDIENCE_WITNESS,
  PRIVATE_RUN_AUDIENCES,
} from '~/shared/constants/block-scope.constants';

/**
 * THE RUNTIME EDITOR READ-ONLY BELT, and the audience claim's closed-set test.
 *
 * Both [REG]: `blockPerCallBudget` ignores the audience entirely at `f7f5eb4996`, and
 * `isPrivateRunAudience` does not exist there.
 *
 * ── WHY THE BELT IS IN `blockPerCallBudget` AND NOT AT THE SUBMIT GATES ─────────
 * Every submit gate compares a cost against a per-call ceiling (the training run through
 * `blockTrainingRunCeiling`, which calls this helper first), and
 * `no-direct-block-budget-claim-read` forces each through this ONE function rather than
 * reading `claims.buzzBudget` directly. That convention is what lets an audience decision
 * be made once here and apply to all of them, and the next gate inherits the belt for
 * free. Open-coding the check at each gate would regenerate the same omission at every
 * site.
 */
describe('blockPerCallBudget — the editor read-only belt [REG]', () => {
  it('an EDITOR private-run token gets a per-call ceiling of ZERO, whatever it was minted with', () => {
    // 137 is deliberately not a multiple of any cap and not zero, so a mutant that
    // deleted the belt would return 137 and MOVE the output — a fixture using 0 could
    // not tell the belt from an unbudgeted token.
    expect(
      blockPerCallBudget(
        { buzzBudget: 137, privateRunAudience: 'editor' },
        {
          pricesAuthorFee: false,
        }
      )
    ).toBe(0);
    // And with the fee-pricing classification too, since the flag reads nothing today
    // but a future ceiling decision behind it must not resurrect the budget.
    expect(
      blockPerCallBudget(
        { buzzBudget: 137, privateRunAudience: 'editor' },
        {
          pricesAuthorFee: true,
        }
      )
    ).toBe(0);
  });

  it('OWNER and MODERATOR private-run tokens keep their minted ceiling', () => {
    // The belt must be audience-SPECIFIC, not "private runs cannot spend" — moderators
    // have full parity including capped spend, and the owner case is the existing
    // dev-tunnel precedent. A mutant that widened the belt to all private runs is
    // caught here rather than only in a money test.
    for (const audience of ['owner', 'moderator'] as const) {
      expect(
        blockPerCallBudget(
          { buzzBudget: 137, privateRunAudience: audience },
          {
            pricesAuthorFee: false,
          }
        ),
        `audience=${audience}`
      ).toBe(137);
    }
  });

  it('an ORDINARY token (no audience claim) is completely unaffected', () => {
    // The prod path must be byte-identical. This is the row that fails if the belt were
    // written as a positive test (`audience !== 'owner'`) rather than a negative one.
    expect(blockPerCallBudget({ buzzBudget: 137 }, { pricesAuthorFee: false })).toBe(137);
    expect(blockPerCallBudget({ buzzBudget: 0 }, { pricesAuthorFee: false })).toBe(0);
    expect(blockPerCallBudget({}, { pricesAuthorFee: false })).toBe(0);
  });

  it('🔴 the belt is checked BEFORE the budget type test, so it cannot be bypassed', () => {
    // Ordering matters here for the same reason it matters in the cap selector: if the
    // `typeof !== 'number'` test ran first and returned early, an editor token carrying
    // a NaN or string budget would take that path instead — same answer today by luck,
    // but the belt would not be the thing producing it, so its mutant would survive.
    expect(
      blockPerCallBudget(
        { buzzBudget: NaN as number, privateRunAudience: 'editor' },
        {
          pricesAuthorFee: false,
        }
      )
    ).toBe(0);
    // The discriminating case: a NUMBER budget with the editor audience. Only the belt
    // can produce 0 here — the type test passes.
    expect(
      blockPerCallBudget(
        { buzzBudget: 301, privateRunAudience: 'editor' },
        {
          pricesAuthorFee: false,
        }
      )
    ).toBe(0);
  });

  it('POSITIVE CONTROL: this function can return a NON-zero value', () => {
    // A belt test whose every row expects 0 is indistinguishable from a function that
    // always returns 0. Prove the output can move before believing any zero above.
    expect(
      blockPerCallBudget(
        { buzzBudget: 301, privateRunAudience: 'owner' },
        {
          pricesAuthorFee: false,
        }
      )
    ).toBe(301);
  });
});

describe('isPrivateRunAudience — the closed-set claim test [REG]', () => {
  it('accepts exactly the three audiences and nothing else', () => {
    for (const a of PRIVATE_RUN_AUDIENCES) expect(isPrivateRunAudience(a)).toBe(true);
    expect(PRIVATE_RUN_AUDIENCES).toEqual(['owner', 'editor', 'moderator']);
  });

  it('🔴 the TUPLE and the TYPE are in lockstep — the runtime half', () => {
    // The compile-time half is `PRIVATE_RUN_AUDIENCE_WITNESS` in the constants module: a
    // `Record<PrivateRunAudience, true>` literal, so the TYPE growing is a type error
    // there. This is the other direction, which is the UNSAFE one: the TUPLE growing
    // without the type makes `isPrivateRunAudience` admit a value the type says cannot
    // exist, the verifier lets it through, and the read-only belt's `=== 'editor'`
    // treats it as an owner.
    //
    // Compared against the WITNESS's keys rather than a hand-written list, because a
    // hand-copied expectation is exactly how the matrix's own completeness check went
    // stale before it was derived.
    expect([...PRIVATE_RUN_AUDIENCES].sort()).toEqual(
      Object.keys(PRIVATE_RUN_AUDIENCE_WITNESS).sort()
    );
    // And the predicate agrees with both, so all three artefacts describe one set.
    for (const a of Object.keys(PRIVATE_RUN_AUDIENCE_WITNESS)) {
      expect(isPrivateRunAudience(a), `${a} is in the type but rejected at runtime`).toBe(true);
    }
  });

  it('🔴 rejects the near-misses that would otherwise be treated as an owner', () => {
    // The failure direction: an unrecognised string is not `'editor'`, so it would pass
    // the read-only belt with full power. Casing, whitespace and empty are the shapes a
    // hand-edited or forged claim actually takes.
    for (const bogus of ['Editor', 'OWNER', 'moderator ', ' owner', '', 'admin', 'owner\n']) {
      expect(isPrivateRunAudience(bogus), JSON.stringify(bogus)).toBe(false);
    }
  });

  it('🔴 rejects non-strings and PROTOTYPE-CHAIN keys (an own-set test, not `in`)', () => {
    // The sibling `isKnownBlockScope` used to use `in`, which walks the prototype chain
    // and let 12 inherited `Object.prototype` keys through as "known scopes". This is
    // the same class, one predicate over: `constructor`, `__proto__` and `toString` are
    // properties of every object and must not be audiences.
    for (const bogus of [
      undefined,
      null,
      0,
      1,
      true,
      false,
      {},
      [],
      ['owner'],
      'constructor',
      '__proto__',
      'toString',
      'hasOwnProperty',
      'valueOf',
    ]) {
      expect(isPrivateRunAudience(bogus), String(bogus)).toBe(false);
    }
  });
});
