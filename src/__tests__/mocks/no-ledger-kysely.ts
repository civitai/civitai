import { pgliteKysely } from '~/__tests__/pglite-kysely';

/**
 * A `~/server/db/kyselyDb` whose every query throws: for suites that reach the ban leg (which
 * revokes recipe-runner authorizations through kyselyDb) but never read them.
 */
export function noLedgerKyselyDb() {
  return {
    kyselyWrite: pgliteKysely(() => {
      throw new Error('no ledger database in this suite');
    }),
  };
}
