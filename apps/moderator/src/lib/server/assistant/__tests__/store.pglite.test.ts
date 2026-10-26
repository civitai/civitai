import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../../test/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executableSchemaSql, pgliteDialect } from '../../__tests__/abuse-detection-pglite.harness';

/**
 * The assistant's store, run unmodified against `apps/moderator/assistant/schema.sql` applied to an
 * in-process Postgres. What is pinned here is which rows a moderator can reach and which playbook text
 * the assistant is given — both claims about rows.
 */

const SCHEMA = join(dirname(fileURLToPath(import.meta.url)), '../../../../../assistant/schema.sql');

let pg: PGlite;
let kysely: Kysely<unknown>;
vi.mock('$lib/server/moderator-db', () => ({ getModeratorDb: () => kysely }));

const store = await import('../store');

beforeEach(async () => {
  pg = await freshPglite();
  await pg.exec(executableSchemaSql(readFileSync(SCHEMA, 'utf8')));
  kysely = new Kysely({ dialect: pgliteDialect(pg) });
});
afterEach(async () => {
  await pg.close();
});

const NO_COST = { usd: 0, source: 'list' } as const;

const draft = (title: string) => ({
  title,
  summary: 'When to use this one.',
  body: 'Step one. Step two. Step three.',
  note: null,
});

describe('chats', () => {
  it('are private to the moderator who opened them', async () => {
    const id = await store.createChat({
      moderatorId: 1,
      title: 'mine',
      seedUserId: 5,
      seedReportId: null,
    });
    expect(await store.getChat(id, 1)).toMatchObject({ title: 'mine', seedUserId: 5 });
    expect(await store.getChat(id, 2)).toBeNull();
    expect(await store.listChats(2)).toEqual([]);
    expect(await store.archiveChat(id, 2)).toBe(false);
    expect(await store.renameChat(id, 2, 'stolen')).toBe(false);
    expect((await store.getChat(id, 1))?.title).toBe('mine');
  });

  it('leave the list when archived and keep their turns for the audit', async () => {
    const id = await store.createChat({
      moderatorId: 1,
      title: 'c',
      seedUserId: null,
      seedReportId: null,
    });
    await store.startTurn({
      chatId: id,
      moderatorId: 1,
      prompt: 'q',
      playbookSlug: null,
      playbookVersion: null,
      model: 'm',
    });
    expect(await store.archiveChat(id, 1)).toBe(true);
    expect(await store.listChats(1)).toEqual([]);
    expect(await store.listAuditTurns({})).toHaveLength(1);
  });
});

describe('Investigate', () => {
  it('returns to the open chat on the same account and report, and only that one', async () => {
    const open = (seedUserId: number | null, seedReportId: number | null, moderatorId = 1) =>
      store.createChat({ moderatorId, title: 'c', seedUserId, seedReportId });
    const onAccount = await open(5, null);
    const onReport = await open(5, 77);
    await open(5, null, 2);
    expect(await store.findSeededChat(1, { userId: 5, reportId: null })).toBe(onAccount);
    expect(await store.findSeededChat(1, { userId: 5, reportId: 77 })).toBe(onReport);
    expect(await store.findSeededChat(1, { userId: 6, reportId: null })).toBeNull();
    await store.archiveChat(onAccount, 1);
    expect(await store.findSeededChat(1, { userId: 5, reportId: null })).toBeNull();
  });
});

describe('turns', () => {
  it('allow one running turn per moderator, across chats, so concurrent turns cannot outrun the cap', async () => {
    const chat = (moderatorId: number) =>
      store.createChat({ moderatorId, title: 'c', seedUserId: null, seedReportId: null });
    const [a, b, other] = [await chat(1), await chat(1), await chat(2)];
    const start = (chatId: number, moderatorId = 1) =>
      store.startTurn({
        chatId,
        moderatorId,
        prompt: 'q',
        playbookSlug: null,
        playbookVersion: null,
        model: 'm',
      });
    await start(a);
    await expect(start(a)).rejects.toMatchObject({ code: '23505' });
    await expect(start(b)).rejects.toMatchObject({ code: '23505' });
    await expect(start(other, 2)).resolves.toBeGreaterThan(0);
    expect(await store.hasRunningTurn(1, 60_000)).toBe(true);
    expect(await store.hasRunningTurn(3, 60_000)).toBe(false);
  });

  it('give each chat its own address-label key', async () => {
    const chat = () =>
      store.createChat({ moderatorId: 1, title: 'c', seedUserId: null, seedReportId: null });
    const [a, b] = [await chat(), await chat()];
    const [saltA, saltB] = [await store.getMaskSalt(a), await store.getMaskSalt(b)];
    expect(saltA).toMatch(/^[0-9a-f-]{36}$/);
    expect(saltA).not.toBe(saltB);
    expect(await store.getChat(a, 1)).not.toHaveProperty('maskSalt');
  });

  it('count every token a moderator spent today toward the cap, across chats', async () => {
    for (const moderatorId of [1, 1, 2]) {
      const chatId = await store.createChat({
        moderatorId,
        title: 'c',
        seedUserId: null,
        seedReportId: null,
      });
      const turnId = await store.startTurn({
        chatId,
        moderatorId,
        prompt: 'q',
        playbookSlug: null,
        playbookVersion: null,
        model: 'm',
      });
      await store.finishTurn(
        turnId,
        {
          status: 'done',
          toolCalls: [],
          sources: [],
          answer: 'a',
          reasoning: null,
          unverified: [],
          error: null,
          promptTokens: 100,
          completionTokens: 50,
        },
        NO_COST
      );
    }
    expect(await store.tokensToday(1)).toBe(300);
    expect(await store.tokensToday(2)).toBe(150);
  });

  it("split today's tokens by model, for this moderator only", async () => {
    const turn = async (moderatorId: number, model: string, prompt: number, completion: number) => {
      const chatId = await store.createChat({
        moderatorId,
        title: 'c',
        seedUserId: null,
        seedReportId: null,
      });
      const turnId = await store.startTurn({
        chatId,
        moderatorId,
        prompt: 'q',
        playbookSlug: null,
        playbookVersion: null,
        model,
      });
      await store.finishTurn(
        turnId,
        {
          status: 'done',
          toolCalls: [],
          sources: [],
          answer: 'a',
          reasoning: null,
          unverified: [],
          error: null,
          promptTokens: prompt,
          completionTokens: completion,
        },
        NO_COST
      );
      return turnId;
    };
    await turn(1, 'b-model', 10, 1);
    await turn(1, 'a-model', 20, 2);
    await turn(1, 'a-model', 30, 3);
    await turn(2, 'a-model', 999, 999);
    const yesterday = await turn(1, 'a-model', 500, 500);
    await pg.query(
      `UPDATE assistant_turn SET created_at = now() - interval '2 days' WHERE id = $1`,
      [yesterday]
    );
    expect(await store.tokensTodayByModel(1)).toEqual([
      { model: 'a-model', promptTokens: 50, completionTokens: 5 },
      { model: 'b-model', promptTokens: 10, completionTokens: 1 },
    ]);
  });

  it('close out a turn abandoned mid-run so the moderator can ask again', async () => {
    const id = await store.createChat({
      moderatorId: 1,
      title: 'c',
      seedUserId: null,
      seedReportId: null,
    });
    await store.startTurn({
      chatId: id,
      moderatorId: 1,
      prompt: 'q',
      playbookSlug: null,
      playbookVersion: null,
      model: 'm',
    });
    expect(await store.hasRunningTurn(1, 60_000)).toBe(true);
    await pg.query(`UPDATE assistant_turn SET created_at = now() - interval '1 hour'`);
    expect(await store.hasRunningTurn(1, 60_000)).toBe(false);
    expect((await store.listTurns(id))[0]).toMatchObject({ status: 'error' });
  });

  it('stores the audit trail it is given', async () => {
    const id = await store.createChat({
      moderatorId: 1,
      title: 'c',
      seedUserId: null,
      seedReportId: null,
    });
    const turnId = await store.startTurn({
      chatId: id,
      moderatorId: 1,
      prompt: 'q',
      playbookSlug: 'p',
      playbookVersion: 3,
      model: 'm',
    });
    const toolCalls = [
      {
        name: 'get_user_dossier',
        args: { userId: 5 },
        rows: 1,
        truncated: false,
        ms: 9,
        error: null,
      },
    ];
    const sources = [{ ref: 'user:5', href: '/retool/user-lookup?q=5', label: 'five' }];
    await store.finishTurn(
      turnId,
      {
        status: 'done',
        toolCalls,
        sources,
        answer: 'see [user:5]',
        reasoning: '- look up 5',
        unverified: ['user:6'],
        error: null,
        promptTokens: 7,
        completionTokens: 3,
      },
      NO_COST
    );
    expect((await store.listTurns(id))[0]).toMatchObject({
      prompt: 'q',
      playbookSlug: 'p',
      playbookVersion: 3,
      toolCalls,
      sources,
      reasoning: '- look up 5',
      unverified: ['user:6'],
      totalTokens: 10,
    });
    expect((await store.listAuditTurns({}))[0]).toMatchObject({ reasoning: '- look up 5' });
    // Logged before rounds were kept: it reads back with no round, never as round 1.
    expect((await store.listTurns(id))[0].toolCalls[0]).not.toHaveProperty('round');
  });

  it('keeps the round each lookup was asked for in', async () => {
    const id = await store.createChat({
      moderatorId: 1,
      title: 'c',
      seedUserId: null,
      seedReportId: null,
    });
    const turnId = await store.startTurn({
      chatId: id,
      moderatorId: 1,
      prompt: 'q',
      playbookSlug: null,
      playbookVersion: null,
      model: 'm',
    });
    const call = { name: 'lookup', args: {}, rows: 1, truncated: false, ms: 1, error: null };
    await store.finishTurn(
      turnId,
      {
        status: 'done',
        toolCalls: [
          { ...call, round: 1 },
          { ...call, round: 2 },
        ],
        sources: [],
        answer: 'a',
        reasoning: null,
        unverified: [],
        error: null,
        promptTokens: 1,
        completionTokens: 1,
      },
      NO_COST
    );
    expect((await store.listTurns(id))[0].toolCalls.map((c) => c.round)).toEqual([1, 2]);
  });

  it('adds the reasoning column to a table created before it existed', async () => {
    // The file is re-run in place, so the ALTER must apply to an existing table and re-run cleanly.
    await pg.query(`ALTER TABLE assistant_turn DROP COLUMN reasoning`);
    await pg.exec(executableSchemaSql(readFileSync(SCHEMA, 'utf8')));
    await pg.exec(executableSchemaSql(readFileSync(SCHEMA, 'utf8')));
    const cols = await pg.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'assistant_turn' AND column_name = 'reasoning'`
    );
    expect(cols.rows).toHaveLength(1);
  });
});

describe('playbooks', () => {
  it('serve the newest ACCEPTED version, never a proposal', async () => {
    await store.addPlaybookVersion({
      slug: 'bots',
      draft: draft('v1'),
      authorId: 1,
      byAssistant: false,
      sourceTurnId: null,
    });
    const proposal = await store.addPlaybookVersion({
      slug: 'bots',
      draft: draft('poisoned'),
      authorId: 1,
      byAssistant: true,
      sourceTurnId: null,
    });
    expect(proposal).toEqual({ version: 2, status: 'proposed' });
    expect(await store.getPlaybook('bots')).toMatchObject({ title: 'v1', version: 1, pending: 1 });
    // A pending draft of a live playbook is reviewed from that playbook, not listed as a draft-only one.
    expect(await store.listUnservedPlaybooks()).toEqual([]);

    expect(
      await store.reviewProposal({ slug: 'bots', version: 2, accept: true, reviewerId: 9 })
    ).toBe(true);
    expect(await store.getPlaybook('bots')).toMatchObject({
      title: 'poisoned',
      version: 2,
      pending: 0,
    });
  });

  it('keep serving the current version when a proposal is rejected', async () => {
    await store.addPlaybookVersion({
      slug: 'bots',
      draft: draft('v1'),
      authorId: 1,
      byAssistant: false,
      sourceTurnId: null,
    });
    await store.addPlaybookVersion({
      slug: 'bots',
      draft: draft('v2'),
      authorId: 1,
      byAssistant: true,
      sourceTurnId: null,
    });
    expect(
      await store.reviewProposal({ slug: 'bots', version: 2, accept: false, reviewerId: 9 })
    ).toBe(true);
    expect(
      await store.reviewProposal({ slug: 'bots', version: 2, accept: true, reviewerId: 9 })
    ).toBe(false);
    expect((await store.getPlaybook('bots'))?.title).toBe('v1');
  });

  it('a playbook that exists only as a proposal is not served at all', async () => {
    await store.addPlaybookVersion({
      slug: 'new',
      draft: draft('draft'),
      authorId: 1,
      byAssistant: true,
      sourceTurnId: null,
    });
    expect(await store.getPlaybook('new')).toBeNull();
    expect(await store.listPlaybooks()).toEqual([]);
    // ...but the Playbooks page still lists it, so the draft can be reached and reviewed.
    expect(await store.listUnservedPlaybooks()).toEqual([
      { slug: 'new', title: 'draft', pending: 1, archived: false },
    ]);
  });

  it('refuse to accept a draft older than the version already accepted', async () => {
    const add = (title: string, byAssistant: boolean) =>
      store.addPlaybookVersion({
        slug: 'bots',
        draft: draft(title),
        authorId: 1,
        byAssistant,
        sourceTurnId: null,
      });
    await add('v1', false);
    await add('stale draft', true);
    await add('v3', false);
    expect(
      await store.reviewProposal({ slug: 'bots', version: 2, accept: true, reviewerId: 9 })
    ).toBe(false);
    expect((await store.getPlaybook('bots'))?.title).toBe('v3');
    expect(
      await store.reviewProposal({ slug: 'bots', version: 2, accept: false, reviewerId: 9 })
    ).toBe(true);
    expect(await store.listUnservedPlaybooks()).toEqual([]);
  });

  it('an archived playbook is not served', async () => {
    await store.addPlaybookVersion({
      slug: 'old',
      draft: draft('v1'),
      authorId: 1,
      byAssistant: false,
      sourceTurnId: null,
    });
    expect(await store.setPlaybookArchived('old', true)).toBe(true);
    expect(await store.getPlaybook('old')).toBeNull();
    // ...and stays reachable from the Playbooks page, to be restored.
    expect(await store.listUnservedPlaybooks()).toEqual([
      { slug: 'old', title: 'v1', pending: 0, archived: true },
    ]);
  });
});
