// Prisma read/write clients for the service. Built via the shared @civitai/db factory (same connection
// pooler the monolith uses — pgbouncer nvme0 via DATABASE_URL). Lazy + memoized so importing this module
// never touches process.env or connects; the factory (and its @civitai/db-schema generated-Prisma import)
// is only pulled when getDb() is first called via a DYNAMIC import.
//
// P0: constructed to prove the @civitai/db import + connection config. Feature reads (ApiKey token mint,
// feature/subscription resolution) move in later phases. Returns null when DATABASE_URL isn't configured.
//
// NOTE: we deliberately do NOT `import type { PrismaClients } from '@civitai/db'` at module top-level. That
// would drag @civitai/db-schema's generated Prisma client (which requires `pnpm db:generate`) into this
// package's `tsc --noEmit`, which the P0 skeleton doesn't run. The dynamic import defers the whole db tree
// to call time (build/tests never reach it). The return type is inferred from that import.

// The resolved client pair type, inferred from the factory without a static top-level import.
type PrismaClients = Awaited<ReturnType<typeof loadDb>>;

async function loadDb() {
  const { createPrismaClients } = await import('@civitai/db');
  return createPrismaClients();
}

let _db: PrismaClients | null | undefined;

/**
 * The Prisma read/write clients. Null when DATABASE_URL isn't configured (the skeleton degrades — no
 * feature depends on the DB yet).
 */
export async function getDb(): Promise<PrismaClients | null> {
  if (_db !== undefined) return _db;
  if (!process.env.DATABASE_URL) return (_db = null);
  return (_db = await loadDb());
}
