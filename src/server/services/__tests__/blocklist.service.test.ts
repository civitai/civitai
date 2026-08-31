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

  /**
   * The populate is read-then-write, so a reader that read the row before a write commits can land
   * its pre-write snapshot after that write's DELETE. Only another write to the same type clears
   * it, and three of the eight lists in production had gone 8, 46 and 676 days without one — so
   * this expiry is the only bound on how long a moderator's edit can go unenforced.
   *
   * A ceiling rather than an exact number: tuning the value should not need a test edit, restoring
   * the month it used to be should.
   */
  it('caches for minutes, not a month — the expiry bounds how long a stale copy serves', async () => {
    respectOrderBy([{ id: 1, type: BlocklistType.EmailDomain, data: ['a.example'] }]);

    await getBlocklistDTO({ type: BlocklistType.EmailDomain });

    const options = redisMock.redis.set.mock.calls.at(-1)?.[2] as { EX?: number } | undefined;
    expect(options?.EX, 'the populate must set an expiry').toBeGreaterThan(0);
    expect(options?.EX, 'a stale copy must not be able to serve for hours').toBeLessThanOrEqual(
      15 * 60
    );
  });
});

describe('what an edit does to the shared cache key', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisGet.mockResolvedValue(null);
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ id: 8, data: ['c.example'] }]);
    dbMock.dbWrite.blocklist.updateMany.mockResolvedValue({ count: 1 });
  });

  const edit = () =>
    upsertBlocklist({ id: 8, type: BlocklistType.EmailDomain, blocklist: ['new.example'] });

  /**
   * This used to cache a re-read of the winning row, which fixed one bug and left another: the
   * re-read and the `SET` are themselves an unserialised read-modify-write over the key, so two
   * edits the row lock correctly serialised could still land their cache writes in the other
   * order and leave the LOSER's list cached until it expires. Every enforcement path reads this key
   * first, so that is the lost update the row lock exists to prevent, moved to the artifact that
   * actually gates. A delete commutes; the next read repopulates from the table.
   *
   * It also makes the old duplicate-row-promotion incident unrepresentable rather than merely
   * guarded: there is no snapshot to pick the wrong row for.
   */
  it('DELETES the key rather than writing a snapshot back', async () => {
    await edit();

    expect(redisMock.redis.del).toHaveBeenCalledWith('system:blocklist:EmailDomain');
    expect(redisMock.redis.del).toHaveBeenCalledTimes(1);
    expect(
      redisMock.redis.set,
      'an edit must not repopulate the key it just invalidated'
    ).not.toHaveBeenCalled();
  });

  it('busts the key for the type it was given, not a hardcoded one', async () => {
    // Every other assertion here uses EmailDomain, so a hardcoded key would pass all of them.
    await upsertBlocklist({
      id: 8,
      type: BlocklistType.MessagePattern,
      blocklist: ['unfreeze your funds'],
    });

    expect(redisMock.redis.del).toHaveBeenCalledWith('system:blocklist:MessagePattern');
  });

  it('does not report failure when the key could not be cleared', async () => {
    // The row is already committed. Throwing here tells the caller a write failed that
    // succeeded, and the weekly cron would then re-add domains it had already added. Same rule
    // as `a04fa6a608` on the session cache: log it, do not surface it.
    redisMock.redis.del.mockRejectedValueOnce(new Error('redis down'));

    await expect(edit()).resolves.toBeUndefined();
    expect(dbMock.dbWrite.blocklist.updateMany).toHaveBeenCalled();
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
    expect(redisMock.redis.del).not.toHaveBeenCalled();
  });

  it('carries the type into the UPDATE as well as the locking read', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ id: 1, data: ['a.example'] }]);
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

  /**
   * 🔴 The default `$transaction` mock hands the callback the SAME node the assertions read, so it
   * cannot tell `tx.$queryRaw` from `dbWrite.$queryRaw`. Deleting the `$transaction` wrapper and
   * running the body against the bare client left every other test here green — with `FOR UPDATE`
   * still in the statement, and the lock held by a transaction that has already committed. An
   * inert lock is the shape that reads as fixed and is not, so this overrides the mock with a
   * DISTINCT tx object and asserts both statements were issued on it.
   */
  it('issues the locking read and the update on the TRANSACTION client', async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 1, data: ['a.example'] }]),
      blocklist: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    // `Once`, not a standing implementation: `vi.clearAllMocks()` clears CALLS but not
    // implementations, so a standing override here leaks into every later test in the file and
    // sends their statements to this dead `tx` object.
    dbMock.dbWrite.$transaction.mockImplementationOnce(async (cb: (client: unknown) => unknown) =>
      cb(tx)
    );

    await upsertBlocklist({ id: 1, type: BlocklistType.EmailDomain, blocklist: ['new.example'] });

    expect(tx.$queryRaw, 'the locked read must run inside the transaction').toHaveBeenCalledTimes(
      1
    );
    expect(tx.blocklist.updateMany, 'the write must run inside the same one').toHaveBeenCalledTimes(
      1
    );
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.blocklist.updateMany).not.toHaveBeenCalled();
  });

  it('gives the transaction a budget larger than Prisma’s 5s default', async () => {
    // The one caller is a weekly cron with no retry, and this path had no transaction before, so
    // both of Prisma’s ceilings (maxWait 2s, timeout 5s) are new ways for it to fail — at a cost
    // of a week’s disposable-domain additions.
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ id: 1, data: ['a.example'] }]);
    dbMock.dbWrite.blocklist.updateMany.mockResolvedValue({ count: 1 });

    await upsertBlocklist({ id: 1, type: BlocklistType.EmailDomain, blocklist: ['new.example'] });

    expect(
      dbMock.dbWrite.$transaction,
      'the edit must open a transaction at all'
    ).toHaveBeenCalled();
    const options = dbMock.dbWrite.$transaction.mock.calls[0][1] as
      | { maxWait?: number; timeout?: number }
      | undefined;
    // Named rather than destructured: without the guard, dropping the options argument fails as a
    // TypeError on `undefined`, which reads as a broken test rather than a missing budget.
    expect(options?.timeout ?? 5_000).toBeGreaterThan(5_000);
    expect(options?.maxWait ?? 2_000).toBeGreaterThan(2_000);
  });

  it('locks the lowest row of the type when no id was submitted', async () => {
    // 🔴 TWO rows, and that is the whole point of the fixture. With one, `locked[0]` and
    // `locked.at(-1)` are the same object, so merging into the HIGHEST-id row passes every
    // assertion while the `ORDER BY id ASC` stays in the statement to reassure the reader — the
    // duplicate-row promotion this file exists to prevent, hidden behind a text match.
    dbMock.dbWrite.$queryRaw.mockResolvedValue([
      { id: 3, data: ['lowest.example'] },
      { id: 8, data: ['highest.example'] },
    ]);
    dbMock.dbWrite.blocklist.updateMany.mockResolvedValue({ count: 1 });

    await upsertBlocklist({ type: BlocklistType.EmailDomain, blocklist: ['new.example'] });

    // Not an insert: a type that already has a row must not gain a second, whose entries
    // `readBlocklistRow` would then never enforce.
    expect(dbMock.dbWrite.blocklist.create).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.blocklist.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        // The row id AND the data it merged from, so reading the wrong element of `locked`
        // fails on a value rather than on a regex over SQL text.
        where: { id: 3, type: BlocklistType.EmailDomain },
        data: { data: ['lowest.example', 'new.example'] },
      })
    );

    const [fragments] = dbMock.dbWrite.$queryRaw.mock.calls[0] as [readonly string[]];
    const statement = fragments.join('?').replace(/\s+/g, ' ');
    expect(statement).toMatch(/ORDER BY id ASC/);
    expect(statement).toMatch(/FOR UPDATE/);
  });

  it('throws and busts nothing when the locked update matches no row', async () => {
    // Unreachable while the lock holds, which is exactly why it needs a test: the guard exists so
    // that moving either statement out of the transaction fails loudly instead of writing nothing,
    // reporting success, and busting a key over a row that never changed.
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ id: 1, data: ['a.example'] }]);
    dbMock.dbWrite.blocklist.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      upsertBlocklist({ id: 1, type: BlocklistType.EmailDomain, blocklist: ['new.example'] })
    ).rejects.toThrow(/matched 0 rows/);

    expect(redisMock.redis.del).not.toHaveBeenCalled();
  });

  it('inserts only when the type has no row at all', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([]);

    await upsertBlocklist({ type: BlocklistType.UsernameExact, blocklist: ['Scammer'] });

    expect(dbMock.dbWrite.blocklist.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { data: ['scammer'], type: BlocklistType.UsernameExact },
      })
    );
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
