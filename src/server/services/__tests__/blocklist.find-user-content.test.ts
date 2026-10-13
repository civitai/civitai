import { vi, describe, it, expect, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';

import { findBlockedUserContent, throwOnBlockedUserContent } from '../blocklist.service';
import { BlocklistType } from '~/server/common/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

void dbMock;

/**
 * `findBlockedUserContent` is the DECISION half of `throwOnBlockedUserContent`, split out so a
 * caller can learn what the guard would do without it acting (shadow moderation). Pinned here:
 *
 * - literal hit lists, attributed to the INPUT INDEX they came from;
 * - values scanned separately, never pre-joined;
 * - INVARIANT GUARDS: no Axiom event, no Flipt read, no throw — properties the pre-split code had
 *   no separate function to hold, so they are not regression tests;
 * - the wrapper's side effects, with literal expectations, including the cross-value ORDER the
 *   split had to preserve (a recorded pattern hit on one value, then a link hit on the next).
 */

const getFliptBoolean = vi.hoisted(() => vi.fn(async (): Promise<boolean> => false));
vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: { USER_CONTENT_PATTERN_ENFORCE: 'user-content-pattern-enforce' },
  getFliptBoolean,
}));

const redisGet = redisMock.redis.get;
const logToAxiom = loggingMock.logToAxiom;

function setLists({ domains = [], patterns = [] }: { domains?: string[]; patterns?: string[] }) {
  redisGet.mockImplementation(async (key: string) => {
    if (key.endsWith(`:${BlocklistType.LinkDomain}`))
      return JSON.stringify({ type: BlocklistType.LinkDomain, data: domains });
    if (key.endsWith(`:${BlocklistType.MessagePattern}`))
      return JSON.stringify({ type: BlocklistType.MessagePattern, data: patterns });
    return null;
  });
}

const PHISH = 'phish-verify592807.example';
const LINK = 'https://blocked.example/x';

beforeEach(() => {
  vi.clearAllMocks();
  getFliptBoolean.mockResolvedValue(false);
  setLists({ domains: ['blocked.example'], patterns: [PHISH] });
});

describe('findBlockedUserContent — hits', () => {
  it('returns nothing for ordinary content', async () => {
    await expect(findBlockedUserContent(['A title', '<p>A body.</p>'])).resolves.toEqual([]);
  });

  it('attributes each hit to the value it came from', async () => {
    await expect(
      findBlockedUserContent(['an ordinary title', `<p>see ${LINK}</p>`, `<p>${PHISH}</p>`])
    ).resolves.toEqual([
      { kind: 'link', index: 1, matched: [LINK] },
      { kind: 'pattern', index: 2, matched: PHISH },
    ]);
  });

  it('keeps the caller’s index across absent and empty values', async () => {
    await expect(findBlockedUserContent([null, '', undefined, `<p>${PHISH}</p>`])).resolves.toEqual(
      [{ kind: 'pattern', index: 3, matched: PHISH }]
    );
  });

  it('reports both lists on one value, link first', async () => {
    await expect(findBlockedUserContent(`<p>${LINK} ${PHISH}</p>`)).resolves.toEqual([
      { kind: 'link', index: 0, matched: [LINK] },
      { kind: 'pattern', index: 0, matched: PHISH },
    ]);
  });

  it('reports one pattern hit per value, not one per scanned form', async () => {
    await expect(findBlockedUserContent(`<p>${PHISH}</p><p>${PHISH}</p>`)).resolves.toEqual([
      { kind: 'pattern', index: 0, matched: PHISH },
    ]);
  });

  /** MUTATION TARGET: join the values before scanning and this goes red. */
  it('does not match a pattern spanning two separate values (values are NOT pre-joined)', async () => {
    setLists({ patterns: ['balance now'] });
    await expect(
      findBlockedUserContent(['check your balance', 'now with more steps'])
    ).resolves.toEqual([]);
  });

  /** The paired positive, so the test above cannot pass against a scan that matches nothing. */
  it('does match the same pattern inside one value', async () => {
    setLists({ patterns: ['balance now'] });
    await expect(findBlockedUserContent(['check your balance now'])).resolves.toEqual([
      { kind: 'pattern', index: 0, matched: 'balance now' },
    ]);
  });

  it('exemptFromPatterns drops pattern hits but never link hits', async () => {
    await expect(
      findBlockedUserContent([`<p>${PHISH}</p>`, `<p>${LINK}</p>`], { exemptFromPatterns: true })
    ).resolves.toEqual([{ kind: 'link', index: 1, matched: [LINK] }]);
  });

  it('skips absent and empty values without reading the lists', async () => {
    await expect(findBlockedUserContent([null, undefined, ''])).resolves.toEqual([]);
    expect(redisGet).not.toHaveBeenCalled();
  });
});

describe('findBlockedUserContent — INVARIANT GUARDS: no side effects', () => {
  it.each([false, true])(
    'with enforcement=%s: no throw, no Flipt read, no Axiom event',
    async (enforce) => {
      getFliptBoolean.mockResolvedValue(enforce);
      const hits = await findBlockedUserContent([`<p>${LINK}</p>`, `<p>${PHISH}</p>`]);
      expect(hits).toHaveLength(2);
      expect(getFliptBoolean).not.toHaveBeenCalled();
      expect(logToAxiom).not.toHaveBeenCalled();
    }
  );

  /** Positive control: the wrapper over the same pattern DOES read Flipt and log. */
  it('positive control — the wrapper reads Flipt and logs on the same input', async () => {
    await throwOnBlockedUserContent(`<p>${PHISH}</p>`);
    expect(getFliptBoolean).toHaveBeenCalledTimes(1);
    expect(logToAxiom).toHaveBeenCalledTimes(1);
  });
});

describe('throwOnBlockedUserContent — still produces today’s side effects', () => {
  it('records a pattern hit with the literal Axiom event and does not throw', async () => {
    await expect(
      throwOnBlockedUserContent(`<p>${PHISH}</p>`, { surface: 'appSharedStorage' })
    ).resolves.toBeUndefined();

    expect(getFliptBoolean).toHaveBeenCalledWith('user-content-pattern-enforce');
    expect(logToAxiom).toHaveBeenCalledTimes(1);
    expect(logToAxiom).toHaveBeenCalledWith({
      name: 'user-content-pattern-match',
      type: 'info',
      message: 'Blocked pattern found in user content; not enforced on this surface yet',
      details: { surface: 'appSharedStorage', matched: PHISH, enforced: false },
    });
  });

  it('throws the literal link message', async () => {
    const error = await throwOnBlockedUserContent(`<p>${LINK}</p>`).catch((e) => e);
    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).message).toBe(`invalid urls: ${LINK}`);
  });

  /**
   * Cross-value order: value 0's pattern hit is RECORDED (flag off) before value 1's link hit
   * throws. A wrapper that acted on links first across all values would skip the record.
   */
  it('records an earlier value’s pattern hit, then throws on a later value’s link', async () => {
    const error = await throwOnBlockedUserContent([`<p>${PHISH}</p>`, `<p>${LINK}</p>`], {
      surface: 'appSharedStorage',
    }).catch((e) => e);
    expect((error as TRPCError).message).toBe(`invalid urls: ${LINK}`);
    expect(logToAxiom).toHaveBeenCalledTimes(1);
  });

  /** And the converse: a link hit stops the scan, so a LATER value's pattern is never recorded. */
  it('stops at a link hit — a later value’s pattern hit is not recorded', async () => {
    await throwOnBlockedUserContent([`<p>${LINK}</p>`, `<p>${PHISH}</p>`]).catch(() => undefined);
    expect(getFliptBoolean).not.toHaveBeenCalled();
    expect(logToAxiom).not.toHaveBeenCalled();
  });

  it('a link hit on a value suppresses that same value’s pattern record', async () => {
    await throwOnBlockedUserContent(`<p>${LINK} ${PHISH}</p>`).catch(() => undefined);
    expect(logToAxiom).not.toHaveBeenCalled();
  });

  it('hands onBlocked the kind, link and pattern', async () => {
    getFliptBoolean.mockResolvedValue(true);
    const kinds: string[] = [];
    const onBlocked = ((kind: string) => {
      kinds.push(kind);
      throw new Error('stop');
    }) as never;
    await throwOnBlockedUserContent(`<p>${LINK}</p>`, { onBlocked }).catch(() => undefined);
    await throwOnBlockedUserContent(`<p>${PHISH}</p>`, { onBlocked }).catch(() => undefined);
    expect(kinds).toEqual(['link', 'pattern']);
  });

  it('exempts a moderator from patterns only', async () => {
    getFliptBoolean.mockResolvedValue(true);
    await expect(
      throwOnBlockedUserContent(`<p>${PHISH}</p>`, { isModerator: true })
    ).resolves.toBeUndefined();
    const error = await throwOnBlockedUserContent(`<p>${LINK}</p>`, { isModerator: true }).catch(
      (e) => e
    );
    expect(error).toBeInstanceOf(TRPCError);
  });
});
