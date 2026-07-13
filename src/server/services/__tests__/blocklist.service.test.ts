import { vi, describe, it, expect, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';

// getBlocklistData -> getBlocklistDTO reads redis.get first and, when a cached
// value is present, returns it WITHOUT touching the DB. So stubbing redis.get to
// return a JSON blocklist is enough to drive throwOnBlockedLinkDomain end-to-end.
const { redisGet } = vi.hoisted(() => ({ redisGet: vi.fn() }));

vi.mock('~/server/redis/client', () => ({
  redis: { get: redisGet, set: vi.fn() },
  REDIS_KEYS: { SYSTEM: { BLOCKLIST: 'system:blocklist' } },
}));
vi.mock('~/server/db/client', () => ({
  dbWrite: { blocklist: { findFirst: vi.fn(), findUnique: vi.fn() } },
}));

import {
  buildBenignPhraseRegex,
  stripBenignPhrases,
  throwOnBlockedLinkDomain,
} from '../blocklist.service';
import { BlocklistType } from '~/server/common/enums';

/** Make getBlocklistData return the given domains (already lower-cased in prod). */
function setBlockedDomains(domains: string[]) {
  redisGet.mockResolvedValue(JSON.stringify({ type: BlocklistType.LinkDomain, data: domains }));
}

describe('throwOnBlockedLinkDomain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a blocked link domain as a BAD_REQUEST TRPCError (400), not a 500', async () => {
    setBlockedDomains(['bit.ly']);

    let caught: unknown;
    try {
      await throwOnBlockedLinkDomain('check this out https://bit.ly/m/abc123');
    } catch (e) {
      caught = e;
    }

    // Must be a tRPC BAD_REQUEST — NOT a plain Error (which tRPC maps to
    // INTERNAL_SERVER_ERROR / HTTP 500). This is the regression guard.
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe('BAD_REQUEST');
    expect((caught as Error).message).toContain('invalid urls: https://bit.ly/m/abc123');
  });

  it('does not throw when all link domains are allowed', async () => {
    setBlockedDomains(['bit.ly']);

    await expect(
      throwOnBlockedLinkDomain('see https://civitai.com/models/123 and https://example.com/x')
    ).resolves.toBeUndefined();
  });

  it('does not throw when there are no links at all', async () => {
    setBlockedDomains(['bit.ly']);

    await expect(throwOnBlockedLinkDomain('just some plain text')).resolves.toBeUndefined();
  });

  it('does not raise a raw TypeError on a malformed-but-regex-matching URL', async () => {
    setBlockedDomains(['bit.ly']);

    // An invalid IPv4 octet (256): the link regex matches it, but `new URL()`
    // rejects it with a raw TypeError. Pre-fix, that TypeError escaped as a 500 on
    // user input. The guard must swallow it; it maps to no blocked host, so the
    // call resolves without throwing.
    await expect(throwOnBlockedLinkDomain('spam http://1.1.1.256/x')).resolves.toBeUndefined();
  });
});

describe('buildBenignPhraseRegex', () => {
  it('returns null for an empty or whitespace-only list', () => {
    expect(buildBenignPhraseRegex([])).toBeNull();
    expect(buildBenignPhraseRegex(['', '   '])).toBeNull();
  });

  it('matches phrases as whole words, case-insensitively, with any non-alnum separator', () => {
    const re = buildBenignPhraseRegex(['teen titans', 'minor barrel distortion'])!;
    expect('raven from TEEN  titans'.replace(re, ' ')).toBe('raven from  ');
    expect('a teen-titans poster'.replace(re, ' ')).toBe('a   poster');
    expect('lens with minor barrel\ndistortion'.replace(re, ' ')).toBe('lens with  ');
  });

  it('does not blank the token when it is part of a larger word', () => {
    const re = buildBenignPhraseRegex(['teen titans'])!;
    expect('canteen titans'.replace(re, ' ')).toBe('canteen titans');
  });

  it('escapes regex metacharacters in phrases', () => {
    const re = buildBenignPhraseRegex(['a.i. (safe)'])!;
    // The `.` and parens are literal, so an arbitrary char in their place must NOT match.
    expect('axixx xsafey'.replace(re, ' ')).toBe('axixx xsafey');
    expect('an a.i. (safe) tag'.replace(re, ' ')).toBe('an   tag');
  });
});

describe('stripBenignPhrases', () => {
  it('blanks moderator-managed phrases from the text', async () => {
    redisGet.mockResolvedValue(
      JSON.stringify({ type: BlocklistType.PromptBenignPhrase, data: ['teen titans'] })
    );
    expect(
      await stripBenignPhrases('raven from teen titans', BlocklistType.PromptBenignPhrase)
    ).toBe('raven from  ');
  });

  it('passes text through unchanged for an undefined input', async () => {
    expect(await stripBenignPhrases(undefined, BlocklistType.NegativeBenignPhrase)).toBeUndefined();
  });
});
