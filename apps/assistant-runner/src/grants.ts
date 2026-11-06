import type pg from 'pg';

import type { EndedReply } from './core/head';
import type { GrantStore, Logger, PendingEnd, StoredGrant } from './core/interfaces';
import { requestGrantFor } from './core/request-grant';

/** The runner's own tables, apart from DBOS's `dbos` schema. */
export const RUNNER_SCHEMA = 'assistant_runner';
const TABLE = `"${RUNNER_SCHEMA}".run_grants`;
/**
 * Run grants, one row per run, in the runner's database. Written when a run starts, deleted on every
 * end path the runner owns once the end is in the head, and swept once expired. What is here mints
 * only together with the runner's secret, and only until each grant's expiry.
 */
export class RunGrants implements GrantStore {
  readonly #pool: pg.Pool;
  readonly #log: Pick<Logger, 'warn'> | undefined;
  #ready: Promise<void> | undefined;

  constructor(pool: pg.Pool, log?: Pick<Logger, 'warn'>) {
    this.#pool = pool;
    this.#log = log;
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
           created_at timestamptz not null default now(),
           pending_seq integer,
           pending_end jsonb
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

  async forgetUnlessEndPending(runId: string): Promise<void> {
    await this.#pool.query(`delete from ${TABLE} where run_id = $1 and pending_end is null`, [
      runId,
    ]);
  }

  async markEndPending(runId: string, seq: number, reply: EndedReply): Promise<void> {
    await this.#pool.query(
      `update ${TABLE} set pending_seq = $2, pending_end = $3 where run_id = $1`,
      [runId, seq, JSON.stringify(reply)]
    );
  }

  async pendingEnds(): Promise<PendingEnd[]> {
    const { rows } = await this.#pool.query<{
      run_id: string;
      user_id: string;
      conversation_id: string;
      pending_seq: number;
      pending_end: EndedReply;
    }>(
      `select run_id, user_id, conversation_id, pending_seq, pending_end from ${TABLE}
       where pending_end is not null and expires_at > now() order by created_at limit 100`
    );
    return rows.map((row) => ({
      runId: row.run_id,
      userId: row.user_id,
      conversationId: row.conversation_id,
      seq: row.pending_seq,
      reply: row.pending_end,
    }));
  }

  /**
   * Deletes the grants that expired: they mint nothing any more. Every end path the runner owns
   * deletes its run's grant itself (`Runner`), so this only catches what those missed.
   */
  async sweep(): Promise<number> {
    const { rows } = await this.#pool.query<{ run_id: string; pending: boolean }>(
      `delete from ${TABLE} where expires_at <= now() returning run_id, pending_end is not null as pending`
    );
    // An end still pending when its grant expired can no longer be minted for: it is lost. Said so,
    // by run id only.
    for (const row of rows)
      if (row.pending)
        this.#log?.warn(
          { runId: row.run_id },
          'a reply end was never saved before its grant expired'
        );
    return rows.length;
  }
}

/** The grant to act with for this user's conversation: the request's own, else a live run's. */
export async function grantForConversation(
  grants: Pick<RunGrants, 'forConversation'>,
  userId: string,
  conversationId: string
): Promise<string | null> {
  const own = requestGrantFor(userId, conversationId);
  if (own !== undefined) return own;
  return grants.forConversation(userId, conversationId);
}
