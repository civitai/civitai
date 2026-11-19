import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { freshPglite } from '../../../../test/pglite';
import { executableSchemaSql, pgliteDialect } from '../../__tests__/abuse-detection-pglite.harness';
import type { CasesDb } from '../cases.db';
import type { CasesTables } from '../cases-tables';

const HERE = dirname(fileURLToPath(import.meta.url));
const DDL = executableSchemaSql(
  readFileSync(join(HERE, '../../../../../cases/schema.sql'), 'utf8')
);

/** A fresh in-process Postgres with `cases/schema.sql` applied, and the case client over it. */
export async function casesPglite(): Promise<{ pg: PGlite; db: CasesDb }> {
  const pg = await freshPglite();
  await pg.exec(DDL);
  const db = new Kysely<CasesTables>({ dialect: pgliteDialect(pg) }) as unknown as CasesDb;
  return { pg, db };
}
