import { Prisma } from '@prisma/client';

// Lock timeout shapes observed on @prisma/client 6.13.0 (probe C, 2026-10-18).

/** A raw query's failure: P2010 with the SQLSTATE in `meta.code`. */
export const rawQueryError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('Raw query failed', {
    code: 'P2010',
    clientVersion: 'test',
    meta: { code },
  });

/** A model query's failure: no code, the SQLSTATE only in the engine's message. */
export const modelQueryError = (code: string) =>
  new Prisma.PrismaClientUnknownRequestError(
    `Error occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "${code}", message: "canceling statement due to lock timeout", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })`,
    { clientVersion: 'test' }
  );
