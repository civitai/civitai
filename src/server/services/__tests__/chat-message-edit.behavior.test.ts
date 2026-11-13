import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * An edit overwrites `ChatMessage.content`, so the text it replaced survives only in the row this
 * writes. Runs the committed migration, so the cascade and the column names are the real ones.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const MIGRATION = readFileSync(
  'packages/civitai-db-schema/prisma/migrations/20261126120000_chat_message_edit/migration.sql',
  'utf8'
);

const SENDER = 5;
const MODERATOR = 9;

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE "ChatMessage" (
      id int PRIMARY KEY,
      "userId" int NOT NULL,
      content text NOT NULL,
      "editedAt" timestamp(3),
      "deletedAt" timestamp(3)
    );
  `);
  await pg.exec(MIGRATION);
});

beforeEach(async () => {
  await pg.exec(`
    TRUNCATE "ChatMessage" CASCADE;
    INSERT INTO "ChatMessage" (id, "userId", content) VALUES (1, ${SENDER}, 'v1');
    INSERT INTO "ChatMessage" (id, "userId", content, "deletedAt") VALUES (2, ${SENDER}, 'gone', now());
  `);
  dbMock.dbWrite.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...v: unknown[]
  ) => {
    const flat = Prisma.sql(strings, ...(v as never[]));
    return (await pg.query(flat.text, flat.values as unknown[])).rows;
  }) as never);
});

const { editChatMessageContent } = await import('~/server/services/chat.service');

const edit = (messageId: number, content: string, editorId = SENDER) =>
  editChatMessageContent({ messageId, editorId, content, editedAt: new Date() });

const history = async (messageId: number) =>
  (
    await pg.query<{ editorId: number; previousContent: string }>(
      `SELECT "editorId", "previousContent" FROM "ChatMessageEdit" WHERE "messageId" = $1 ORDER BY id`,
      [messageId]
    )
  ).rows;

const content = async (id: number) =>
  (await pg.query<{ content: string }>(`SELECT content FROM "ChatMessage" WHERE id = $1`, [id]))
    .rows[0]?.content;

describe('editChatMessageContent', () => {
  it('keeps the replaced text and who replaced it, and writes the new text', async () => {
    expect(await edit(1, 'v2', MODERATOR)).toBe('v1');

    expect(await history(1)).toEqual([{ editorId: MODERATOR, previousContent: 'v1' }]);
    expect(await content(1)).toBe('v2');
  });

  it('chains across edits, so every version is recoverable', async () => {
    await edit(1, 'v2');
    await edit(1, 'v3');

    expect((await history(1)).map((r) => r.previousContent)).toEqual(['v1', 'v2']);
    expect(await content(1)).toBe('v3');
  });

  it('refuses a deleted message and records nothing', async () => {
    expect(await edit(2, 'rewritten')).toBeNull();

    expect(await history(2)).toEqual([]);
    expect(await content(2)).toBe('gone');
  });

  it('goes with the message when the message is hard-deleted', async () => {
    // Account deletion removes ChatMessage rows; their history must not outlive them.
    await edit(1, 'v2');
    await pg.exec(`DELETE FROM "ChatMessage" WHERE id = 1`);

    expect(await history(1)).toEqual([]);
  });
});
