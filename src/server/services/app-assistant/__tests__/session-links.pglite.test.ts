import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';
import {
  upsertSessionLink,
  type AssistantTurnReport,
} from '~/server/services/app-assistant/session-tracing.service';

/**
 * The chat ↔ app link upsert against a real database built from the MIGRATION FILE ITSELF (the one
 * a human applies), so the unique key the upsert's ON CONFLICT names is the one the table has.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const MIGRATION = readFileSync(
  fileURLToPath(
    new URL(
      '../../../../../packages/civitai-db-schema/prisma/migrations/20271124120000_app_assistant_session_links/migration.sql',
      import.meta.url
    )
  ),
  'utf8'
);

let h: Awaited<ReturnType<typeof startPglitePrisma>>;

beforeAll(async () => {
  h = await startPglitePrisma(`
    CREATE TABLE "User" (id integer PRIMARY KEY);
    INSERT INTO "User" VALUES (7301), (7402);
    ${MIGRATION}
  `);
});
afterAll(() => h?.stop());
beforeEach(async () => {
  await h.pg.exec('DELETE FROM "app_assistant_session_links"');
});

// Pairwise-distinct users, chats, apps, runs, Buzz and times.
const base: AssistantTurnReport & { appSlug: string } = {
  userId: 7301,
  conversationId: 'conv-link-a',
  appSlug: 'link-app-one',
  seq: 1,
  runId: 'run-first',
  model: 'model-alpha',
  status: 'done',
  buzz: 3.25,
  toolCalls: {},
  durationMs: 1000,
  startedAt: new Date('2026-11-20T09:00:00.000Z'),
  endedAt: new Date('2026-11-20T09:00:05.000Z'),
};

async function rows() {
  const { rows } = await h.pg.query<{
    user_id: number;
    conversation_id: string;
    app_slug: string;
    turn_count: number;
    buzz_total: number;
    last_model: string;
    last_run_id: string;
    last_seq: number;
    first_seen_at: Date;
    last_seen_at: Date;
  }>(
    `SELECT user_id, conversation_id, app_slug, turn_count, buzz_total, last_model, last_run_id,
            last_seq, first_seen_at, last_seen_at
     FROM app_assistant_session_links ORDER BY user_id, conversation_id, app_slug`
  );
  return rows;
}

describe('upsertSessionLink', () => {
  it('a first turn inserts one row with its own times, model, Buzz and run', async () => {
    await upsertSessionLink(h.prisma, base);
    expect(await rows()).toEqual([
      {
        user_id: 7301,
        conversation_id: 'conv-link-a',
        app_slug: 'link-app-one',
        turn_count: 1,
        buzz_total: 3.25,
        last_model: 'model-alpha',
        last_run_id: 'run-first',
        last_seq: 1,
        first_seen_at: new Date('2026-11-20T09:00:00.000Z'),
        last_seen_at: new Date('2026-11-20T09:00:05.000Z'),
      },
    ]);
  });

  it('the same run reported twice counts once: idempotent on the run', async () => {
    await upsertSessionLink(h.prisma, base);
    await upsertSessionLink(h.prisma, base);
    expect(await rows()).toMatchObject([{ turn_count: 1, buzz_total: 3.25 }]);
  });

  it('a later run adds a turn and its Buzz, and moves last-seen, the model and the seq', async () => {
    await upsertSessionLink(h.prisma, base);
    await upsertSessionLink(h.prisma, {
      ...base,
      seq: 2,
      runId: 'run-second',
      model: 'model-beta',
      buzz: 10.5,
      startedAt: new Date('2026-11-20T09:10:00.000Z'),
      endedAt: new Date('2026-11-20T09:12:00.000Z'),
    });
    expect(await rows()).toEqual([
      expect.objectContaining({
        turn_count: 2,
        buzz_total: 13.75,
        last_model: 'model-beta',
        last_run_id: 'run-second',
        last_seq: 2,
        first_seen_at: new Date('2026-11-20T09:00:00.000Z'),
        last_seen_at: new Date('2026-11-20T09:12:00.000Z'),
      }),
    ]);
  });

  it('a late report of an earlier turn never moves last-seen back, and pulls first-seen earlier', async () => {
    await upsertSessionLink(h.prisma, base);
    await upsertSessionLink(h.prisma, {
      ...base,
      runId: 'run-late',
      startedAt: new Date('2026-11-20T08:00:00.000Z'),
      endedAt: new Date('2026-11-20T08:00:30.000Z'),
    });
    expect(await rows()).toMatchObject([
      {
        first_seen_at: new Date('2026-11-20T08:00:00.000Z'),
        last_seen_at: new Date('2026-11-20T09:00:05.000Z'),
      },
    ]);
  });

  it('one row per app a chat works on, and per user: the same conversation id of another user is not theirs', async () => {
    await upsertSessionLink(h.prisma, base);
    await upsertSessionLink(h.prisma, { ...base, appSlug: 'link-app-two', runId: 'run-other-app' });
    await upsertSessionLink(h.prisma, { ...base, userId: 7402, runId: 'run-other-user' });
    expect((await rows()).map((row) => [row.user_id, row.app_slug, row.turn_count])).toEqual([
      [7301, 'link-app-one', 1],
      [7301, 'link-app-two', 1],
      [7402, 'link-app-one', 1],
    ]);
  });
});
