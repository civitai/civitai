import { createKyselyClients, type Generated } from '@civitai/db/kysely';
import type { Kysely } from 'kysely';
import { env } from '$env/dynamic/private';

/**
 * Client for the abuse-detection tables in the `internal_tools` instance.
 *
 * 🔴 `MODERATOR_DATABASE_URL`, NOT `RETOOL_DATABASE_URL`. `getModeratorDb()` in `moderator-db.ts`
 * reads the latter, and they are DIFFERENT INSTANCES — the Retool one holds the legacy notes/strikes
 * tables the migration is moving away from. Pointing this at that instance aims these queries at a
 * database where the tables do not exist. Same instance the XGuard lab uses, and this mirrors its
 * client for that reason.
 *
 * Schema: `apps/moderator/abuse-detection/schema.sql`, applied BY HAND (repo convention — no
 * `prisma migrate deploy`, nothing auto-runs it).
 */
export interface AbuseDetectionDB {
  abuse_detection_run: {
    id: Generated<number>;
    detector: string;
    started_at: Date;
    finished_at: Date;
    summary: string | null;
    counters: Generated<unknown>;
    received_at: Generated<Date>;
  };
  abuse_detection_finding: {
    id: Generated<number>;
    run_id: number;
    user_id: number;
    confidence: number;
    reason: string;
    actioned: boolean;
    action: string | null;
    created_at: Generated<Date>;
  };
}

function dbUrl(): string {
  const url = env.MODERATOR_DATABASE_URL;
  if (!url) throw new Error('MODERATOR_DATABASE_URL is not configured');
  return url;
}

/**
 * `sslNoVerify` turns SSL ON while skipping cert verification — what the cnpg cluster needs, and what
 * a plain local docker Postgres rejects outright ("The server does not support SSL connections").
 * Decided from the host so one code path works in both, exactly as `xguard-lab.ts` does.
 */
function isLocalHost(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

// Lazy, for the same reason the lab's is: constructing at module scope takes down every page that
// merely imports this module whenever MODERATOR_DATABASE_URL is unset.
let client: Kysely<AbuseDetectionDB> | undefined;

/**
 * One instance, and the write path must read its own writes — so `singleClient`, not the read/write
 * pair. Passing the same URL as a "replica" (which is what `xguard-lab.ts` does) builds a SECOND
 * pool that is then discarded, doubling this app's connections to that database for nothing.
 */
export function getAbuseDetectionDb(): Kysely<AbuseDetectionDB> {
  if (!client) {
    const url = dbUrl();
    const { db } = createKyselyClients<AbuseDetectionDB>({
      connectionString: url,
      singleClient: true,
      sslNoVerify: !isLocalHost(url),
    });
    client = db;
  }
  return client;
}
