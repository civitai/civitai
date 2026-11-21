// eslint-disable-next-line import/no-extraneous-dependencies
import { describe, expect, it } from 'vitest';
import { poolNetBankedSql } from './creator-program';

describe('poolNetBankedSql', () => {
  const sql = poolNetBankedSql(202610, "'yellow', 'green'").replace(/\s+/g, ' ');

  it('adds deposits into the month bank and subtracts extractions out of it', () => {
    expect(sql).toContain("SUM(if(toAccountType = 'creatorProgramBank', amount, -amount))");
    expect(sql).toContain(
      "toAccountType = 'creatorProgramBank' AND toAccountId = 202610 AND fromAccountType IN ('yellow', 'green')"
    );
    expect(sql).toContain(
      "fromAccountType = 'creatorProgramBank' AND fromAccountId = 202610 AND toAccountType IN ('yellow', 'green')"
    );
  });

  it('never interpolates a non-integer account id', () => {
    expect(poolNetBankedSql(202610.9, "'yellow'")).toContain('toAccountId = 202610');
  });
});
