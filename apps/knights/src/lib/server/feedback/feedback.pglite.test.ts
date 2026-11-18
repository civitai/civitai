import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  FEEDBACK_MESSAGE_MAX_LENGTH,
  FEEDBACK_RATE_LIMIT,
} from '@civitai/shared/feedback.constants';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { feedbackContext, submitFeedback } from './feedback.service';

let pg: PGlite;
let db: Kysely<DB>;

const NOW = new Date('2027-01-10T12:00:00Z');

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  // The table belongs to the main app's migrations; only the columns this writer touches are needed.
  await pg.exec(`CREATE TABLE "Feedback" (
    "id" SERIAL PRIMARY KEY,
    "area" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "message" TEXT NOT NULL,
    "context" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'new',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
});
afterAll(() => pg.close());
beforeEach(() => pg.exec(`TRUNCATE "Feedback" RESTART IDENTITY`));

const rows = async () =>
  (
    await pg.query<{
      area: string;
      userId: number;
      message: string;
      context: unknown;
      status: string;
    }>(`SELECT * FROM "Feedback" ORDER BY "id"`)
  ).rows;

const send = (message: unknown, userId = 7, now = NOW) =>
  submitFeedback(db, { userId, message, context: { path: '/play' }, now });

describe('submitFeedback', () => {
  it('files a knights row for the player with the trimmed message and its context', async () => {
    expect(await send('  the queue stalled  ')).toEqual({ ok: true });

    expect(await rows()).toEqual([
      expect.objectContaining({
        area: 'knights',
        userId: 7,
        message: 'the queue stalled',
        context: { path: '/play' },
        status: 'new',
      }),
    ]);
  });

  it.each([
    ['empty', ''],
    ['blank', '   \n '],
    ['not a string', 42],
  ])('refuses a message that is %s', async (_name, message) => {
    expect(await send(message)).toEqual({ ok: false, reason: 'invalid' });
    expect(await rows()).toEqual([]);
  });

  it('accepts a message at the limit and refuses one past it', async () => {
    expect(await send('x'.repeat(FEEDBACK_MESSAGE_MAX_LENGTH))).toEqual({ ok: true });
    expect(await send('x'.repeat(FEEDBACK_MESSAGE_MAX_LENGTH + 1))).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(await rows()).toHaveLength(1);
  });

  it('refuses past the hourly cap, per player, and lets the player back in when the window passes', async () => {
    for (let i = 0; i < FEEDBACK_RATE_LIMIT.max; i++)
      expect(await send(`report ${i}`)).toEqual({ ok: true });

    expect(await send('one too many')).toEqual({ ok: false, reason: 'rate-limited' });
    expect(await send('someone else', 8)).toEqual({ ok: true });
    expect(await rows()).toHaveLength(FEEDBACK_RATE_LIMIT.max + 1);

    const later = new Date(NOW.getTime() + (FEEDBACK_RATE_LIMIT.periodSeconds + 60) * 1000);
    expect(await send('after the window', 7, later)).toEqual({ ok: true });
  });

  it("does not count another area's rows against the cap", async () => {
    for (let i = 0; i < FEEDBACK_RATE_LIMIT.max; i++) {
      await pg.query(
        `INSERT INTO "Feedback" ("area","userId","message") VALUES ('site-bug-report', 7, 'x')`
      );
    }
    expect(await send('still fine')).toEqual({ ok: true });
  });
});

describe('feedbackContext', () => {
  it('keeps the path, player standing and user agent, and drops what is not a Knights path', () => {
    expect(
      feedbackContext({ path: '/codex', userAgent: 'UA/1', status: { rank: 'Knight', level: 12 } })
    ).toEqual({ path: '/codex', userAgent: 'UA/1', rank: 'Knight', level: 12 });
    expect(feedbackContext({ path: 'https://evil.test/x', userAgent: null, status: null })).toEqual(
      {}
    );
  });

  it('clips an over-long path and user agent to what the main app accepts', () => {
    const context = feedbackContext({
      path: '/' + 'a'.repeat(500),
      userAgent: 'u'.repeat(500),
      status: null,
    });
    expect(context.path).toHaveLength(300);
    expect(context.userAgent).toHaveLength(200);
  });
});
