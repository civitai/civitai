import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as Award from '~/server/events/points/award';
import type * as HotReads5 from '@civitai/db-queries/hot-reads-5';

// DECISION: the daily-challenge judge is an automated account and must never earn anyone event
// points ("event points are for people engaging"). Its userId comes from config, so the engine
// cannot recognise it; the judge's reaction opts out with `eventPoints: false`, and its comment
// (`writeJudgeComment`) never reaches the controller that awards them.
// If you are about to delete this because the flag looks unused: the bot reacts on every challenge
// entry, so dropping it hands every hatted entry free reaction points.

const { awardEventPoints, hatted } = vi.hoisted(() => ({
  awardEventPoints: vi.fn(async (..._a: unknown[]) => undefined),
  hatted: new Set<string>(),
}));

vi.mock('~/server/events/points/award', async (importOriginal) => ({
  ...(await importOriginal<typeof Award>()),
  awardEventPoints,
  isHattedEntity: (entityType: string, entityId: number) => hatted.has(`${entityType}:${entityId}`),
  isHattedEntityOnceLoaded: async (entityType: string, entityId: number) =>
    hatted.has(`${entityType}:${entityId}`),
}));
// The image reaction's existence check, a Kysely read on the client the lag decision picks: the
// tests answer it directly, so the client is a stand-in.
const { imageReactionId } = vi.hoisted(() => ({ imageReactionId: vi.fn() }));
vi.mock('@civitai/db-queries/hot-reads-5', async (importOriginal) => ({
  ...(await importOriginal<typeof HotReads5>()),
  getImageReactionId: imageReactionId,
}));
vi.mock('~/server/db/db-lag-helpers', () => ({
  getDbWithoutLag: async () => dbMock.dbWrite,
  getKyselyWithoutLag: async () => ({}),
}));
vi.mock('~/server/services/block-check.service', () => ({
  throwIfBlockedByEntityOwner: vi.fn(async () => undefined),
}));

import { toggleReaction } from '~/server/services/reaction.service';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  hatted.clear();
  hatted.add('Image:7');
  imageReactionId.mockResolvedValue(undefined);
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
});

// The judge's call sites. Read from source because driving the judging job end to end needs the
// whole challenge pipeline; each call's argument object must carry the opt-out. The counts are
// exact, so a call added, removed or rewritten without an object literal fails here rather than
// slipping past the walk.
const JUDGE_CALLS: Record<string, Record<'toggleReaction', number>> = {
  'src/server/services/challenge-judge-review.service.ts': { toggleReaction: 1 },
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
    '%s passes eventPoints: false on every reaction',
    (file, expected) => {
      const source = withoutComments(readFileSync(join(process.cwd(), file), 'utf8'));
      for (const fn of ['toggleReaction'] as const) {
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
