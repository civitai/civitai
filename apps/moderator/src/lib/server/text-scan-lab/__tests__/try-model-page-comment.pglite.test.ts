import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as HarnessClient from '$lib/server/text-scan-lab/harness-client';
import type { Reader } from '$lib/server/chat-read-audit';
import { freshPglite } from '../../../../test/pglite';
import { pgliteDialect } from '../../__tests__/abuse-detection-pglite.harness';

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));
vi.mock('$lib/server/db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    return dbHandle.current;
  },
}));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

const harness = vi.hoisted(() => ({ scanTexts: vi.fn(), composeEntities: vi.fn() }));
vi.mock('$lib/server/text-scan-lab/harness-client', async (importOriginal) => ({
  ...(await importOriginal<typeof HarnessClient>()),
  ...harness,
}));
vi.mock('$lib/server/chat-read-audit', () => ({ recordChatMessageReads: vi.fn(async () => {}) }));

const { runTry } = await import('../try');

let db: PGlite;

beforeEach(async () => {
  vi.clearAllMocks();
  db = await freshPglite();
  await db.exec(`
    CREATE TABLE "CommentV3" ("id" INTEGER PRIMARY KEY, "entityType" TEXT NOT NULL,
      "legacyV1Id" INTEGER);
    INSERT INTO "CommentV3" VALUES
      (9055, 'model', 55),
      -- An image comment that happens to carry old id 88: a model page never names it.
      (9088, 'image', 88);
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
  harness.composeEntities.mockImplementation((_t: string, ids: number[]) =>
    Promise.resolve(
      ids.map((entityId) => ({
        entityId,
        ok: true,
        fields: [{ heading: 'Comment', text: `comment ${entityId}` }],
        text: '',
        userId: null,
      }))
    )
  );
  harness.scanTexts.mockImplementation((_type: string, texts: { key: string }[]) =>
    Promise.resolve({
      system: 'SYS',
      results: texts.map((t) => ({
        key: t.key,
        ok: true,
        workflowId: 'wf',
        promptIds: {},
        output: {},
        elapsedMs: 1,
      })),
    })
  );
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

const tryInput = (input: string) => {
  const data = new FormData();
  data.append('input', input);
  return runTry(77 as Reader, data);
};
const tryLink = (highlight: number) =>
  tryInput(`https://civitai.com/models/1?dialog=commentThread&highlight=${highlight}`);

describe('a model-page comment link, which names a comment by its old id', () => {
  it('is judged as the CommentV3 comment carrying that old id', async () => {
    await tryLink(55);
    expect(harness.composeEntities).toHaveBeenCalledWith('CommentV3', [9055]);
  });

  it('passes an id with no old-id row through as the CommentV3 id', async () => {
    await tryLink(77);
    expect(harness.composeEntities).toHaveBeenCalledWith('CommentV3', [77]);
  });

  it("never resolves to another surface's comment that carries the same old id", async () => {
    await tryLink(88);
    expect(harness.composeEntities).toHaveBeenCalledWith('CommentV3', [88]);
  });

  it('leaves a /comments/ link, which already names the CommentV3 id, unresolved', async () => {
    await tryInput('https://civitai.com/comments/55');
    expect(harness.composeEntities).toHaveBeenCalledWith('CommentV3', [55]);
  });
});
