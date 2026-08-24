import { vi, describe, it, expect, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';

// getBlocklistData -> getBlocklistDTO reads redis.get first and, when a cached
// value is present, returns it WITHOUT touching the DB. So stubbing redis.get to
// return a JSON blocklist is enough to drive throwOnBlockedLinkDomain end-to-end.
import {
  buildBenignPhraseRegex,
  getBlocklistDTO,
  getClientBenignLists,
  stripBenignPhrases,
  throwOnBlockedLinkDomain,
  throwOnBlockedMessagePattern,
  upsertBlocklist,
} from '../blocklist.service';
import { BlocklistType } from '~/server/common/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
const redisGet = redisMock.redis.get;

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

  it('normalizes empty input to an empty string', async () => {
    expect(await stripBenignPhrases(undefined, BlocklistType.NegativeBenignPhrase)).toBe('');
  });
});

describe('a type with more than one Blocklist row', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Force the DB read: a cache hit short-circuits before the rows are ever seen.
    redisGet.mockResolvedValue(null);
  });

  // The fake HONOURS orderBy. With a fixed array the "lowest id wins" assertion passes
  // whatever the query asks for, so the fake would be deciding the outcome instead of the
  // code — and flipping the real orderBy to desc would stay green.
  // A row of ANOTHER type, with a LOWER id than either EmailDomain row. Without it the fake
  // returns the same rows whatever `where` says, so dropping the type filter from the query
  // stays green while production serves the link blocklist to an email-domain read.
  const rowsInDbOrder = [
    { id: 8, type: BlocklistType.EmailDomain, data: ['c.example'] },
    { id: 1, type: BlocklistType.EmailDomain, data: ['a.example', 'b.example'] },
    { id: 0, type: BlocklistType.LinkDomain, data: ['wrong-list.example'] },
  ];
  const respectOrderBy = (rows: typeof rowsInDbOrder) =>
    dbMock.dbWrite.blocklist.findMany.mockImplementation(
      async (args?: { where?: { type?: string }; orderBy?: { id?: 'asc' | 'desc' } }) => {
        // The fake honours BOTH `where` and `orderBy`. A fake that ignores an argument is a
        // fake that decides the outcome the assertion is supposed to be testing.
        const type = args?.where?.type;
        const filtered = type ? rows.filter((row) => row.type === type) : [...rows];
        const direction = args?.orderBy?.id;
        if (!direction) return filtered;
        return filtered.sort((a, b) => (direction === 'desc' ? b.id - a.id : a.id - b.id));
      }
    );

  const twoRows = () => respectOrderBy(rowsInDbOrder);

  it('CONTROL: a single row is returned as-is', async () => {
    respectOrderBy([
      { id: 1, type: BlocklistType.EmailDomain, data: ['a.example'] },
      { id: 0, type: BlocklistType.LinkDomain, data: ['wrong-list.example'] },
    ]);

    const result = await getBlocklistDTO({ type: BlocklistType.EmailDomain });
    expect(result.data).toEqual(['a.example']);
  });

  it('picks the lowest id deterministically rather than whichever row the DB returned first', async () => {
    twoRows();

    const result = await getBlocklistDTO({ type: BlocklistType.EmailDomain });
    expect(result.id).toBe(1);
    // NOT a union: merging silently would be a moderation bypass on the benign lists,
    // where a wider list strips more rather than blocking more.
    expect(result.data).toEqual(['a.example', 'b.example']);
  });

  it('asks the DB for an ordered read, so the pick cannot depend on physical row order', async () => {
    twoRows();
    await getBlocklistDTO({ type: BlocklistType.EmailDomain });

    expect(dbMock.dbWrite.blocklist.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { type: BlocklistType.EmailDomain },
        orderBy: { id: 'asc' },
      })
    );
  });

  it('reports the duplicate rather than picking silently', async () => {
    twoRows();
    await getBlocklistDTO({ type: BlocklistType.EmailDomain });

    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'blocklist-duplicate-rows',
        type: 'error',
        details: expect.objectContaining({ usedId: 1, ignoredIds: [8] }),
      })
    );
  });

  // The negative half matters on its own: this read gates account signup, so a report that
  // fired on every read would be hot-path log spam rather than a signal.
  it('CONTROL: reports nothing when the type has exactly one row', async () => {
    respectOrderBy([
      { id: 1, type: BlocklistType.EmailDomain, data: ['a.example'] },
      { id: 0, type: BlocklistType.LinkDomain, data: ['wrong-list.example'] },
    ]);

    await getBlocklistDTO({ type: BlocklistType.EmailDomain });

    expect(loggingMock.logToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'blocklist-duplicate-rows' })
    );
  });

  it('returns an empty list when the type has no rows at all', async () => {
    respectOrderBy([]);

    const result = await getBlocklistDTO({ type: BlocklistType.EmailDomain });
    expect(result.data).toEqual([]);
  });
});

describe('what an edit writes into the cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisGet.mockResolvedValue(null);
  });

  // The production incident was not the read: `upsertBlocklist` cached the row it had just
  // written under a key scoped to the TYPE, so editing the duplicate row promoted it to the
  // live answer for a month. Reverting to `data: result` leaves every read-side test green,
  // so this is the only thing standing between that bug and a re-introduction.
  const twoRows = () => {
    // Deliberately the SAME order-and-where-honouring fake as the read tests: a fake that
    // returns a fixed array would make `id: 1` below the fixture's answer rather than the
    // code's.
    dbMock.dbWrite.blocklist.findMany.mockImplementation(
      async (args?: { where?: { type?: string }; orderBy?: { id?: 'asc' | 'desc' } }) => {
        const rows = [
          { id: 8, type: BlocklistType.EmailDomain, data: ['c.example'] },
          { id: 1, type: BlocklistType.EmailDomain, data: ['a.example', 'b.example'] },
        ];
        const type = args?.where?.type;
        const filtered = type ? rows.filter((row) => row.type === type) : [...rows];
        const direction = args?.orderBy?.id;
        if (!direction) return filtered;
        return filtered.sort((a, b) => (direction === 'desc' ? b.id - a.id : a.id - b.id));
      }
    );
    // The merge now reads through a locking `SELECT ... FOR UPDATE`, so the row the edit starts
    // from comes back here rather than from `findUnique`.
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ data: ['c.example'] }]);
    dbMock.dbWrite.blocklist.updateMany.mockResolvedValue({ count: 1 });
  };

  const cachedPayload = () => {
    const call = redisMock.redis.set.mock.calls.at(-1);
    return call ? JSON.parse(call[1] as string) : undefined;
  };

  it('caches the row that WINS the read, not the row that was just edited', async () => {
    twoRows();

    await upsertBlocklist({
      id: 8,
      type: BlocklistType.EmailDomain,
      blocklist: ['new.example'],
    });

    const cached = cachedPayload();
    expect(cached?.id).toBe(1);
    expect(cached?.data).toEqual(['a.example', 'b.example']);
  });

  it('writes under a key scoped to the type', async () => {
    twoRows();

    await upsertBlocklist({
      id: 8,
      type: BlocklistType.EmailDomain,
      blocklist: ['new.example'],
    });

    expect(redisMock.redis.set.mock.calls.at(-1)?.[0]).toBe('system:blocklist:EmailDomain');
  });
});

describe('what an edit is allowed to touch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisGet.mockResolvedValue(null);
  });

  // The id and the type reach `upsertBlocklist` as two independent values — in the moderator
  // spoke they are two form fields on the same POST. Scoping the statements to the id alone
  // let one type's entries be merged into another type's row, which on a deny list means
  // arbitrary strings start blocking things.
  it('refuses an id that belongs to no row of the submitted type, and writes nothing', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([]);

    await expect(
      upsertBlocklist({
        id: 1,
        type: BlocklistType.MessagePattern,
        blocklist: ['unfreeze your funds'],
      })
    ).rejects.toThrow(/does not belong to this type/);

    expect(dbMock.dbWrite.blocklist.updateMany).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.blocklist.create).not.toHaveBeenCalled();
    expect(redisMock.redis.set).not.toHaveBeenCalled();
  });

  it('carries the type into the UPDATE as well as the locking read', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ data: ['a.example'] }]);
    dbMock.dbWrite.blocklist.updateMany.mockResolvedValue({ count: 1 });

    await upsertBlocklist({
      id: 1,
      type: BlocklistType.EmailDomain,
      blocklist: ['new.example'],
    });

    expect(dbMock.dbWrite.blocklist.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1, type: BlocklistType.EmailDomain },
      })
    );

    // The read is raw SQL, so the mock answers whatever it is asked and cannot tell a correctly
    // scoped statement from one scoped to the id alone. Read the statement instead. The
    // interpolated values are asserted separately because joining the template's static parts
    // drops them.
    const [fragments, ...values] = dbMock.dbWrite.$queryRaw.mock.calls[0] as [
      readonly string[],
      ...unknown[]
    ];
    const statement = fragments.join('?').replace(/\s+/g, ' ');
    expect(statement).toMatch(/type = \?/);
    expect(statement).toMatch(/FOR UPDATE/);
    expect(values).toEqual([1, BlocklistType.EmailDomain]);
  });
});

describe('getClientBenignLists', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisGet.mockResolvedValue(null);
  });

  // Swapping the two fields of the returned object is invisible to a shape assertion, and
  // in the browser it would feed prompt phrases to the profanity filter and single words to
  // the phrase stripper — disarming both gates quietly. So the lists must be distinguishable.
  it('returns each list under the field the client expects', async () => {
    dbMock.dbWrite.blocklist.findMany.mockImplementation(
      async (args?: { where?: { type?: string } }) => {
        if (args?.where?.type === BlocklistType.PromptBenignPhrase)
          return [{ id: 7, type: BlocklistType.PromptBenignPhrase, data: ['teen titans'] }];
        if (args?.where?.type === BlocklistType.ProfanityBenignWord)
          return [{ id: 9, type: BlocklistType.ProfanityBenignWord, data: ['spreadsheet'] }];
        return [];
      }
    );

    const result = await getClientBenignLists();

    expect(result.prompt).toEqual(['teen titans']);
    expect(result.profanityWords).toEqual(['spreadsheet']);
  });
});

/**
 * The DM path. It was the only surface enforcing `MessagePattern` before 868kw2f8y and it had no
 * test at all, so the folding added to it there was unobserved - and the empty-entry case is
 * WORSE here than on comments: this path throws a plain `Error`, which the tRPC layer turns into
 * a 500 on every DM, where the comment path throws a BAD_REQUEST.
 */
describe('throwOnBlockedMessagePattern', () => {
  const setPatterns = (patterns: string[]) =>
    redisGet.mockResolvedValue(
      JSON.stringify({ type: BlocklistType.MessagePattern, data: patterns })
    );

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lets an ordinary message through', async () => {
    setPatterns(['to safely unlock your held balance']);
    await expect(
      throwOnBlockedMessagePattern('hey, nice work on that model')
    ).resolves.toBeUndefined();
  });

  it('blocks a message matching a pattern', async () => {
    setPatterns(['to safely unlock your held balance']);
    await expect(
      throwOnBlockedMessagePattern('click here to safely unlock your held balance')
    ).rejects.toThrow();
  });

  // The half of decision 2C that reaches DMs: content is folded, so a lookalike spelling still
  // meets an ASCII rule. Remove the folded second pass and this is what fails.
  it('folds the message so a lookalike spelling still matches an ASCII pattern', async () => {
    setPatterns(['example security desk']);
    // Small-caps, not ASCII.
    await expect(
      throwOnBlockedMessagePattern(
        '\u1D07x\u1D00\u1D0D\u1D18\u029F\u1D07 s\u1D07\u1D04\u1D1C\u0280\u026A\u1D1B\u028F \u1D05\u1D07s\u1D0B here'
      )
    ).rejects.toThrow();
  });

  // Entries are NOT folded, for the same reason as on comments: `includes` means a folded entry
  // becomes a broader rule. See the comment on `substringEntries`.
  it('does not let a stylised entry become an ASCII rule nobody wrote', async () => {
    setPatterns(['\u1D00\u1D04\u1D04\u1D0F\u1D1C\u0274\u1D1B']);
    await expect(
      throwOnBlockedMessagePattern('updated my account settings')
    ).resolves.toBeUndefined();
  });

  // A 500 on every DM if this regresses.
  it('does not block every message when an entry is empty', async () => {
    setPatterns(['', 'to safely unlock your held balance']);
    await expect(throwOnBlockedMessagePattern('hello there')).resolves.toBeUndefined();
  });
});
