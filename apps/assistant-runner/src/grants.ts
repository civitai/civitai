import { AsyncLocalStorage } from 'node:async_hooks';

import type pg from 'pg';

import type { GrantStore, StoredGrant } from './interfaces';

/** The runner's own tables, apart from DBOS's `dbos` schema. */
export const RUNNER_SCHEMA = 'assistant_runner';
const TABLE = `"${RUNNER_SCHEMA}".run_grants`;
/** DBOS's system schema, where it records each run's status (see `runner.ts`). */
const DBOS_SCHEMA = 'dbos';
const TERMINAL = ['SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'];
/**
 * How long a grant outlives its run's end. A run cancelled outright, or one that failed, gets its end
 * written to the head by whoever reads its stream next (`Runner#endFromHead`), which needs the grant.
 */
const AFTER_END_MS = 15 * 60 * 1000;
/** A grant saved for a start that never became a run (the start failed after saving it). */
const ORPHAN_MS = 15 * 60 * 1000;

/**
 * Run grants, one row per run, in the runner's database. Written when a run starts, deleted when it
 * ends by itself, and swept once expired or a while after its run ended any other way. What is here
 * mints only together with the runner's secret, and only until each grant's expiry.
 */
export class RunGrants implements GrantStore {
  readonly #pool: pg.Pool;
  #ready: Promise<void> | undefined;

  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  /** Creates the table. Safe to call on every replica at every start. */
  init(): Promise<void> {
    this.#ready ??= this.#pool
      .query(
        `create schema if not exists "${RUNNER_SCHEMA}";
         create table if not exists ${TABLE} (
           run_id text primary key,
           user_id text not null,
           conversation_id text not null,
           grant_token text not null,
           expires_at timestamptz not null,
           created_at timestamptz not null default now()
         );
         create index if not exists run_grants_conversation on ${TABLE} (user_id, conversation_id, expires_at desc);`
      )
      .then(() => undefined);
    return this.#ready;
  }

  async save(runId: string, grant: StoredGrant): Promise<void> {
    // A retried start brings a newer grant for the same run: the later expiry wins.
    await this.#pool.query(
      `insert into ${TABLE} (run_id, user_id, conversation_id, grant_token, expires_at)
       values ($1, $2, $3, $4, $5)
       on conflict (run_id) do update set grant_token = excluded.grant_token, expires_at = excluded.expires_at
       where ${TABLE}.expires_at < excluded.expires_at`,
      [runId, grant.userId, grant.conversationId, grant.token, grant.expiresAt]
    );
  }

  async delete(runId: string): Promise<void> {
    await this.#pool.query(`delete from ${TABLE} where run_id = $1`, [runId]);
  }

  /** The run's grant while it is live, else `null`. */
  async forRun(runId: string): Promise<string | null> {
    const { rows } = await this.#pool.query<{ grant_token: string }>(
      `select grant_token from ${TABLE} where run_id = $1 and expires_at > now()`,
      [runId]
    );
    return rows[0]?.grant_token ?? null;
  }

  /** The latest live grant the user gave for this conversation, else `null`. */
  async forConversation(userId: string, conversationId: string): Promise<string | null> {
    const { rows } = await this.#pool.query<{ grant_token: string }>(
      `select grant_token from ${TABLE}
       where user_id = $1 and conversation_id = $2 and expires_at > now()
       order by expires_at desc limit 1`,
      [userId, conversationId]
    );
    return rows[0]?.grant_token ?? null;
  }

  async sweep(): Promise<number> {
    const now = Date.now();
    const { rowCount } = await this.#pool.query(
      `delete from ${TABLE} g
       where g.expires_at <= now()
          or exists (
               select 1 from "${DBOS_SCHEMA}".workflow_status w
               where w.workflow_uuid = g.run_id and w.status = any($1::text[]) and w.updated_at < $2)
          or (g.created_at < now() - make_interval(secs => $3)
              and not exists (select 1 from "${DBOS_SCHEMA}".workflow_status w where w.workflow_uuid = g.run_id))`,
      [TERMINAL, now - AFTER_END_MS, ORPHAN_MS / 1000]
    );
    return rowCount ?? 0;
  }
}

/**
 * A grant that came with the request being served (a patch), for the conversation store to mint
 * with when no run of that conversation holds one. In memory for that request only.
 */
const requestGrant = new AsyncLocalStorage<{
  userId: string;
  conversationId: string;
  token: string;
}>();

export function withRequestGrant<T>(
  grant: { userId: string; conversationId: string; token: string } | undefined,
  fn: () => Promise<T>
): Promise<T> {
  return grant ? requestGrant.run(grant, fn) : fn();
}

/** The grant to act with for this user's conversation: the request's own, else a live run's. */
export async function grantForConversation(
  grants: Pick<RunGrants, 'forConversation'>,
  userId: string,
  conversationId: string
): Promise<string | null> {
  const own = requestGrant.getStore();
  if (own && own.userId === userId && own.conversationId === conversationId) return own.token;
  return grants.forConversation(userId, conversationId);
}
