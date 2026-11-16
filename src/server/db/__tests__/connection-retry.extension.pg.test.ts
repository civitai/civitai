import { createPrismaClients, type PrismaClients } from '@civitai/db/client';
import { connectionRetryExtension } from '@civitai/db/connection-retry';
import { Prisma, PrismaClient } from '@civitai/db-schema';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The read retry against a real Postgres. Runs in CI on the `unit` job's throwaway Postgres (the URL
 * the hot-reads-2 parity suite uses); skips locally without one. Point it only at a THROWAWAY
 * database: it creates and drops the `connection_retry` schema and terminates its own connections.
 */
const databaseUrl =
  process.env.CONNECTION_RETRY_DATABASE_URL ?? process.env.KYSELY_HOT_READS_2_PARITY_DATABASE_URL;
const SCHEMA = 'connection_retry';

const withParams = (url: string, params: Record<string, string>) => {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(params)) parsed.searchParams.set(key, value);
  return parsed.toString();
};

describe.skipIf(!databaseUrl)('the connection retry extension on a real database', () => {
  const admin = new PrismaClient({ datasourceUrl: databaseUrl });
  const terminate = (applicationName: string) =>
    admin.$queryRawUnsafe<{ terminated: boolean }[]>(
      'SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE application_name = $1',
      applicationName
    );
  /**
   * Wait, idle, until the terminated session is gone and its client has had a moment to see the
   * close, as a pooled connection does between requests. A read sent while the server's
   * termination message is still in flight fails differently (57P01, which the retry deliberately
   * does not match; see connection-retry.ts), and that race is not the case under test.
   */
  const idleUntilGone = async (applicationName: string) => {
    for (let i = 0; i < 50; i++) {
      const [{ n }] = await admin.$queryRawUnsafe<{ n: number }[]>(
        'SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1',
        applicationName
      );
      if (n === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  };

  beforeAll(async () => {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${SCHEMA}"`);
    await admin.$executeRawUnsafe(`CREATE TABLE "${SCHEMA}"."User" (id integer PRIMARY KEY)`);
    await admin.$executeRawUnsafe(`INSERT INTO "${SCHEMA}"."User" (id) VALUES (7)`);
  });
  afterAll(async () => {
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await admin.$disconnect();
  });

  /**
   * The bug as the app sees it: the server side closes a pooled connection (as a pooler restart
   * does), and the next read on it fails with P1017. One connection, so the read must get the one
   * that was closed. The read runs once first so its statement is cached on that connection: the
   * engine then notices the closed connection while running it and discards it, and the retry gets
   * a fresh one. (A read whose statement is not yet cached fails while preparing, which the engine
   * does not treat as a dead connection: there a retry fails the same way.)
   */
  describe('a read on a connection the server closed', () => {
    const APP = 'connection-retry-test';
    const onConnectionRetry = vi.fn();
    let clients: PrismaClients;

    beforeAll(() => {
      const url = withParams(databaseUrl as string, {
        schema: SCHEMA,
        application_name: APP,
        connection_limit: '1',
      });
      vi.stubEnv('DATABASE_URL', url);
      vi.stubEnv('DATABASE_REPLICA_URL', url);
      clients = createPrismaClients({ logging: [], onConnectionRetry });
    });
    afterAll(async () => {
      vi.unstubAllEnvs();
      await clients?.dbWrite.$disconnect();
    });

    it('is retried once and returns the rows', async () => {
      const read = () => clients.dbRead.user.findMany({ select: { id: true } });
      await expect(read()).resolves.toEqual([{ id: 7 }]);
      expect(await terminate(APP)).toEqual([{ terminated: true }]);
      await idleUntilGone(APP);

      await expect(read()).resolves.toEqual([{ id: 7 }]);
      expect(onConnectionRetry).toHaveBeenCalledTimes(1);
      expect(onConnectionRetry).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'User', operation: 'findMany', result: 'ok' })
      );
    });
  });

  /**
   * A read inside an interactive transaction is never retried. The retry detects the transaction
   * from Prisma's undocumented `__internalParams.transaction`, so this pins that on the installed
   * Prisma through a real `$transaction(async (tx) => …)`. The queries never reach the database: an
   * inner extension stands in for the engine and fails every call with P1017.
   */
  describe('inside a transaction', () => {
    const state = { calls: 0 };
    const engine = async () => {
      state.calls += 1;
      throw new Prisma.PrismaClientKnownRequestError('Server has closed the connection.', {
        code: 'P1017',
        clientVersion: '6.13.0',
      });
    };
    const base = new PrismaClient({ datasourceUrl: databaseUrl });
    const client = base
      .$extends(connectionRetryExtension())
      .$extends({ query: { $allModels: { findMany: engine } } });

    beforeEach(() => {
      state.calls = 0;
    });
    afterAll(() => base.$disconnect());

    it('retries the read outside a transaction (control)', async () => {
      await expect(client.user.findMany()).rejects.toMatchObject({ code: 'P1017' });
      expect(state.calls).toBe(2);
    });

    it('does not retry the same read inside an interactive transaction', async () => {
      await expect(client.$transaction((tx) => tx.user.findMany())).rejects.toMatchObject({
        code: 'P1017',
      });
      expect(state.calls).toBe(1);
    });
  });
});
