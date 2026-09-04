import { describe, expect, it, vi } from 'vitest';
import type { BotAccountCohortMember, SurfaceCounts } from '../cohort';
import {
  MIN_FINGERPRINT_CHARS,
  MIN_FINGERPRINT_TOKENS,
  buildCohortSignals,
  chunk,
  collectCohortSignals,
  contentFingerprint,
  contentSampleArgs,
  createEvidenceReader,
  emptyCohortSignals,
  normalizeContent,
  registrationIpSql,
  type ContentSampleRow,
  type EvidenceClickhouse,
  type EvidenceReader,
  type RegistrationIpRow,
} from '../evidence';

const surface = (partial: Partial<SurfaceCounts> = {}): SurfaceCounts => {
  const row = { comments: 0, models: 0, images: 0, ...partial };
  return { ...row, total: row.comments + row.models + row.images };
};

const member = (userId: number, emailDomain: string | null = null): BotAccountCohortMember => ({
  userId,
  username: `u${userId}`,
  createdAt: new Date('2026-09-03T09:00:00.000Z'),
  posts: { all: surface({ comments: 1 }), visible: surface({ comments: 1 }), excluded: surface() },
  emailDomain,
});

// ---------------------------------------------------------------------------------------------
// Text normalisation and fingerprinting
// ---------------------------------------------------------------------------------------------

describe('normalizeContent', () => {
  it('🔴 masks links, which is what turns copy-paste detection into TEMPLATE detection', () => {
    // The link is exactly the part a ring varies. Without this the two below are different strings
    // and the heuristic finds nothing.
    expect(normalizeContent('Check out https://a.example/x')).toBe('check out linkmask');
    expect(normalizeContent('Check out https://b.example/y')).toBe('check out linkmask');
    expect(normalizeContent('visit www.spam.example/ref')).toBe('visit linkmask');
  });

  it('🔴 masks digit runs, so a swapped payout or referral code still matches', () => {
    expect(normalizeContent('I earned 50 credits')).toBe('i earned nummask credits');
    expect(normalizeContent('I earned 9000 credits')).toBe('i earned nummask credits');
  });

  it('drops punctuation, emoji and decoration, so a template survives being dressed up', () => {
    // Spam text is routinely padded to defeat exact matching.
    expect(normalizeContent('B.U.Y!!! now 🎉🎉')).toBe('b u y now');
    expect(normalizeContent('buy   \n\t now')).toBe('buy now');
  });

  it('lowercases, so case-flipping does not split a ring', () => {
    expect(normalizeContent('BUY NOW')).toBe(normalizeContent('buy now'));
  });

  it('truncates before normalising, and says so by colliding long texts', () => {
    // Documented consequence, asserted rather than left as a claim: two texts differing only past
    // the character cap fingerprint identically.
    const head = 'z'.repeat(600);
    expect(normalizeContent(`${head}AAA`)).toBe(normalizeContent(`${head}BBB`));
  });

  it('the placeholders survive the punctuation strip — they are bare words for that reason', () => {
    // A bracketed marker like `<url>` would be destroyed by the step that removes punctuation,
    // silently merging every link into nothing at all.
    expect(normalizeContent('see https://a.example')).toContain('linkmask');
    expect(normalizeContent('see 42')).toContain('nummask');
  });
});

describe('contentFingerprint', () => {
  it('🔴 refuses a short text rather than returning a key that clusters rarely', () => {
    // "thanks", "nice work", "great model" are written independently by unrelated people every
    // hour. A key that merely matches rarely still CLUSTERS whenever it matches, and the whole
    // requirement is that these must never cluster at all — so the encoding is `null`, not a key.
    expect(contentFingerprint('thanks')).toBeNull();
    expect(contentFingerprint('nice work!')).toBeNull();
    expect(contentFingerprint('')).toBeNull();
  });

  it('🔴 pins the two floors, so moving either is a deliberate edit', () => {
    // Separated from the behavioural cases: a case written in terms of the constant it tests is
    // vacuous about that constant's VALUE. Measured — lowering `MIN_FINGERPRINT_CHARS` from 24 to 3
    // was killed only by the token floor, never by a case about the character floor itself.
    expect(MIN_FINGERPRINT_CHARS).toBe(24);
    expect(MIN_FINGERPRINT_TOKENS).toBe(4);
  });

  it('🔴 enforces the two floors INDEPENDENTLY, each isolated from the other', () => {
    // Either alone is walkable: one long word clears the character floor, four one-letter words
    // clear the token floor. So each case must clear the OTHER floor outright — otherwise the
    // surviving floor kills the mutant and the floor under test is never exercised.
    //
    // Clears the CHARACTER floor (30 chars), fails the TOKEN floor (1 token):
    const oneLongWord = 'a'.repeat(30);
    expect(oneLongWord.length).toBeGreaterThan(MIN_FINGERPRINT_CHARS);
    expect(contentFingerprint(oneLongWord)).toBeNull();

    // Clears the TOKEN floor (5 tokens), fails the CHARACTER floor (9 chars). This is the case that
    // isolates the character floor — without it, lowering that constant changes nothing observable.
    const shortButManyWords = 'a b c d e';
    expect(shortButManyWords.split(' ').length).toBeGreaterThanOrEqual(MIN_FINGERPRINT_TOKENS);
    expect(shortButManyWords.length).toBeLessThan(MIN_FINGERPRINT_CHARS);
    expect(contentFingerprint(shortButManyWords)).toBeNull();

    // And a text clearing BOTH is accepted — the positive control that stops the two cases above
    // from passing because the function simply always returns null.
    expect(contentFingerprint('grab your free credits from this page now')).not.toBeNull();
  });

  it('returns the normalised text for something substantial', () => {
    const fp = contentFingerprint('Check out my page at https://spam.example for 500 free credits');
    expect(fp).toBe('check out my page at linkmask for nummask free credits');
  });

  it('two templated variants share one fingerprint; unrelated text does not', () => {
    const a = contentFingerprint('Grab your 100 free credits here: https://a.example/ref1');
    const b = contentFingerprint('Grab your 250 free credits here: https://b.example/ref9');
    const other = contentFingerprint('This checkpoint handles hands surprisingly well overall');
    expect(a).toBe(b);
    expect(a).not.toBe(other);
    expect(other).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Query shapes
// ---------------------------------------------------------------------------------------------

describe('registrationIpSql', () => {
  it('🔴 filters on targetUserId, not userId', () => {
    // `Tracker.userActivity` writes the account an event is ABOUT into `targetUserId`; a
    // Registration has no signed-in actor, so `userId` is not the new account. `bulk-ban.service.ts`
    // reads `targetUserId` for this reason. Using `userId` here returns nothing, silently.
    const sql = registrationIpSql([7, 8]);
    expect(sql).toContain('targetUserId IN (7,8)');
    expect(sql).not.toMatch(/\buserId IN\b/);
  });

  it('reads registrations only, never logins', () => {
    // A shared LOGIN ip is weak evidence — carriers and offices put thousands of unrelated people
    // behind one address. Widening this to logins would flood the board.
    expect(registrationIpSql([1])).toContain("type = 'Registration'");
    expect(registrationIpSql([1])).not.toContain('Login');
  });

  it('is a bare SELECT and nothing else', () => {
    expect(registrationIpSql([1]).trim()).toMatch(/^SELECT\b/);
  });

  it('🔴 drops anything that is not a positive integer before interpolating', () => {
    // This is string-interpolated SQL: the client takes no bound parameters, so this filter is the
    // only thing between a value and the statement.
    const sql = registrationIpSql([5, Number.NaN, -3, 1.5, 0, 9] as number[]);
    expect(sql).toContain('IN (5,9)');
  });

  it('returns an empty string for an empty list, so no statement is issued', () => {
    expect(registrationIpSql([])).toBe('');
    expect(registrationIpSql([Number.NaN] as number[])).toBe('');
  });

  it('bounds the result so one account cannot flood a chunk', () => {
    expect(registrationIpSql([1, 2])).toMatch(/LIMIT 8\b/);
  });
});

describe('contentSampleArgs', () => {
  it('reads the newest comments of exactly these accounts, bounded, two columns', () => {
    // 🔴 `orderBy: id desc` is load-bearing: `take` bounds the read, so the ORDER decides which
    // comments a bounded read keeps — and a wave is made of the newest ones.
    expect(contentSampleArgs([3, 4], 25)).toEqual({
      where: { userId: { in: [3, 4] } },
      select: { userId: true, content: true },
      orderBy: { id: 'desc' },
      take: 25,
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Index building
// ---------------------------------------------------------------------------------------------

describe('buildCohortSignals', () => {
  const sources = {
    registrationIps: true,
    contentBudgetExhausted: false,
    membersSampledForContent: 3,
  };

  it('🔴 counts DISTINCT accounts per IP, not rows', () => {
    // One account with several registration rows on one address must contribute ONE member. Rows
    // would let a single account manufacture a ring out of itself.
    const s = buildCohortSignals({
      members: [member(1), member(2)],
      registrationIps: [
        { userId: 1, ip: 'x' },
        { userId: 1, ip: 'x' },
        { userId: 1, ip: 'x' },
        { userId: 2, ip: 'x' },
      ],
      contentSamples: [],
      sources,
    });
    expect(s.membersPerIp.get('x')).toBe(2);
    // And the account's own IP list is deduplicated too.
    expect(s.ipsByUser.get(1)).toEqual(['x']);
  });

  it('🔴 counts DISTINCT accounts per fingerprint, not repetitions', () => {
    // The same defect in the text axis: one account pasting its shill line ninety times is ONE
    // member of that group, not ninety. Otherwise a lone spammer scores as a ten-account ring.
    const text = 'Grab your 100 free credits at https://spam.example now';
    const s = buildCohortSignals({
      members: [member(1), member(2)],
      registrationIps: [],
      contentSamples: Array.from({ length: 9 }, () => ({ userId: 1, content: text })).concat([
        { userId: 2, content: text },
      ]),
      sources,
    });
    const fp = contentFingerprint(text) as string;
    expect(s.membersPerFingerprint.get(fp)).toBe(2);
    expect(s.fingerprintsByUser.get(1)).toEqual([fp]);
  });

  it('🔴 ignores rows for accounts outside the cohort', () => {
    // A registration row for a banned account ClickHouse still remembers would otherwise inflate an
    // IP's tally with something that is never scored — a ring counted larger than the population it
    // is drawn from.
    const s = buildCohortSignals({
      members: [member(1)],
      registrationIps: [
        { userId: 1, ip: 'x' },
        { userId: 99, ip: 'x' },
      ],
      contentSamples: [{ userId: 99, content: 'Grab your 100 free credits at https://s.example' }],
      sources,
    });
    expect(s.membersPerIp.get('x')).toBe(1);
    expect(s.membersPerFingerprint.size).toBe(0);
  });

  it('tallies email domains from the members, with no query at all', () => {
    // One of the clustering heuristic's two signals is free — it rode in on the cohort read.
    const s = buildCohortSignals({
      members: [
        member(1, 'ring.test'),
        member(2, 'ring.test'),
        member(3, 'other.test'),
        member(4, null),
      ],
      registrationIps: [],
      contentSamples: [],
      sources,
    });
    expect(s.membersPerDomain.get('ring.test')).toBe(2);
    expect(s.membersPerDomain.get('other.test')).toBe(1);
    // A null domain is not a cluster key — see `normalizeEmailDomain`.
    expect(s.membersPerDomain.size).toBe(2);
  });

  it('drops content too slight to be a key', () => {
    const s = buildCohortSignals({
      members: [member(1), member(2), member(3)],
      registrationIps: [],
      contentSamples: [
        { userId: 1, content: 'thanks' },
        { userId: 2, content: 'thanks' },
        { userId: 3, content: 'thanks' },
      ],
      sources,
    });
    // Three accounts, one identical text — and deliberately NOT a ring.
    expect(s.membersPerFingerprint.size).toBe(0);
  });

  it('carries the source flags through unchanged', () => {
    const s = buildCohortSignals({
      members: [],
      registrationIps: [],
      contentSamples: [],
      sources: {
        registrationIps: false,
        contentBudgetExhausted: true,
        membersSampledForContent: 7,
      },
    });
    expect(s.sources).toEqual({
      registrationIps: false,
      contentBudgetExhausted: true,
      membersSampledForContent: 7,
    });
  });
});

describe('emptyCohortSignals', () => {
  it('🔴 defaults every source to "did not run", which is the safe reading', () => {
    // A run with no evidence reader must not look like a run that found no rings.
    expect(emptyCohortSignals().sources).toEqual({
      registrationIps: false,
      contentBudgetExhausted: false,
      membersSampledForContent: 0,
    });
  });
});

describe('chunk', () => {
  it('slices in order and keeps a short tail', () => {
    expect(chunk([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
    expect(chunk([], 3)).toEqual([]);
  });
  it('refuses a nonsense size rather than looping forever', () => {
    expect(() => chunk([1], 0)).toThrow(/chunk size/);
  });
});

// ---------------------------------------------------------------------------------------------
// Collection: budgets and degradation
// ---------------------------------------------------------------------------------------------

/** A reader that records what it was asked for and answers from fixtures. */
function fakeReader(opts: {
  ips?: RegistrationIpRow[];
  content?: ContentSampleRow[];
  hasIps?: boolean;
  ipError?: Error;
}): EvidenceReader & { ipCalls: number[][]; contentCalls: Array<{ ids: number[]; take: number }> } {
  const ipCalls: number[][] = [];
  const contentCalls: Array<{ ids: number[]; take: number }> = [];
  return {
    ipCalls,
    contentCalls,
    hasRegistrationIps: opts.hasIps ?? true,
    listRegistrationIps: async (ids) => {
      ipCalls.push(ids);
      if (opts.ipError) throw opts.ipError;
      return (opts.ips ?? []).filter((r) => ids.includes(r.userId));
    },
    listContentSamples: async (ids, take) => {
      contentCalls.push({ ids, take });
      return (opts.content ?? []).filter((r) => ids.includes(r.userId)).slice(0, take);
    },
  };
}

describe('collectCohortSignals', () => {
  const members = Array.from({ length: 5 }, (_, i) => member(i + 1, 'ring.test'));

  it('does nothing at all for an empty cohort', async () => {
    const reader = fakeReader({});
    const s = await collectCohortSignals(reader, []);
    expect(reader.ipCalls).toEqual([]);
    expect(reader.contentCalls).toEqual([]);
    expect(s).toEqual(emptyCohortSignals());
  });

  it('chunks the cohort and indexes what comes back', async () => {
    const reader = fakeReader({
      ips: [
        { userId: 1, ip: 'x' },
        { userId: 4, ip: 'x' },
      ],
    });
    const s = await collectCohortSignals(reader, members, { chunkSize: 2 });
    expect(reader.ipCalls).toEqual([[1, 2], [3, 4], [5]]);
    expect(s.membersPerIp.get('x')).toBe(2);
    expect(s.sources.registrationIps).toBe(true);
  });

  it('🔴 does not call ClickHouse at all when the client is absent, and SAYS so', () => {
    // A zero from a missing source is indistinguishable from a zero meaning "these accounts share
    // nothing", and the two call for opposite conclusions.
    return collectCohortSignals(fakeReader({ hasIps: false }), members).then((s) => {
      expect(s.sources.registrationIps).toBe(false);
      expect(s.membersPerIp.size).toBe(0);
    });
  });

  it('🔴 discards PARTIAL IP data when a chunk fails, rather than scoring it', async () => {
    // A cluster count built from a partial read UNDERSTATES every ring that straddles the missing
    // chunk — and understating is the direction that produces a confident zero. So the whole
    // signal is dropped and the flag records it.
    const reader = fakeReader({ ipError: new Error('clickhouse down') });
    const log = vi.fn();
    const s = await collectCohortSignals(reader, members, { chunkSize: 2, log });
    expect(s.sources.registrationIps).toBe(false);
    expect(s.membersPerIp.size).toBe(0);
    // It stops rather than hammering a dead source once per chunk.
    expect(reader.ipCalls).toHaveLength(1);
    expect(log.mock.calls.map(([name]) => name)).toContain(
      'bot-account-detection:registration-ips-failed'
    );
  });

  it('a failing IP read does not stop the content read', async () => {
    // The heuristics are independent; one dead source must not cost the others.
    const text = 'Grab your 100 free credits at https://spam.example now';
    const reader = fakeReader({
      ipError: new Error('down'),
      content: [
        { userId: 1, content: text },
        { userId: 2, content: text },
        { userId: 3, content: text },
      ],
    });
    const s = await collectCohortSignals(reader, members, { chunkSize: 2 });
    expect(s.sources.registrationIps).toBe(false);
    expect(s.membersPerFingerprint.get(contentFingerprint(text) as string)).toBe(3);
  });

  it('🔴 stops reading content once the BUDGET is spent, and records that it did', async () => {
    // A per-query cap multiplied by a page count is not a bound on anything: the cohort can be tens
    // of thousands of accounts. The budget is what makes the worst case fixed.
    const content = members.flatMap((m) =>
      Array.from({ length: 4 }, () => ({
        userId: m.userId,
        content: `Grab your 100 free credits at https://spam.example now ${m.userId}`,
      }))
    );
    const reader = fakeReader({ content });
    const s = await collectCohortSignals(reader, members, { chunkSize: 2, maxContentSamples: 3 });
    // The first chunk consumes the budget; the walk stops rather than reading the remaining two.
    expect(reader.contentCalls).toHaveLength(1);
    expect(s.sources.contentBudgetExhausted).toBe(true);
    expect(s.sources.membersSampledForContent).toBe(2);
  });

  it('does not claim exhaustion when the whole cohort fit inside the budget', async () => {
    // The flag must mean "accounts were left unsampled", not "the budget happened to reach zero" —
    // the same distinction `cohort.capped` draws for the account walk.
    const reader = fakeReader({ content: [{ userId: 1, content: 'x' }] });
    const s = await collectCohortSignals(reader, members, { chunkSize: 5, maxContentSamples: 50 });
    expect(s.sources.contentBudgetExhausted).toBe(false);
    expect(s.sources.membersSampledForContent).toBe(5);
  });

  it('never asks for more rows than the budget has left', async () => {
    const reader = fakeReader({ content: [] });
    await collectCohortSignals(reader, members, { chunkSize: 2, maxContentSamples: 3 });
    for (const call of reader.contentCalls) expect(call.take).toBeLessThanOrEqual(3);
  });

  it('checks cancellation while it walks', async () => {
    // The scheduler cancels by closing the response; a walk that never looks keeps reading after
    // nobody is listening.
    const reader = fakeReader({});
    let checks = 0;
    await expect(
      collectCohortSignals(reader, members, {
        chunkSize: 2,
        checkCanceled: () => {
          checks += 1;
          if (checks > 1) throw new Error('Job was canceled');
        },
      })
    ).rejects.toThrow('Job was canceled');
  });
});

// ---------------------------------------------------------------------------------------------
// The real reader's wiring
// ---------------------------------------------------------------------------------------------

describe('createEvidenceReader', () => {
  const db = {
    comment: { findMany: vi.fn(async () => [{ userId: 1, content: 'a' }]) },
    commentV2: { findMany: vi.fn(async () => [{ userId: 2, content: 'b' }]) },
  };

  it('🔴 reports the IP source as unavailable when there is no ClickHouse client', async () => {
    const reader = createEvidenceReader({ db, ch: null });
    expect(reader.hasRegistrationIps).toBe(false);
    // And asking anyway returns nothing rather than throwing — the caller's flag is the record.
    expect(await reader.listRegistrationIps([1, 2])).toEqual([]);
  });

  it('reads both comment surfaces and merges them', async () => {
    // An account that only used the newer comment system would otherwise read as having posted no
    // text at all — a false negative in the one direction a detector must not have.
    const reader = createEvidenceReader({ db, ch: null });
    expect(await reader.listContentSamples([1, 2], 10)).toEqual([
      { userId: 1, content: 'a' },
      { userId: 2, content: 'b' },
    ]);
  });

  it('issues no statement for an empty id list or a zero take', async () => {
    const reader = createEvidenceReader({ db, ch: null });
    db.comment.findMany.mockClear();
    expect(await reader.listContentSamples([], 10)).toEqual([]);
    expect(await reader.listContentSamples([1], 0)).toEqual([]);
    expect(db.comment.findMany).not.toHaveBeenCalled();
  });

  it('coerces ClickHouse’s string integers and drops rows with no ip', async () => {
    // ClickHouse returns integers as strings over HTTP JSON; a `userId` left as a string would
    // never match a cohort member and the whole IP signal would silently be empty.
    // The port's `$query` is generic (`<T extends object>`) to mirror the real client's signature —
    // a fake with a concrete return type is NOT assignable to it, so the cast is on the FUNCTION
    // rather than on the object. Casting the object would hide a genuine shape mismatch; this way
    // only the unused type parameter is bypassed.
    const ch: EvidenceClickhouse = {
      $query: (async () => [
        { targetUserId: '7', ip: '203.0.113.9' },
        { targetUserId: '8', ip: '' },
      ]) as EvidenceClickhouse['$query'],
    };
    const reader = createEvidenceReader({ db, ch });
    expect(await reader.listRegistrationIps([7, 8])).toEqual([{ userId: 7, ip: '203.0.113.9' }]);
  });
});
