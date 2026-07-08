// Helpers that need a Prisma client. Kept separate from db-helpers.ts so the package
// has no client.ts <-> db-helpers.ts cycle: callers pass `dbWrite` in. The app shim
// binds its dbWrite and re-exports these under their original names/signatures.
import type { PrismaClient } from '@civitai/db-schema';

function lsnGTE(lsn1: string, lsn2: string): boolean {
  const [a1, b1] = lsn1.split('/').map((part) => parseInt(part, 16));
  const [a2, b2] = lsn2.split('/').map((part) => parseInt(part, 16));
  return a1 > a2 || (a1 === a2 && b1 >= b2);
}

export async function getCurrentLSN(dbWrite: PrismaClient) {
  try {
    const currentRes = await dbWrite.$queryRaw<{ lsn: string }[]>`SELECT pg_current_wal_lsn()::text AS lsn`;
    return currentRes[0]?.lsn ?? '';
  } catch (e) {
    // TODO what to return here
    return '';
  }
}

export async function checkNotUpToDate(dbWrite: PrismaClient, lsn: string) {
  try {
    const roRes = await dbWrite.$queryRaw<
      { replay_lsn: string }[]
    >`SELECT replay_lsn::text FROM get_replication_status() where application_name like 'ro-c16-%'`;
    return roRes.some((row) => !lsnGTE(row.replay_lsn, lsn));
  } catch (e) {
    return true;
  }
}

export function makeDbKV(dbWrite: PrismaClient) {
  return {
    get: async function <T>(key: string, defaultValue?: T) {
      const stored = await dbWrite.keyValue.findUnique({ where: { key } });
      return stored ? (stored.value as T) : defaultValue;
    },
    set: async function <T>(key: string, value: T) {
      const json = JSON.stringify(value).replace(/'/g, "''");
      await dbWrite.$executeRawUnsafe(`
        INSERT INTO "KeyValue" ("key", "value")
        VALUES ('${key}', '${json}'::jsonb)
        ON CONFLICT ("key")
        DO UPDATE SET "value" = '${json}'::jsonb
      `);
    },
  };
}
