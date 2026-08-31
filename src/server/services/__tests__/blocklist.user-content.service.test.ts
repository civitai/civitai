import { vi, describe, it, expect, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';

import { throwOnBlockedUserContent } from '../blocklist.service';
import { BlocklistType } from '~/server/common/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

void dbMock;

const getFliptBoolean = vi.hoisted(() => vi.fn(async (): Promise<boolean> => false));
vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: { USER_CONTENT_PATTERN_ENFORCE: 'user-content-pattern-enforce' },
  getFliptBoolean,
}));

const redisGet = redisMock.redis.get;
const logToAxiom = loggingMock.logToAxiom;

/** Same keyed stub as the comment-content suite: this guard reads BOTH lists. */
function setLists({ domains = [], patterns = [] }: { domains?: string[]; patterns?: string[] }) {
  redisGet.mockImplementation(async (key: string) => {
    if (key.endsWith(`:${BlocklistType.LinkDomain}`))
      return JSON.stringify({ type: BlocklistType.LinkDomain, data: domains });
    if (key.endsWith(`:${BlocklistType.MessagePattern}`))
      return JSON.stringify({ type: BlocklistType.MessagePattern, data: patterns });
    return null;
  });
}

const rejection = async (
  content: Parameters<typeof throwOnBlockedUserContent>[0],
  options?: Parameters<typeof throwOnBlockedUserContent>[1]
) => {
  try {
    await throwOnBlockedUserContent(content, options);
  } catch (e) {
    return e;
  }
  return null;
};

const patternLogs = () =>
  logToAxiom.mock.calls.filter(([entry]) => entry?.name === 'user-content-pattern-match');

const PHISH = 'phish-verify592807.example';

describe('throwOnBlockedUserContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getFliptBoolean.mockResolvedValue(false);
  });

  it('lets ordinary content through', async () => {
    setLists({ domains: ['blocked.example'], patterns: [PHISH] });
    await expect(
      throwOnBlockedUserContent('<p>A LoRA trained on my own photos.</p>')
    ).resolves.toBeUndefined();
    expect(patternLogs()).toHaveLength(0);
  });

  describe('the link half throws, flag or no flag', () => {
    /**
     * 868kw6t61. These surfaces already enforced the link list before this guard existed, so
     * anything that stops them throwing on a link hit is a regression on a live control — not a
     * cautious rollout. The flag governs the PATTERN half and must not reach this one.
     *
     * Delete the `onLinkMatch` wiring and both assertions below fail naming the domain.
     */
    it.each([false, true])('rejects a blocked domain with enforcement=%s', async (enforce) => {
      getFliptBoolean.mockResolvedValue(enforce);
      setLists({ domains: ['blocked.example'] });

      const error = await rejection('<p>see https://blocked.example/x</p>');
      expect(error).toBeInstanceOf(TRPCError);
      expect((error as TRPCError).message).toContain('blocked.example');
    });

    /**
     * The guard reads several normalised forms of the text, not the stored string alone, so a
     * blocked domain is matched however the editor happens to have marked it up. Revert to a
     * single-form scan and this fails with `null` — no rejection at all — rather than a timeout.
     */
    it('matches a blocked domain across the markup around it', async () => {
      setLists({ domains: ['blocked.example'] });
      const error = await rejection('<p>see https://bloc<strong>k</strong>ed.example/x</p>');
      expect(error).toBeInstanceOf(TRPCError);
    });
  });

  describe('the pattern half is flag-gated', () => {
    /**
     * The shipped default. A pattern hit on these surfaces is RECORDED and the write proceeds:
     * a false positive here costs a creator a publish, and the rate is unmeasured until this has
     * run. Flip `USER_CONTENT_PATTERN_ENFORCE` to enforce.
     *
     * 🔴 Both halves of this assertion are load-bearing. `resolves` alone would also pass if the
     * pattern were never checked at all, which is the state this whole PR exists to end — the
     * log assertion is what distinguishes "recorded, not enforced" from "not looked for".
     */
    it('records a pattern hit without blocking when enforcement is off', async () => {
      setLists({ patterns: [PHISH] });

      await expect(
        throwOnBlockedUserContent(`<p>${PHISH}</p>`, { surface: 'model' })
      ).resolves.toBeUndefined();

      const logs = patternLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0][0].details).toMatchObject({ surface: 'model', matched: PHISH });
    });

    it('throws on a pattern hit when enforcement is on', async () => {
      getFliptBoolean.mockResolvedValue(true);
      setLists({ patterns: [PHISH] });

      const error = await rejection(`<p>${PHISH}</p>`);
      expect(error).toBeInstanceOf(TRPCError);
      expect((error as TRPCError).message).toBe('Content blocked by content filter');
    });

    /**
     * Telemetry survives the flip. Logging only the un-enforced hits would delete the signal at
     * the moment enforcement starts, which is precisely when the before/after comparison the
     * staged rollout exists to produce becomes readable.
     */
    it('still records the hit when it enforces', async () => {
      getFliptBoolean.mockResolvedValue(true);
      setLists({ patterns: [PHISH] });

      await rejection(`<p>${PHISH}</p>`, { surface: 'model' });

      const logs = patternLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0][0].details).toMatchObject({ surface: 'model', enforced: true });
    });

    /**
     * There is deliberately NO test for "the flag read throws". `getBoolean` swallows its own
     * failures and returns `false`, so an unreachable Flipt already lands on the recording branch
     * above. A test using `mockRejectedValue` would assert that the MOCK rejects and nothing
     * about production — it passed against an unreachable `catch` here until a reviewer read the
     * client. The measured fact belongs in the code comment, and it is there.
     */

    /**
     * The forms are spellings of one piece of text. Counting each of them would report a
     * false-positive rate several times the real one, and the rate is the entire reason the
     * recording mode exists — so this is an assertion about the DECISION the log feeds, not
     * about tidiness.
     */
    it('records one hit per value, not one per scanned form', async () => {
      setLists({ patterns: [PHISH] });
      await throwOnBlockedUserContent(`<p>${PHISH}</p><p>${PHISH}</p>`);
      expect(patternLogs()).toHaveLength(1);
    });
  });

  describe('scanning', () => {
    /**
     * Each value is scanned on its own. Joining them would let a pattern match across the seam
     * between two independent fields — text no user ever wrote — and a creator would be blocked
     * by the accident of what their title happens to end with.
     *
     * Mutate the implementation to `values.join(' ')` and this fails: the joined form contains
     * the pattern and the write is rejected.
     */
    it('does not match a pattern spanning two separate fields', async () => {
      getFliptBoolean.mockResolvedValue(true);
      setLists({ patterns: ['balance now'] });

      await expect(
        throwOnBlockedUserContent(['check your balance', 'now with more steps'])
      ).resolves.toBeUndefined();
    });

    it('scans every value it is given, not only the first', async () => {
      getFliptBoolean.mockResolvedValue(true);
      setLists({ patterns: [PHISH] });

      const error = await rejection(['an ordinary title', `<p>${PHISH}</p>`]);
      expect(error).toBeInstanceOf(TRPCError);
    });

    it('skips absent and empty values without reading the lists', async () => {
      setLists({ patterns: [PHISH] });
      await expect(throwOnBlockedUserContent([null, undefined, ''])).resolves.toBeUndefined();
      expect(redisGet).not.toHaveBeenCalled();
    });

    /**
     * Content is normalised before matching, so a rule written in ASCII covers the same phrase
     * typed in any script. Revert the fold and this fails with `null`.
     */
    it('matches a pattern whatever script it is typed in', async () => {
      getFliptBoolean.mockResolvedValue(true);
      setLists({ patterns: ['account verification notice'] });

      const error = await rejection('<p>Аccount verificаtiоn nоtice</p>');
      expect(error).toBeInstanceOf(TRPCError);
    });
  });

  describe('moderators', () => {
    /**
     * Same exemption comments carry, and for the same reason: quoting the text in order to warn
     * people about it is a thing moderators do, on an article as much as in a comment.
     */
    it('exempts a moderator from the pattern list', async () => {
      getFliptBoolean.mockResolvedValue(true);
      setLists({ patterns: [PHISH] });

      await expect(
        throwOnBlockedUserContent(`<p>${PHISH}</p>`, { isModerator: true })
      ).resolves.toBeUndefined();
      expect(patternLogs()).toHaveLength(0);
    });

    /**
     * 🔴 The paired half, and the one that matters. These surfaces enforced the link list against
     * EVERYONE before this guard existed — `throwOnBlockedLinkDomain` took no moderator flag at
     * all. Exempting moderators from it here would switch off a live control while looking like
     * consistency with the comment path, which exempts both. It nearly shipped that way.
     *
     * Set `exemptFromLinks: isModerator` in `throwOnBlockedUserContent` and this fails with a
     * `null` rejection.
     */
    it('does NOT exempt a moderator from the link list', async () => {
      setLists({ domains: ['blocked.example'] });

      const error = await rejection('<p>https://blocked.example/x</p>', { isModerator: true });
      expect(error).toBeInstanceOf(TRPCError);
      expect((error as TRPCError).message).toContain('blocked.example');
    });

    /**
     * The paired negative. Without it the test above passes just as well against a guard that
     * checks nothing at all.
     */
    it('does not exempt an ordinary user', async () => {
      setLists({ domains: ['blocked.example'] });
      const error = await rejection('<p>https://blocked.example/x</p>', { isModerator: false });
      expect(error).toBeInstanceOf(TRPCError);
    });
  });

  describe('onBlocked', () => {
    /**
     * The app-listing path classifies a block to decide whether to file a Report. It gets the
     * kind handed to it rather than parsing the thrown message, so a reworded message cannot
     * silently reclassify a block. Swap the two `reject` kinds and both assertions fail.
     */
    it('reports which list rejected the text', async () => {
      getFliptBoolean.mockResolvedValue(true);
      setLists({ domains: ['blocked.example'], patterns: [PHISH] });

      const kinds: string[] = [];
      const collect = (kind: string) => {
        kinds.push(kind);
        throw new Error('stop');
      };

      await rejection('<p>https://blocked.example/x</p>', { onBlocked: collect as never });
      await rejection(`<p>${PHISH}</p>`, { onBlocked: collect as never });

      expect(kinds).toEqual(['link', 'pattern']);
    });
  });
});
