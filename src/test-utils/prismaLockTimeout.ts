import { Prisma } from '@prisma/client';

/**
 * The Prisma version the shapes below were observed on, against a dev database: a lock wait cancelled
 * by `lock_timeout`, once from a raw query and once from a model `findMany`. `isPrismaLockTimeout`
 * matches these shapes and nothing else, so a Prisma upgrade can change them while every test built
 * from this file stays green.
 */
export const LOCK_TIMEOUT_SHAPES_OBSERVED_ON = '6.13.0';

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
