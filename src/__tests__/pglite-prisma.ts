import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { PrismaClient } from '@prisma/client';
import type { AddressInfo } from 'node:net';

/**
 * The pglite-prisma harness: an in-memory PGlite behind its wire-protocol socket, driven by the
 * generated Prisma client. Prisma's engine cannot use PGlite directly (that needs a driver adapter
 * this client is not built with), but it speaks to the socket like any Postgres, so a test runs
 * the app's own Prisma `where` objects and raw SQL against the same tables, with real transaction
 * semantics. Nothing is skipped: if PGlite or the socket cannot start, the test fails.
 *
 * The socket serves one connection, so the client is limited to one. Give `schema` only the
 * types, tables and columns the test touches (Prisma reads every scalar column of a row it
 * returns unless the query has a `select`).
 *
 * Not faithful on errors: after any failed statement the socket (0.1.6) drops Prisma's connection
 * and can leave PGlite in an aborted transaction. Call `recover()` after an expected failure, and
 * test what a failure does inside a transaction through `pg` directly.
 */
export async function startPglitePrisma(schema: string) {
  const pg = await PGlite.create();
  await pg.exec(schema);
  const server = new PGLiteSocketServer({
    db: pg,
    host: '127.0.0.1',
    port: 0,
    debug: !!process.env.PGLITE_DEBUG,
  });
  await server.start();
  // The socket server keeps its listener private; port 0 is only known from it.
  const { port } = (server as unknown as { server: { address(): AddressInfo } }).server.address();
  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: `postgresql://postgres@127.0.0.1:${port}/postgres?connection_limit=1&sslmode=disable`,
      },
    },
  });
  await prisma.$connect();

  return {
    pg,
    prisma,
    async recover() {
      await pg.exec('ROLLBACK');
      await prisma.$disconnect();
      await prisma.$connect();
    },
    async stop() {
      await prisma.$disconnect();
      await server.stop();
      await pg.close();
    },
  };
}
