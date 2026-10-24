import { sql } from '@civitai/db/kysely';
import { getModeratorDb } from '../moderator-db';
import type { AssistantTables, PriceSource } from './tables';
import { CEILING_PRICE, type TokenRow } from '$lib/assistant/models';
import type {
  PlaybookStatus,
  ToolRequestStatus,
  TurnSource,
  TurnStatus,
  TurnToolCall,
} from '$lib/assistant/types';

// Every read and write of the assistant's tables. Chats and turns are scoped by moderator at every
// read a moderator can reach: a chat id in the URL is a guess away from someone else's investigation.

const db = () => getModeratorDb().withTables<AssistantTables>();

export type Chat = {
  id: number;
  title: string;
  seedUserId: number | null;
  seedReportId: number | null;
  createdAt: Date;
  updatedAt: Date;
};

const chatColumns = [
  'id',
  'title',
  'seed_user_id as seedUserId',
  'seed_report_id as seedReportId',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

export async function listChats(moderatorId: number, limit = 100): Promise<Chat[]> {
  return db()
    .selectFrom('assistant_chat')
    .select(chatColumns)
    .where('moderator_id', '=', moderatorId)
    .where('archived_at', 'is', null)
    .orderBy('updated_at', 'desc')
    .limit(limit)
    .execute();
}

export async function getChat(id: number, moderatorId: number): Promise<Chat | null> {
  const row = await db()
    .selectFrom('assistant_chat')
    .select(chatColumns)
    .where('id', '=', id)
    .where('moderator_id', '=', moderatorId)
    .where('archived_at', 'is', null)
    .executeTakeFirst();
  return row ?? null;
}

/** What a chat is called until it is renamed or its first question names it. */
export const DEFAULT_CHAT_TITLE = 'New investigation';

/** This moderator's newest open chat opened on exactly this account and report, so Investigate
 *  returns to a case rather than starting it again. */
export async function findSeededChat(
  moderatorId: number,
  seed: { userId: number | null; reportId: number | null }
): Promise<number | null> {
  const row = await db()
    .selectFrom('assistant_chat')
    .select('id')
    .where('moderator_id', '=', moderatorId)
    .where('archived_at', 'is', null)
    .where(sql<boolean>`seed_user_id IS NOT DISTINCT FROM ${seed.userId}::integer`)
    .where(sql<boolean>`seed_report_id IS NOT DISTINCT FROM ${seed.reportId}::integer`)
    .orderBy('updated_at', 'desc')
    .executeTakeFirst();
  return row?.id ?? null;
}

export async function createChat(input: {
  moderatorId: number;
  title: string;
  seedUserId: number | null;
  seedReportId: number | null;
}): Promise<number> {
  const row = await db()
    .insertInto('assistant_chat')
    .values({
      moderator_id: input.moderatorId,
      title: input.title,
      seed_user_id: input.seedUserId,
      seed_report_id: input.seedReportId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** The key for this chat's address labels. Server-side only: with it, a label can be tested against a
 *  guessed address. */
export async function getMaskSalt(chatId: number): Promise<string> {
  const row = await db()
    .selectFrom('assistant_chat')
    .select('mask_salt')
    .where('id', '=', chatId)
    .executeTakeFirstOrThrow();
  return row.mask_salt;
}

/** `false` when nothing matched: someone else's chat, or one already archived. */
export async function archiveChat(id: number, moderatorId: number): Promise<boolean> {
  const result = await db()
    .updateTable('assistant_chat')
    .set({ archived_at: sql`now()` })
    .where('id', '=', id)
    .where('moderator_id', '=', moderatorId)
    .where('archived_at', 'is', null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

export async function renameChat(id: number, moderatorId: number, title: string): Promise<boolean> {
  const result = await db()
    .updateTable('assistant_chat')
    .set({ title })
    .where('id', '=', id)
    .where('moderator_id', '=', moderatorId)
    .where('archived_at', 'is', null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

export type Turn = {
  id: number;
  chatId: number;
  moderatorId: number;
  prompt: string;
  playbookSlug: string | null;
  playbookVersion: number | null;
  status: TurnStatus;
  toolCalls: TurnToolCall[];
  sources: TurnSource[];
  answer: string | null;
  reasoning: string | null;
  unverified: string[];
  error: string | null;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  createdAt: Date;
  finishedAt: Date | null;
};

const turnColumns = [
  'id',
  'chat_id as chatId',
  'moderator_id as moderatorId',
  'prompt',
  'playbook_slug as playbookSlug',
  'playbook_version as playbookVersion',
  'status',
  'tool_calls as toolCalls',
  'sources',
  'answer',
  'reasoning',
  'unverified',
  'error',
  'model',
  'prompt_tokens as promptTokens',
  'completion_tokens as completionTokens',
  'total_tokens as totalTokens',
  'created_at as createdAt',
  'finished_at as finishedAt',
] as const;

/** A chat's turns, oldest first. The caller has already established the chat is the moderator's. */
export async function listTurns(chatId: number): Promise<Turn[]> {
  return db()
    .selectFrom('assistant_turn')
    .select(turnColumns)
    .where('chat_id', '=', chatId)
    .orderBy('id', 'asc')
    .execute();
}

export async function startTurn(input: {
  chatId: number;
  moderatorId: number;
  prompt: string;
  playbookSlug: string | null;
  playbookVersion: number | null;
  model: string;
}): Promise<number> {
  const row = await db()
    .insertInto('assistant_turn')
    .values({
      chat_id: input.chatId,
      moderator_id: input.moderatorId,
      prompt: input.prompt,
      playbook_slug: input.playbookSlug,
      playbook_version: input.playbookVersion,
      model: input.model,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db()
    .updateTable('assistant_chat')
    .set({ updated_at: sql`now()` })
    .where('id', '=', input.chatId)
    .execute();
  return row.id;
}

export async function finishTurn(
  id: number,
  outcome: {
    status: Exclude<TurnStatus, 'running'>;
    toolCalls: TurnToolCall[];
    sources: TurnSource[];
    answer: string | null;
    reasoning: string | null;
    unverified: string[];
    error: string | null;
    promptTokens: number;
    completionTokens: number;
  },
  cost: { usd: number; source: PriceSource }
): Promise<void> {
  // jsonb columns take a JSON string; handing Kysely the array would bind it as a Postgres array.
  await db()
    .updateTable('assistant_turn')
    .set({
      status: outcome.status,
      tool_calls: sql`${JSON.stringify(outcome.toolCalls)}::jsonb`,
      sources: sql`${JSON.stringify(outcome.sources)}::jsonb`,
      answer: outcome.answer,
      reasoning: outcome.reasoning,
      unverified: sql`${JSON.stringify(outcome.unverified)}::jsonb`,
      error: outcome.error,
      prompt_tokens: outcome.promptTokens,
      completion_tokens: outcome.completionTokens,
      total_tokens: outcome.promptTokens + outcome.completionTokens,
      cost_usd: cost.usd,
      price_source: cost.source,
      finished_at: sql`now()`,
    })
    .where('id', '=', id)
    .where('status', '=', 'running')
    .execute();
}

/** A running turn's tokens so far. Only a running row: the outcome `finishTurn` wrote is final. */
export async function recordTurnTokens(
  id: number,
  promptTokens: number,
  completionTokens: number
): Promise<void> {
  await db()
    .updateTable('assistant_turn')
    .set({
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    })
    .where('id', '=', id)
    .where('status', '=', 'running')
    .execute();
}

/**
 * Whether this moderator has a turn running, in any chat. A turn left `running` by a process that died
 * mid-turn would otherwise block them forever; one that has run longer than any turn can is closed out
 * as an error.
 */
export async function hasRunningTurn(moderatorId: number, staleAfterMs: number): Promise<boolean> {
  const cutoff = new Date(Date.now() - staleAfterMs);
  await db()
    .updateTable('assistant_turn')
    .set({ status: 'error', error: 'Abandoned: the turn never finished.', finished_at: sql`now()` })
    .where('moderator_id', '=', moderatorId)
    .where('status', '=', 'running')
    .where('created_at', '<', cutoff)
    .execute();
  const row = await db()
    .selectFrom('assistant_turn')
    .select('id')
    .where('moderator_id', '=', moderatorId)
    .where('status', '=', 'running')
    .executeTakeFirst();
  return !!row;
}

/** Tokens this moderator's turns have spent since midnight UTC: the circuit breaker's count. A running
 *  turn counts what it has recorded so far, which is why only one may run at a time
 *  (`assistant_turn_one_running_idx`). */
export async function tokensToday(moderatorId: number): Promise<number> {
  return sumTokens(await tokensTodayByModel(moderatorId));
}

export const sumTokens = (rows: TokenRow[]) =>
  rows.reduce((sum, r) => sum + r.promptTokens + r.completionTokens, 0);

const startOfUtcDay = sql<Date>`date_trunc('day', now() at time zone 'utc') at time zone 'utc'`;

/**
 * USD this moderator's turns have cost since midnight UTC: what the daily dollar cap compares against.
 * A turn with no recorded cost (one from before costs were kept, one still running, or one whose
 * process died) is charged its recorded tokens at `CEILING_PRICE`.
 */
export async function usdToday(moderatorId: number): Promise<number> {
  const row = await db()
    .selectFrom('assistant_turn')
    .select(
      sql<string>`coalesce(sum(coalesce(cost_usd, (prompt_tokens * ${CEILING_PRICE.input}::numeric + completion_tokens * ${CEILING_PRICE.output}::numeric) / 1000000)), 0)`.as(
        'usd'
      )
    )
    .where('moderator_id', '=', moderatorId)
    .where('created_at', '>=', startOfUtcDay)
    .executeTakeFirstOrThrow();
  return Number(row.usd);
}

/** The same day's tokens split by model and direction, which is what a price applies to. */
export async function tokensTodayByModel(moderatorId: number): Promise<TokenRow[]> {
  const rows = await db()
    .selectFrom('assistant_turn')
    .select([
      'model',
      sql<string>`coalesce(sum(prompt_tokens), 0)`.as('prompt'),
      sql<string>`coalesce(sum(completion_tokens), 0)`.as('completion'),
    ])
    .where('moderator_id', '=', moderatorId)
    .where('created_at', '>=', startOfUtcDay)
    .groupBy('model')
    .orderBy('model')
    .execute();
  return rows.map((r) => ({
    model: r.model,
    promptTokens: Number(r.prompt),
    completionTokens: Number(r.completion),
  }));
}

export type AuditRow = Omit<Turn, 'sources'> & { chatTitle: string };

export async function listAuditTurns({
  moderatorId,
  before,
  limit = 50,
}: {
  moderatorId?: number | null;
  before?: number | null;
  limit?: number;
}): Promise<AuditRow[]> {
  return db()
    .selectFrom('assistant_turn as t')
    .innerJoin('assistant_chat as c', 'c.id', 't.chat_id')
    .select([
      't.id',
      't.chat_id as chatId',
      't.moderator_id as moderatorId',
      't.prompt',
      't.playbook_slug as playbookSlug',
      't.playbook_version as playbookVersion',
      't.status',
      't.tool_calls as toolCalls',
      't.answer',
      't.reasoning',
      't.unverified',
      't.error',
      't.model',
      't.prompt_tokens as promptTokens',
      't.completion_tokens as completionTokens',
      't.total_tokens as totalTokens',
      't.created_at as createdAt',
      't.finished_at as finishedAt',
      'c.title as chatTitle',
    ])
    .$if(!!moderatorId, (qb) => qb.where('t.moderator_id', '=', moderatorId!))
    .$if(!!before, (qb) => qb.where('t.id', '<', before!))
    .orderBy('t.id', 'desc')
    .limit(limit)
    .execute();
}

export type PlaybookVersion = {
  version: number;
  title: string;
  summary: string;
  body: string;
  status: PlaybookStatus;
  note: string | null;
  authorId: number;
  proposedByAssistant: boolean;
  sourceTurnId: number | null;
  createdAt: Date;
  reviewedBy: number | null;
  reviewedAt: Date | null;
};

export type Playbook = {
  slug: string;
  version: number;
  title: string;
  summary: string;
  body: string;
  /** Proposals waiting on a moderator. */
  pending: number;
};

/** Every live playbook at its current (highest accepted) version. */
export async function listPlaybooks(): Promise<Playbook[]> {
  const rows = await db()
    .selectFrom('assistant_playbook as p')
    .innerJoin('assistant_playbook_version as v', 'v.playbook_id', 'p.id')
    .select([
      'p.slug',
      'v.version',
      'v.title',
      'v.summary',
      'v.body',
      sql<number>`(SELECT count(*) FROM assistant_playbook_version pv
                    WHERE pv.playbook_id = p.id AND pv.status = 'proposed')`.as('pending'),
    ])
    .where('p.archived_at', 'is', null)
    .where(
      'v.version',
      '=',
      sql<number>`(SELECT max(cv.version) FROM assistant_playbook_version cv
                   WHERE cv.playbook_id = p.id AND cv.status = 'accepted')`
    )
    .orderBy('p.slug')
    .execute();
  return rows.map((r) => ({ ...r, pending: Number(r.pending) }));
}

export async function getPlaybook(slug: string): Promise<Playbook | null> {
  return (await listPlaybooks()).find((p) => p.slug === slug) ?? null;
}

export async function getPlaybookHistory(
  slug: string
): Promise<{ id: number; archived: boolean; versions: PlaybookVersion[] } | null> {
  const playbook = await db()
    .selectFrom('assistant_playbook')
    .select(['id', 'archived_at'])
    .where('slug', '=', slug)
    .executeTakeFirst();
  if (!playbook) return null;
  const versions = await db()
    .selectFrom('assistant_playbook_version')
    .select([
      'version',
      'title',
      'summary',
      'body',
      'status',
      'note',
      'author_id as authorId',
      'proposed_by_assistant as proposedByAssistant',
      'source_turn_id as sourceTurnId',
      'created_at as createdAt',
      'reviewed_by as reviewedBy',
      'reviewed_at as reviewedAt',
    ])
    .where('playbook_id', '=', playbook.id)
    .orderBy('version', 'desc')
    .execute();
  return { id: playbook.id, archived: !!playbook.archived_at, versions };
}

export type PlaybookDraft = { title: string; summary: string; body: string; note: string | null };

/**
 * A new version. A moderator's edit is `accepted` at once; the assistant's is `proposed` and waits.
 * Creates the playbook on first use of a slug. The version is max + 1 inside one transaction; the
 * primary key refuses a concurrent duplicate rather than letting two edits share a number.
 */
export async function addPlaybookVersion(input: {
  slug: string;
  draft: PlaybookDraft;
  authorId: number;
  byAssistant: boolean;
  sourceTurnId: number | null;
}): Promise<{ version: number; status: PlaybookStatus }> {
  const status: PlaybookStatus = input.byAssistant ? 'proposed' : 'accepted';
  return db()
    .transaction()
    .execute(async (trx) => {
      await trx
        .insertInto('assistant_playbook')
        .values({ slug: input.slug })
        .onConflict((oc) => oc.column('slug').doNothing())
        .execute();
      const playbook = await trx
        .selectFrom('assistant_playbook')
        .select('id')
        .where('slug', '=', input.slug)
        .executeTakeFirstOrThrow();
      const latest = await trx
        .selectFrom('assistant_playbook_version')
        .select(sql<number>`coalesce(max(version), 0)`.as('max'))
        .where('playbook_id', '=', playbook.id)
        .executeTakeFirst();
      const version = Number(latest?.max ?? 0) + 1;
      await trx
        .insertInto('assistant_playbook_version')
        .values({
          playbook_id: playbook.id,
          version,
          title: input.draft.title,
          summary: input.draft.summary,
          body: input.draft.body,
          note: input.draft.note,
          status,
          author_id: input.authorId,
          proposed_by_assistant: input.byAssistant,
          source_turn_id: input.sourceTurnId,
          reviewed_by: input.byAssistant ? null : input.authorId,
          reviewed_at: input.byAssistant ? null : sql`now()`,
        })
        .execute();
      return { version, status };
    });
}

/**
 * Playbooks the assistant is not given: archived, or with no accepted version (drafts, rejections).
 * The Playbooks page still lists them, or they could not be reached and their names not reused.
 */
export async function listUnservedPlaybooks(): Promise<
  { slug: string; title: string; pending: number; archived: boolean }[]
> {
  const rows = await db()
    .selectFrom('assistant_playbook as p')
    .innerJoin('assistant_playbook_version as v', 'v.playbook_id', 'p.id')
    .select([
      'p.slug',
      sql<string>`(array_agg(v.title ORDER BY v.version DESC))[1]`.as('title'),
      sql<number>`count(*) FILTER (WHERE v.status = 'proposed')`.as('pending'),
      sql<boolean>`p.archived_at IS NOT NULL`.as('archived'),
    ])
    .groupBy(['p.slug', 'p.archived_at'])
    .having(sql<boolean>`p.archived_at IS NOT NULL OR bool_and(v.status <> 'accepted')`)
    .orderBy('p.slug')
    .execute();
  return rows.map((r) => ({ ...r, pending: Number(r.pending) }));
}

/**
 * Accept or reject a proposal. `false` when that version is not a pending proposal, or (to accept)
 * when a later version is already accepted: the current text is the highest accepted version, so
 * accepting an older draft would report success and change nothing.
 */
export async function reviewProposal(input: {
  slug: string;
  version: number;
  accept: boolean;
  reviewerId: number;
}): Promise<boolean> {
  const result = await db()
    .updateTable('assistant_playbook_version')
    .set({
      status: input.accept ? 'accepted' : 'rejected',
      reviewed_by: input.reviewerId,
      reviewed_at: sql`now()`,
    })
    .where(
      'playbook_id',
      '=',
      db().selectFrom('assistant_playbook').select('id').where('slug', '=', input.slug)
    )
    .where('version', '=', input.version)
    .where('status', '=', 'proposed')
    .$if(input.accept, (qb) =>
      qb.where(
        sql<boolean>`version > coalesce((SELECT max(a.version) FROM assistant_playbook_version a
          WHERE a.playbook_id = assistant_playbook_version.playbook_id AND a.status = 'accepted'), 0)`
      )
    )
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

export async function setPlaybookArchived(slug: string, archived: boolean): Promise<boolean> {
  const result = await db()
    .updateTable('assistant_playbook')
    .set({ archived_at: archived ? sql`now()` : null })
    .where('slug', '=', slug)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

export type ToolRequest = {
  id: number;
  chatId: number;
  turnId: number | null;
  moderatorId: number;
  need: string;
  reason: string;
  example: string | null;
  conversation: { prompt: string; answer: string | null }[];
  status: ToolRequestStatus;
  response: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
};

export async function fileToolRequest(input: {
  chatId: number;
  turnId: number;
  moderatorId: number;
  need: string;
  reason: string;
  example: string | null;
  conversation: { prompt: string; answer: string | null }[];
}): Promise<number> {
  const row = await db()
    .insertInto('assistant_tool_request')
    .values({
      chat_id: input.chatId,
      turn_id: input.turnId,
      moderator_id: input.moderatorId,
      need: input.need,
      reason: input.reason,
      example: input.example,
      conversation: sql`${JSON.stringify(input.conversation)}::jsonb`,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function listToolRequests(limit = 100): Promise<ToolRequest[]> {
  return db()
    .selectFrom('assistant_tool_request')
    .select([
      'id',
      'chat_id as chatId',
      'turn_id as turnId',
      'moderator_id as moderatorId',
      'need',
      'reason',
      'example',
      'conversation',
      'status',
      'response',
      'created_at as createdAt',
      'resolved_at as resolvedAt',
    ])
    .orderBy('id', 'desc')
    .limit(limit)
    .execute();
}
