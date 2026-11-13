import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { TransactionType } from '~/shared/constants/buzz.constants';

/**
 * The moderator app keeps its own copy of `TransactionType` (it cannot import the main app), and
 * the numbers are what the Buzz ledger stores. A member missing there is a transaction a moderator
 * cannot file as what it is; a wrong number files it as something else.
 */
const MIRROR = join(process.cwd(), 'apps/moderator/src/lib/server/user-actions.service.ts');

function readMirror() {
  const source = readFileSync(MIRROR, 'utf8');
  const body = /export const BUZZ_TRANSACTION_TYPES = \{([^}]*)\} as const;/.exec(source)?.[1];
  if (!body) throw new Error(`BUZZ_TRANSACTION_TYPES not found in ${MIRROR}`);
  return Object.fromEntries(
    [...body.matchAll(/^\s*(\w+):\s*(\d+),?\s*$/gm)].map(([, name, value]) => [name, Number(value)])
  );
}

describe('the moderator BUZZ_TRANSACTION_TYPES mirror', () => {
  it('matches every TransactionType member, name and number', () => {
    const members = Object.fromEntries(
      Object.entries(TransactionType).filter(([, value]) => typeof value === 'number')
    );
    expect(readMirror()).toEqual(members);
  });

  it('pins ServiceEscrow at 29, the number ClickHouse rows already carry as unknown_29', () => {
    expect(TransactionType.ServiceEscrow).toBe(29);
  });
});
