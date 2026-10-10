import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as Award from '~/server/events/points/award';

// DECISION: the daily-challenge judge is an automated account and must never earn anyone event
// points ("event points are for people engaging"). Its userId comes from config, so the engine
// cannot recognise it; the judge's own call sites opt out with `eventPoints: false`.
// If you are about to delete this because the flag looks unused: the bot reacts and comments on
// every challenge entry, so dropping it hands every hatted entry free reaction and comment points.

const { awardEventPoints, hatted } = vi.hoisted(() => ({
  awardEventPoints: vi.fn(async (..._a: unknown[]) => undefined),
  hatted: new Set<string>(),
}));

vi.mock('~/server/events/points/award', async (importOriginal) => ({
  ...(await importOriginal<typeof Award>()),
  awardEventPoints,
  isHattedEntity: (entityType: string, entityId: number) => hatted.has(`${entityType}:${entityId}`),
}));
vi.mock('~/server/db/db-lag-helpers', () => ({ getDbWithoutLag: async () => dbMock.dbWrite }));
vi.mock('~/server/services/block-check.service', () => ({
  getBlockCheckOwnerIdsForComment: vi.fn(async () => []),
  getBlockCheckOwnerIdsForReply: vi.fn(async () => []),
  throwIfBlockedByEntityOwner: vi.fn(async () => undefined),
  throwIfBlockedByOwners: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedCommentContent: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/sticker.service', () => ({
  spendStickerUses: vi.fn(async () => []),
  recordStickerUsage: vi.fn(),
}));
vi.mock('~/server/services/text-scan/scam-scan-queue', () => ({ queueScamScan: vi.fn() }));

import { upsertComment } from '~/server/services/commentsv2.service';
import { toggleReaction } from '~/server/services/reaction.service';

const db = dbMock.dbWrite;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  hatted.clear();
  hatted.add('Image:7');
  db.imageReaction.findFirst.mockResolvedValue(null);
  db.thread.findUnique.mockResolvedValue({ id: 70, locked: false });
  db.commentV2.create.mockResolvedValue({ id: 456, threadId: 70 });
});

describe('eventPoints: false', () => {
  it.each([true, false])('toggleReaction awards only when eventPoints is %s', async (on) => {
    await toggleReaction({
      entityType: 'image',
      entityId: 7,
      userId: 5,
      reaction: 'Like',
      eventPoints: on,
    });
    await settle();
    expect(awardEventPoints).toHaveBeenCalledTimes(on ? 1 : 0);
  });

  it.each([true, false])('upsertComment awards only when eventPoints is %s', async (on) => {
    await upsertComment({
      userId: 5,
      entityType: 'image',
      entityId: 7,
      content: 'hi',
      eventPoints: on,
    });
    await settle();
    expect(awardEventPoints).toHaveBeenCalledTimes(on ? 1 : 0);
  });

  it('never reaches the comment row', async () => {
    await upsertComment({
      userId: 5,
      entityType: 'image',
      entityId: 7,
      content: 'hi',
      eventPoints: false,
    });
    const [{ data }] = db.commentV2.create.mock.calls[0] as [{ data: Record<string, unknown> }];
    expect(data).not.toHaveProperty('eventPoints');
  });
});

// The judge's call sites. Read from source because driving the judging job end to end needs the
// whole challenge pipeline; each call's argument object must carry the opt-out. The counts are
// exact, so a call added, removed or rewritten without an object literal fails here rather than
// slipping past the walk.
const JUDGE_CALLS: Record<string, Record<'toggleReaction' | 'upsertComment', number>> = {
  'src/server/jobs/daily-challenge-processing.ts': { toggleReaction: 1, upsertComment: 1 },
  'src/pages/api/mod/daily-challenge/re-review.ts': { toggleReaction: 0, upsertComment: 1 },
};

// Comments out, so a commented-out `// eventPoints: false,` cannot satisfy the check.
const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

function callArguments(source: string, fn: string) {
  const calls: string[] = [];
  let at = source.indexOf(`${fn}({`);
  while (at !== -1) {
    const start = at + fn.length + 1;
    let depth = 0;
    let end = start;
    for (; end < source.length; end++) {
      if (source[end] === '{') depth++;
      else if (source[end] === '}' && --depth === 0) break;
    }
    calls.push(source.slice(start, end + 1));
    at = source.indexOf(`${fn}({`, end);
  }
  return calls;
}

describe("the judge's call sites opt out", () => {
  it.each(Object.entries(JUDGE_CALLS))(
    '%s passes eventPoints: false on every reaction and comment',
    (file, expected) => {
      const source = withoutComments(readFileSync(join(process.cwd(), file), 'utf8'));
      for (const fn of ['toggleReaction', 'upsertComment'] as const) {
        const calls = callArguments(source, fn);
        expect({ fn, literalCalls: calls.length }).toEqual({ fn, literalCalls: expected[fn] });
        // Every call of any shape, so `fn(args)` cannot hide from the literal walk above.
        expect({ fn, allCalls: source.split(`${fn}(`).length - 1 }).toEqual({
          fn,
          allCalls: expected[fn],
        });
        for (const args of calls) expect(args).toMatch(/^\s*eventPoints: false,$/m);
      }
    }
  );
});
