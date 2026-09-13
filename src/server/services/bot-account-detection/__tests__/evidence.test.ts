import { NON_PUBLIC_IP_RANGES, publicIpOnlySql } from '@civitai/shared/clickhouse-ip-filters';
import { describe, expect, it, vi } from 'vitest';
import { MAX_COHORT_ACCOUNTS } from '../cohort';
import type { BotAccountCohortMember, SurfaceCounts } from '../cohort';
import {
  MAX_CONTENT_CHARS,
  MAX_CONTENT_SAMPLES,
  MAX_IPS_PER_ACCOUNT,
  EVIDENCE_CHUNK_SIZE,
  MIN_FINGERPRINT_CHARS,
  MIN_FINGERPRINT_TOKENS,
  buildCohortSignals,
  chunk,
  clickhouseDateTime,
  collectCohortSignals,
  contentFingerprint,
  contentSampleArgs,
  createEvidenceReader,
  emptyCohortSignals,
  normalizeContent,
  registrationIpSql,
  MAX_FILENAME_SAMPLES,
  MAX_FILENAMES_PER_MEMBER,
  FILENAME_READ_BATCH_SIZE,
  filenameFingerprint,
  filenameSampleArgs,
  normalizeFilename,
  type ContentSampleRow,
  type EvidenceClickhouse,
  type EvidenceReader,
  type FilenameSampleRow,
  type RegistrationIpRow,
} from '../evidence';
import {
  FILENAME_FINGERPRINT_PREFIX,
  TEXT_FINGERPRINT_PREFIX,
  unprefixFingerprint,
} from '../fingerprint-keys';

/** The NAMESPACED index key for a piece of text — what `membersPerFingerprint` is keyed by.
 *  `contentFingerprint` itself still returns the bare normalised form. */
const textKey = (raw: string) => `${TEXT_FINGERPRINT_PREFIX}${contentFingerprint(raw) as string}`;

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

  it('🔴 KNOWN FALSE POSITIVE, PINNED: a generation-parameter paste collides with itself', () => {
    // 🔴 THIS IS NOT A GUARD, IT IS A RECORD. Pasting settings under a model is one of the most
    // ordinary comments on this site, and the digit masking that makes a swapped payout match ALSO
    // makes two unrelated parameter pastes match: every number in them is a `nummask`. Six such
    // accounts in one day's cohort read as a ring of six and are reported.
    //
    // It is asserted so the collision cannot quietly stop being true — a normaliser change that
    // fixed it should have to delete this case deliberately, and one that made it WORSE (a longer
    // paste form colliding too) is a diff a reader can see. `similarity.ts` records why the two
    // candidate fixes were rejected on the arithmetic below.
    const a = contentFingerprint(
      'Steps: 20, Sampler: Euler a, CFG scale: 7, Seed: 1234567890, Size: 512x768'
    );
    const b = contentFingerprint(
      'Steps: 35, Sampler: Euler a, CFG scale: 4, Seed: 9987654321, Size: 768x1024'
    );
    expect(a).toBe(b);
    expect(a).not.toBeNull();

    // 🔴 THE MEASUREMENT THAT KILLED THE "DISCARD MASK-HEAVY FINGERPRINTS" FIX. Run over the
    // SHIPPED normaliser, not argued: the two classes do not merely sit close, they INTERLEAVE in
    // both directions, so no threshold exists in either.
    const maskRatio = (fp: string) => {
      const tokens = fp.split(' ').filter(Boolean);
      return tokens.filter((t) => t === 'nummask' || t === 'linkmask').length / tokens.length;
    };
    const fp = (s: string) => contentFingerprint(s) as string;
    // The commonest real form — the whole metadata block including the prompt — and an ordinary
    // shill template are EXACTLY equal at 2/7. A cut cannot go between two identical values.
    const pasteWithPrompt = fp(
      'masterpiece, best quality, 1girl, detailed eyes, Steps: 20, Sampler: Euler a, ' +
        'CFG scale: 7, Seed: 1234567890, Size: 512x768'
    );
    const shillLink = fp('check out https://mysite.example/a for 500 free buzz');
    expect(maskRatio(pasteWithPrompt)).toBeCloseTo(6 / 21, 12);
    expect(maskRatio(shillLink)).toBeCloseTo(2 / 7, 12);
    expect(maskRatio(pasteWithPrompt)).toBeCloseTo(maskRatio(shillLink), 12);

    // And the ordering INVERTS at the other end: the shortest shill template is mask-heavier than
    // the longest parameter paste, so a cut high enough to spare shill text discards nothing and a
    // cut low enough to catch pastes discards shill text first.
    const shillMinimal = fp('free buzz https://x.example 999');
    const pasteLong = fp(
      'Steps: 30, Sampler: DPM++ 2M Karras, CFG scale: 7, Seed: 1234567890, Size: 512x768, ' +
        'Model hash: a1b2c3d4, Model: dreamShaper_8, Denoising strength: 0.45, Clip skip: 2'
    );
    expect(maskRatio(shillMinimal)).toBeGreaterThan(maskRatio(pasteLong));
    // A positive control on the measure itself: a zero everywhere would make every comparison above
    // vacuously agree.
    expect(maskRatio(fp('This checkpoint handles hands surprisingly well overall'))).toBe(0);
    expect(maskRatio(a as string)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Filename normalisation and fingerprinting
// ---------------------------------------------------------------------------------------------

describe('normalizeFilename', () => {
  it('🔴 lowercases, which is what folds two halves of one real cluster together', () => {
    // Not cosmetic. In one production cohort `Logo.jpg` and `logo.jpg` were two separate clusters
    // of ten — two groups sitting low on the ramp instead of one group of twenty.
    expect(normalizeFilename('Logo.jpg')).toBe('logo.jpg');
    expect(normalizeFilename('LOGO.JPG')).toBe('logo.jpg');
    expect(normalizeFilename('logo.jpg')).toBe('logo.jpg');
  });

  it('trims and collapses whitespace', () => {
    expect(normalizeFilename('  my   photo.png  ')).toBe('my photo.png');
  });

  it('🔴 does NOT mask digits — masking would collapse every numbered upload into one key', () => {
    // The whole reason this is not `normalizeContent`. Under that function both of these become
    // `nummask jpg jpeg`, so every `<digits>.jpg` on the site is ONE cluster and the largest group
    // in any cohort becomes an artefact of camera naming rather than a ring.
    expect(normalizeFilename('1900.jpg.jpeg')).toBe('1900.jpg.jpeg');
    expect(normalizeFilename('2749.jpg.jpeg')).toBe('2749.jpg.jpeg');
    expect(normalizeFilename('1900.jpg.jpeg')).not.toBe(normalizeFilename('2749.jpg.jpeg'));
  });

  it('🔴 does NOT strip punctuation — the dot and the extension are part of the identity', () => {
    expect(normalizeFilename('my-file_v2.final.png')).toBe('my-file_v2.final.png');
  });
});

describe('filenameFingerprint', () => {
  it('namespaces the key, so a filename is never confused with a text fingerprint', () => {
    expect(filenameFingerprint('logo.jpg')).toBe(`${FILENAME_FINGERPRINT_PREFIX}logo.jpg`);
  });

  it('🔴 THE REGRESSION THIS SOURCE EXISTS FOR: the PROSE floors are not applied to filenames', () => {
    // 🔴 MEASURED BY EXECUTING THE SHIPPED NORMALISER, not by reading it. `contentFingerprint`
    // rejects BOTH of these outright — `1900.jpg.jpeg` normalises to `"nummask jpg jpeg"` (16
    // chars, 3 tokens) and `logo.jpg` to `"logo jpg"` (8 chars, 2 tokens), against floors of 24
    // chars and 4 tokens. Both were filenames a confirmed ring actually shared, so reusing the
    // prose floors here would have discarded the signal this whole change is about.
    //
    // The floors are right for prose and wrong for filenames: they exist because a SHORT SENTENCE
    // is written independently by unrelated people, which is a fact about sentences.
    expect(contentFingerprint('1900.jpg.jpeg')).toBeNull();
    expect(contentFingerprint('logo.jpg')).toBeNull();
    expect(filenameFingerprint('1900.jpg.jpeg')).not.toBeNull();
    expect(filenameFingerprint('logo.jpg')).not.toBeNull();
  });

  it('🔴 folds case, so `Logo.jpg` and `logo.jpg` are ONE cluster key', () => {
    expect(filenameFingerprint('Logo.jpg')).toBe(filenameFingerprint('logo.jpg'));
  });

  it('🔴 refuses a missing or blank name rather than keying on the empty string', () => {
    // `Image.name` is nullable. An upload with no name is not a member of the empty-string
    // cluster, and letting it become one would build the largest cluster in every cohort out of
    // accounts that share nothing at all.
    expect(filenameFingerprint(null)).toBeNull();
    expect(filenameFingerprint(undefined)).toBeNull();
    expect(filenameFingerprint('')).toBeNull();
    expect(filenameFingerprint('   ')).toBeNull();
  });
});

describe('unprefixFingerprint', () => {
  it('strips either namespace and leaves an unprefixed key alone', () => {
    expect(unprefixFingerprint(`${FILENAME_FINGERPRINT_PREFIX}logo.jpg`)).toBe('logo.jpg');
    expect(unprefixFingerprint(`${TEXT_FINGERPRINT_PREFIX}free buzz linkmask`)).toBe(
      'free buzz linkmask'
    );
    expect(unprefixFingerprint('no prefix here')).toBe('no prefix here');
  });

  it('🔴 does not truncate a normalised text at its first colon', () => {
    // The naive implementation — slice at `indexOf(':')` — would eat the front of any text
    // containing a colon, which every generation-parameter paste does.
    expect(unprefixFingerprint('steps: 20, sampler: euler')).toBe('steps: 20, sampler: euler');
  });
});

describe('filenameSampleArgs', () => {
  it('reads the newest images of exactly ONE account, bounded, two columns', () => {
    const args = filenameSampleArgs(1, 50);
    expect(args.where.userId).toBe(1);
    expect(args.select).toEqual({ userId: true, name: true });
    expect(args.take).toBe(50);
  });

  it('🔴 pins `userId` to a SCALAR EQUALITY — never an `IN (…)` list under a LIMIT', () => {
    // 🔴 THE REGRESSION GUARD FOR THE READ THAT NEVER COMPLETED. The shipped shape was
    // `WHERE userId IN (…hundreds…) AND createdAt <= $1 ORDER BY id DESC LIMIT <take>`, and on a
    // table the size of `Image` the planner's estimate for a wide `IN (…)` list is off by three
    // orders of magnitude — it expects six figures' worth of matches where the cohort owns three. On that
    // estimate a backward primary-key scan looks cheap, because the LIMIT is expected to be hit
    // immediately. A day's new accounts own FEWER rows than the LIMIT asks for, so the LIMIT is
    // never reached, the early exit never fires, and the scan walks the whole table. Measured on a
    // replica: over 150 seconds versus 20 ms for the per-account read, and the connection was
    // closed under it in production.
    //
    // 🔴 THE GUARD IS ON THE SHAPE, NOT ON THE LIST WIDTH, because narrowing the list does not fix
    // it: the same backward primary-key scan was measured at 100, 50 and 25 ids — a shorter list
    // lowers the estimate and the LIMIT together and leaves the reasoning intact. Only an equality
    // on the leading column of `image_userid_id_idx` makes the ORDER BY index-supplied and the
    // LIMIT reachable. So this asserts a NUMBER, which no `{ in: [...] }` of any width satisfies.
    const where = filenameSampleArgs(7, 10).where;
    expect(typeof where.userId).toBe('number');
    expect(where.userId).not.toHaveProperty('in');
  });

  it('🔴 orders by id, NOT createdAt', () => {
    // `schema.prisma` declares `(userId, postId)` and `(userId, id)` (`image_userid_id_idx`) on
    // `Image` and no `(userId, createdAt)`, so ordering on `createdAt` would sort a member's image
    // history outside any declared index. `id` is monotonic on an append-only table, so descending
    // `id` is descending upload order — and the `take` means the ORDER decides which rows a bounded
    // read keeps.
    expect(filenameSampleArgs(1, 10).orderBy).toEqual({ id: 'desc' });
  });

  it('🔴 DOES NOT FILTER ON ingestion OR needsReview — the blocked rows ARE the signal', () => {
    // 🔴 THE MOST LOAD-BEARING ABSENCE IN THIS MODULE, pinned as a ledger rather than as prose.
    // There is a partial index covering `ingestion = 'Scanned' AND needsReview IS NULL`, so adding
    // either predicate looks like free performance — and would delete exactly the population this
    // heuristic reads, because the images a templated ring uploads are the ones the scanner blocks.
    // An account surviving while its content is removed is the case the detector exists for.
    //
    // Asserted as the EXACT key set of `where`, so a new filter of ANY name fails here. A test
    // naming only `ingestion` and `needsReview` would be walkable by a third predicate.
    expect(Object.keys(filenameSampleArgs(1, 10).where).sort()).toEqual(['userId']);
    expect(Object.keys(filenameSampleArgs(1, 10, new Date()).where).sort()).toEqual([
      'createdAt',
      'userId',
    ]);
  });

  it('bounds on createdAt when given a window, and omits it when not', () => {
    const before = new Date('2026-09-03T12:00:00.000Z');
    expect(filenameSampleArgs(1, 10, before).where).toMatchObject({
      createdAt: { lte: before },
    });
    expect(filenameSampleArgs(1, 10).where).not.toHaveProperty('createdAt');
  });
});

describe('the module constants', () => {
  it('🔴 pins every bound a run is sized by, so moving one is a deliberate edit', () => {
    // 🔴 FOUR OF THESE WERE UNTESTED. A constant nothing asserts can be changed by a mutant — or by
    // a maintainer — with the entire suite green, and each of these decides how much of a wave a
    // run actually sees: the budget is the ceiling on content read at all, the chunk size is the
    // width of every `IN (…)` list, and the truncation is what bounds both the memory a run holds
    // and what counts as "the same text".
    expect(MAX_CONTENT_SAMPLES).toBe(5_000);
    // 🔴 A SEPARATE BUDGET, AND LARGER. Pinned so a later "tidy-up" that folds the filename read
    // into the content allowance is a deliberate, visible edit rather than a silent one — the two
    // populations are wildly unequal (a day's new accounts produce a handful of comments and
    // thousands of images) and sharing one budget starves the half with the signal in it.
    expect(MAX_FILENAME_SAMPLES).toBe(20_000);
    expect(MAX_FILENAME_SAMPLES).toBeGreaterThan(MAX_CONTENT_SAMPLES);
    expect(EVIDENCE_CHUNK_SIZE).toBe(500);
    expect(MAX_CONTENT_CHARS).toBe(512);
    expect(MIN_FINGERPRINT_CHARS).toBe(24);
    expect(MIN_FINGERPRINT_TOKENS).toBe(4);
    expect(MAX_IPS_PER_ACCOUNT).toBe(4);
    // 🔴 THE PER-ACCOUNT CAP, PINNED FOR THE SAME REASON `MAX_IPS_PER_ACCOUNT` IS — they are the
    // same idea on the two sources, and the defect they both prevent is one account spending an
    // allowance the rest of its batch needed.
    expect(MAX_FILENAMES_PER_MEMBER).toBe(50);
    // 🔴 THE BATCH IS A CONCURRENCY WINDOW AND MUST STAY WELL UNDER THE `IN (…)` WIDTH. The filename
    // read is one statement per member, so setting this to the chunk width would put 500 statements
    // in flight from one job against a pool the whole process shares.
    expect(FILENAME_READ_BATCH_SIZE).toBe(10);
    expect(FILENAME_READ_BATCH_SIZE).toBeLessThan(EVIDENCE_CHUNK_SIZE);
    // The worst-case overshoot past the budget, as arithmetic rather than prose: one batch's rows,
    // which must stay small against the budget it can overshoot.
    expect(FILENAME_READ_BATCH_SIZE * MAX_FILENAMES_PER_MEMBER).toBeLessThan(
      MAX_FILENAME_SAMPLES / 10
    );
  });

  it('pins the cohort size over which filename coverage is UNCONDITIONAL (invariant guard)', () => {
    // 🔴 AN INVARIANT GUARD, NOT REGRESSION COVERAGE — it is green before this assertion existed and
    // catches no bug. It exists because the per-member cap's coverage claim is CONDITIONAL on a
    // budget that did not move with it, and that condition was being stated in prose only. Worst
    // case is `members × MAX_FILENAMES_PER_MEMBER` rows against `MAX_FILENAME_SAMPLES`, so every
    // member is reached unconditionally only up to this many members.
    expect(MAX_FILENAME_SAMPLES / MAX_FILENAMES_PER_MEMBER).toBe(400);
    // 🔴 AND IT IS REACHABLE, which is the half that makes the condition worth writing down: the
    // cohort walk admits far more accounts than that, so a wave day can still stop the filename walk
    // short — `sources.filenameBudgetExhausted` is what says it did. Raising the per-member cap
    // without raising the budget narrows this range in direct proportion.
    expect(MAX_FILENAME_SAMPLES / MAX_FILENAMES_PER_MEMBER).toBeLessThan(MAX_COHORT_ACCOUNTS);
  });

  it('renders a ClickHouse DateTime literal, not an ISO string', () => {
    // The `Z`-suffixed ISO form is not accepted by ClickHouse, and a rejected statement is a whole
    // heuristic dark for a day with nothing but a caught error to say so.
    expect(clickhouseDateTime(new Date('2026-09-03T03:20:00.000Z'))).toBe('2026-09-03 03:20:00');
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

  it('🔴 pins the SELECT PROJECTION, not only the WHERE clause', () => {
    // 🔴 THE MUTANT THIS EXISTS FOR: `SELECT targetUserId, ip` → `SELECT userId, ip`, leaving the
    // WHERE alone. Every other case in this describe passed. Rows then come back keyed `userId`,
    // `Number(row.targetUserId)` is `Number(undefined)` = `NaN`, the `Number.isFinite` filter drops
    // every row, and `sources.registrationIps` stays TRUE — a zero that says the source answered.
    // The projection is what decides the KEY the reader destructures, so it is behaviour, not
    // formatting.
    const sql = registrationIpSql([7, 8]);
    expect(sql).toContain('SELECT targetUserId, ip');
    // The `GROUP BY` names it too, and the two must not drift apart: grouping on one column while
    // projecting another is the same silent zero arrived at from the other side.
    expect(sql).toContain('GROUP BY targetUserId, ip');
  });

  it('🔴 excludes private and carrier-internal space — the shared predicate, not a copy', () => {
    // 🔴 WITHOUT THIS THE HEURISTIC IS WORSE THAN ABSENT. Private space correlates everyone and
    // therefore no one: six cohort members behind one `10.124/16` address or one proxy reach a
    // reported score, and ten of them top the run's whole distribution from an infrastructure
    // address — a confident finding produced by omission.
    const sql = registrationIpSql([1]);
    for (const range of NON_PUBLIC_IP_RANGES)
      expect(sql).toContain(`NOT isIPAddressInRange(ip, '${range}')`);
    // A positive control on the list itself: an empty `NON_PUBLIC_IP_RANGES` would make the loop
    // above vacuous, and it is imported from another package.
    expect(NON_PUBLIC_IP_RANGES.length).toBeGreaterThanOrEqual(6);
    expect(NON_PUBLIC_IP_RANGES).toContain('10.0.0.0/8');

    // 🔴 `isIPAddressInRange` RAISES on an empty string and `userActivities` holds a handful, so
    // whether this query throws depends on whether a blank row lands in the scanned range — it
    // passes in testing and breaks later, once. The guard has to come FIRST.
    expect(sql).toContain(`ip != ''`);
    expect(sql.indexOf(`ip != ''`)).toBeLessThan(sql.indexOf('isIPAddressInRange'));
  });

  it('bounds the addresses PER ACCOUNT, not per result', () => {
    // 🔴 `LIMIT ids.length * 4` was a cap on the RESULT with no `ORDER BY` under it: one account
    // with many distinct registration addresses could consume the whole allowance and evict every
    // other account in its chunk, silently, understating every ring that straddled it. The comment
    // claimed a per-account cap; only `LIMIT n BY` delivers one.
    const sql = registrationIpSql([1, 2]);
    expect(sql).toContain(`LIMIT ${MAX_IPS_PER_ACCOUNT} BY targetUserId`);
    // `ORDER BY` is what makes which addresses survive the per-account cap deterministic rather
    // than whatever the merge happened to emit first.
    expect(sql).toContain('ORDER BY targetUserId, ip');
    // The total is still bounded — the property the old `LIMIT` was there for is not lost.
    expect(MAX_IPS_PER_ACCOUNT).toBe(4);
  });

  it('bounds the scan on `time` when it is given a window, and omits it when it is not', () => {
    // `time` is this table's pruning column. Every cohort account was created after the window
    // opened, so its registration event cannot predate it: the predicate removes no row the query
    // wants and is the difference between fifty unpruned chunk scans and fifty pruned ones.
    const windowed = registrationIpSql([1], new Date('2026-09-03T03:20:00.000Z'));
    // ClickHouse's `DateTime` literal form. The `Z`-suffixed ISO string is NOT accepted, and a
    // rejected statement here is a whole heuristic dark for a day.
    expect(windowed).toContain(`AND time >= '2026-09-03 03:20:00'`);
    expect(windowed).not.toContain('T03:20:00');
    expect(windowed).not.toContain(`03:20:00.000Z'`);

    // Optional: a caller with no window still gets a correct, merely unpruned, answer.
    expect(registrationIpSql([1])).not.toContain('time >=');
  });
});

describe('publicIpOnlySql', () => {
  it('🔴 THROWS on a column that is not a bare identifier, rather than interpolating it', () => {
    // 🔴 THE PRECONDITION WAS A COMMENT ONLY, ON A NEW SHARED EXPORT. The value is concatenated into
    // a ClickHouse statement and the client does no escaping — the sibling `IP_PATTERN` in
    // `apps/moderator/src/lib/server/clickhouse-filters.ts` exists for exactly that reason. Both
    // call sites pass the default today, so this is closed BEFORE the parameter spreads.
    //
    // Watching the throw is the point: a guard nobody has seen go red is a claim about the regex.
    expect(() => publicIpOnlySql("ip' OR 1=1 --")).toThrow(/bare SQL identifier/);
    expect(() => publicIpOnlySql('ip)')).toThrow(/bare SQL identifier/);
    expect(() => publicIpOnlySql('remote.ip')).toThrow(/bare SQL identifier/);
    expect(() => publicIpOnlySql('')).toThrow(/bare SQL identifier/);
    expect(() => publicIpOnlySql('1ip')).toThrow(/bare SQL identifier/);

    // The negative control on the guard itself: a legitimate column must still get through, or the
    // regex could be `/^$/` and every case above would pass for the wrong reason.
    expect(publicIpOnlySql()).toContain(`ip != ''`);
    expect(publicIpOnlySql('clientIp')).toContain(`clientIp != ''`);
    expect(publicIpOnlySql('_ip2')).toContain(`_ip2 != ''`);
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
    contentSamples: true,
    contentBudgetExhausted: false,
    membersSampledForContent: 3,
    filenameSamples: true,
    filenameBudgetExhausted: false,
    membersSampledForFilenames: 3,
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
    // The INDEX key is namespaced; `contentFingerprint` itself still returns the bare normalised
    // form, which is what the reason string quotes. See `fingerprint-keys.ts`.
    const fp = textKey(text);
    expect(s.membersPerFingerprint.get(fp)).toBe(2);
    expect(s.fingerprintsByUser.get(1)).toEqual([fp]);
  });

  it('🔴 counts DISTINCT accounts per FILENAME, not uploads', () => {
    // The same invariant in the filename axis, and the one that stops a single prolific account
    // manufacturing a ring out of itself: account 1 uploads `logo.jpg` ninety times and is ONE
    // member of that cluster. Without this a lone bulk uploader tops the run's distribution.
    const s = buildCohortSignals({
      members: [member(1), member(2)],
      registrationIps: [],
      contentSamples: [],
      filenameSamples: Array.from({ length: 90 }, () => ({ userId: 1, name: 'logo.jpg' })).concat([
        { userId: 2, name: 'logo.jpg' },
      ]),
      sources,
    });
    expect(s.membersPerFingerprint.get(filenameFingerprint('logo.jpg') as string)).toBe(2);
    expect(s.fingerprintsByUser.get(1)).toEqual([filenameFingerprint('logo.jpg')]);
  });

  it('🔴 folds case across ACCOUNTS, so `Logo.jpg` and `logo.jpg` are one cluster of three', () => {
    // The real cohort shape this was measured on: two spellings of one filename, each looking like
    // a small group, that are one larger group once folded.
    const s = buildCohortSignals({
      members: [member(1), member(2), member(3)],
      registrationIps: [],
      contentSamples: [],
      filenameSamples: [
        { userId: 1, name: 'Logo.jpg' },
        { userId: 2, name: 'logo.jpg' },
        { userId: 3, name: 'LOGO.JPG' },
      ],
      sources,
    });
    expect(s.membersPerFingerprint.get(filenameFingerprint('logo.jpg') as string)).toBe(3);
    // And exactly one key exists for them, rather than three that each fall below the floor.
    expect([...s.membersPerFingerprint.keys()]).toEqual([filenameFingerprint('logo.jpg')]);
  });

  it('🔴 A FILENAME CANNOT COLLIDE WITH A TEXT FINGERPRINT OF THE SAME STRING', () => {
    // 🔴 THE NAMESPACE GUARD, AND IT IS NOT HYPOTHETICAL. `normalizeContent` strips the dot out of
    // `logo.jpg` and yields `logo jpg`; a comment saying "logo jpg" normalises to that too. Sharing
    // one `Map<string, number>` without prefixes would merge uploaders and commenters into a single
    // cluster — a ring of three assembled out of two unrelated behaviours.
    //
    // Built so the two WOULD collide without the prefixes: the text below is chosen to normalise to
    // exactly the filename's own normalised form.
    const text = 'logo jpg download free now';
    const s = buildCohortSignals({
      members: [member(1), member(2), member(3)],
      registrationIps: [],
      contentSamples: [
        { userId: 1, content: text },
        { userId: 2, content: text },
      ],
      filenameSamples: [
        { userId: 3, name: normalizeContent(text) },
        { userId: 4, name: normalizeContent(text) },
      ],
      sources,
    });
    // Two separate clusters of 2 — NOT one cluster of 3 (member 4 is outside the cohort).
    expect(s.membersPerFingerprint.get(textKey(text))).toBe(2);
    expect(s.membersPerFingerprint.get(filenameFingerprint(normalizeContent(text)) as string)).toBe(
      1
    );
    // The two keys are different strings even though the underlying value is identical.
    expect(textKey(text)).not.toBe(filenameFingerprint(normalizeContent(text)));
    expect(unprefixFingerprint(textKey(text))).toBe(
      unprefixFingerprint(filenameFingerprint(normalizeContent(text)) as string)
    );
  });

  it('drops an upload with no filename rather than clustering on the empty string', () => {
    const s = buildCohortSignals({
      members: [member(1), member(2), member(3)],
      registrationIps: [],
      contentSamples: [],
      filenameSamples: [
        { userId: 1, name: null },
        { userId: 2, name: null },
        { userId: 3, name: '  ' },
      ],
      sources,
    });
    expect([...s.membersPerFingerprint.keys()]).toEqual([]);
  });

  it('🔴 ignores FILENAME rows for accounts outside the cohort', () => {
    // The twin of the content/IP guard: a row for an id the run is not scoring must not inflate a
    // cluster nobody is a member of.
    const s = buildCohortSignals({
      members: [member(1), member(2)],
      registrationIps: [],
      contentSamples: [],
      filenameSamples: [
        { userId: 1, name: 'logo.jpg' },
        { userId: 2, name: 'logo.jpg' },
        { userId: 999, name: 'logo.jpg' },
      ],
      sources,
    });
    expect(s.membersPerFingerprint.get(filenameFingerprint('logo.jpg') as string)).toBe(2);
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
        readFailures: { registrationIps: true, contentSamples: false, filenameSamples: false },
        registrationIps: false,
        contentSamples: true,
        contentBudgetExhausted: true,
        membersSampledForContent: 7,
        filenameSamples: true,
        filenameBudgetExhausted: true,
        membersSampledForFilenames: 4,
      },
    });
    expect(s.sources).toEqual({
      readFailures: { registrationIps: true, contentSamples: false, filenameSamples: false },
      registrationIps: false,
      contentSamples: true,
      contentBudgetExhausted: true,
      membersSampledForContent: 7,
      filenameSamples: true,
      filenameBudgetExhausted: true,
      membersSampledForFilenames: 4,
    });
  });
});

describe('emptyCohortSignals', () => {
  it('🔴 defaults every source to "did not run", which is the safe reading', () => {
    // A run with no evidence reader must not look like a run that found no rings. Both source
    // flags default to false for that reason — including `contentSamples`, whose false means "no
    // content was read", never "the cohort posted nothing that matched".
    expect(emptyCohortSignals().sources).toEqual({
      // 🔴 THE ONE GROUP WHOSE `false` IS NOT "did not run". An index over nothing is not an
      // outage, and defaulting these to true would make every empty cohort page an operator.
      readFailures: { registrationIps: false, contentSamples: false, filenameSamples: false },
      registrationIps: false,
      contentSamples: false,
      contentBudgetExhausted: false,
      membersSampledForContent: 0,
      // The filename source defaults the same way and for the same reason: a run with no evidence
      // reader must not look like a cohort that shared no filenames.
      filenameSamples: false,
      filenameBudgetExhausted: false,
      membersSampledForFilenames: 0,
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
  filenames?: FilenameSampleRow[];
  hasIps?: boolean;
  ipError?: Error;
  contentError?: Error;
  filenameError?: Error;
}): EvidenceReader & {
  ipCalls: number[][];
  ipWindows: Array<Date | undefined>;
  contentCalls: Array<{ ids: number[]; take: number }>;
  filenameCalls: Array<{ ids: number[]; take: number; createdBefore: Date | undefined }>;
} {
  const ipCalls: number[][] = [];
  const ipWindows: Array<Date | undefined> = [];
  const contentCalls: Array<{ ids: number[]; take: number }> = [];
  const filenameCalls: Array<{ ids: number[]; take: number; createdBefore: Date | undefined }> = [];
  return {
    ipCalls,
    ipWindows,
    contentCalls,
    filenameCalls,
    hasRegistrationIps: opts.hasIps ?? true,
    listRegistrationIps: async (ids, createdAfter) => {
      ipCalls.push(ids);
      ipWindows.push(createdAfter);
      if (opts.ipError) throw opts.ipError;
      return (opts.ips ?? []).filter((r) => ids.includes(r.userId));
    },
    listContentSamples: async (ids, take) => {
      contentCalls.push({ ids, take });
      if (opts.contentError) throw opts.contentError;
      return (opts.content ?? []).filter((r) => ids.includes(r.userId)).slice(0, take);
    },
    // 🔴 THE FAKE MODELS THE PER-MEMBER CAP, and getting this wrong is how the defect stayed
    // invisible. It used to `.slice(0, take)` the whole batch — i.e. the fake encoded the same
    // global-take semantics the broken query had, so no test built on it could ever observe an
    // account being evicted by another. A fake that reproduces the code's mistake makes the suite
    // agree with the bug.
    listFilenameSamples: async (ids, perMemberTake, createdBefore) => {
      filenameCalls.push({ ids, take: perMemberTake, createdBefore });
      if (opts.filenameError) throw opts.filenameError;
      return ids.flatMap((id) =>
        (opts.filenames ?? []).filter((r) => r.userId === id).slice(0, perMemberTake)
      );
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
    expect(s.membersPerFingerprint.get(textKey(text))).toBe(3);
  });

  it('🔴 a failing CONTENT read degrades the run instead of killing it', async () => {
    // 🔴 THE FAILURE THIS EXISTS TO PREVENT. `listContentSamples` had no guard at all, so a timeout
    // on a busy replica propagated out of `runBotAccountDetection` and NO REPORT WAS FILED — losing
    // the velocity heuristic's day with it, and looking exactly like a producer that stopped
    // running. The IP loop already had this shape; this is the same contract on the other read.
    const reader = fakeReader({ contentError: new Error('replica timeout') });
    const log = vi.fn();
    const s = await collectCohortSignals(reader, members, { chunkSize: 2, log });

    // It does not throw, the rest of the index is intact, and the flag says which half is missing.
    expect(s.sources.contentSamples).toBe(false);
    expect(s.membersPerFingerprint.size).toBe(0);
    // The domain half of the clustering heuristic costs no read and is unaffected.
    expect(s.membersPerDomain.get('ring.test')).toBe(5);
    // It stops rather than hammering a dead source once per chunk.
    expect(reader.contentCalls).toHaveLength(1);
    expect(log.mock.calls.map(([name]) => name)).toContain(
      'bot-account-detection:content-samples-failed'
    );
    // 🔴 A FAILED READ IS NOT AN EXHAUSTED BUDGET. Reporting it as one would send a grading pass
    // looking for a cohort too large rather than for a broken replica, and `membersSampled` must
    // not claim members whose samples were discarded.
    expect(s.sources.contentBudgetExhausted).toBe(false);
    expect(s.sources.membersSampledForContent).toBe(0);
  });

  it('discards the PARTIAL content already read when a later chunk fails', async () => {
    // Same argument as the IP loop's: a fingerprint count built from some of the chunks understates
    // every ring that straddles the missing ones, and understating produces the confident zero.
    const text = 'Grab your 100 free credits at https://spam.example now';
    let calls = 0;
    const reader: EvidenceReader = {
      hasRegistrationIps: false,
      listRegistrationIps: async () => [],
      listFilenameSamples: async () => [],
      listContentSamples: async (ids) => {
        calls += 1;
        if (calls > 1) throw new Error('replica timeout');
        return ids.map((userId) => ({ userId, content: text }));
      },
    };
    const s = await collectCohortSignals(reader, members, { chunkSize: 2 });
    expect(calls).toBe(2);
    expect(s.sources.contentSamples).toBe(false);
    // The two rows the FIRST chunk returned are gone, not scored as a two-account cluster.
    expect(s.membersPerFingerprint.size).toBe(0);
    expect(s.fingerprintsByUser.size).toBe(0);
  });

  it('reports the content source as present on an ordinary run', async () => {
    // Emitted true, not merely absent-when-false: the flag has to distinguish "read fine, nobody
    // matched" from "read did not happen", and only asserting the false side leaves the true side
    // free to be wrong.
    const s = await collectCohortSignals(fakeReader({ content: [] }), members, { chunkSize: 2 });
    expect(s.sources.contentSamples).toBe(true);
  });

  it('walks the cohort for filenames and indexes what comes back', async () => {
    const reader = fakeReader({
      filenames: [
        { userId: 1, name: 'logo.jpg' },
        { userId: 2, name: 'Logo.jpg' },
        { userId: 3, name: 'logo.jpg' },
      ],
    });
    const s = await collectCohortSignals(reader, members, { chunkSize: 2 });
    expect(s.sources.filenameSamples).toBe(true);
    expect(s.membersPerFingerprint.get(filenameFingerprint('logo.jpg') as string)).toBe(3);
  });

  it('🔴 a failing FILENAME read degrades the run instead of killing it, and says so', async () => {
    // Same contract as the content read: the partial data is DISCARDED rather than scored, because
    // a cluster count built from some of the chunks understates every ring that straddles the
    // missing ones — and understating is the direction that produces a confident zero.
    const text = 'Grab your 100 free credits at https://spam.example now';
    const s = await collectCohortSignals(
      fakeReader({
        filenameError: new Error('replica timeout'),
        content: [
          { userId: 1, content: text },
          { userId: 2, content: text },
          { userId: 3, content: text },
        ],
      }),
      members,
      { chunkSize: 2 }
    );
    expect(s.sources.filenameSamples).toBe(false);
    expect(s.sources.filenameBudgetExhausted).toBe(false);
    expect(s.sources.membersSampledForFilenames).toBe(0);
    // 🔴 THE OTHER SOURCE IS UNHARMED. The two reads fail independently, which is exactly why they
    // carry separate flags rather than one shared one.
    expect(s.sources.contentSamples).toBe(true);
    expect(s.membersPerFingerprint.get(textKey(text))).toBe(3);
  });

  it('🔴 a failing CONTENT read does not take the filename read down with it', async () => {
    // The mirror direction, asserted separately: a single flag covering both would let a live
    // filename read vouch for a comment read that never happened, or vice versa.
    const s = await collectCohortSignals(
      fakeReader({
        contentError: new Error('down'),
        filenames: [
          { userId: 1, name: 'logo.jpg' },
          { userId: 2, name: 'logo.jpg' },
          { userId: 3, name: 'logo.jpg' },
        ],
      }),
      members,
      { chunkSize: 2 }
    );
    expect(s.sources.contentSamples).toBe(false);
    expect(s.sources.filenameSamples).toBe(true);
    expect(s.membersPerFingerprint.get(filenameFingerprint('logo.jpg') as string)).toBe(3);
  });

  it('🔴 stops reading filenames once ITS OWN budget is spent, and records that it did', async () => {
    const reader = fakeReader({
      filenames: Array.from({ length: 5 }, (_, i) => ({ userId: i + 1, name: `f${i}.jpg` })),
    });
    // 🔴 `filenameBatchSize` IS PASSED, NOT INHERITED FROM `chunkSize`. The budget can only be seen
    // to stop the walk if the walk has more than one batch in it, and this test used to get that
    // implicitly from a default that narrowed the batch to the chunk width. That coupling is gone —
    // see the option's docstring — so the condition the test needs is now stated. Same assertions,
    // same conditions; nothing here is weakened.
    const s = await collectCohortSignals(reader, members, {
      chunkSize: 2,
      filenameBatchSize: 2,
      maxFilenameSamples: 2,
    });
    expect(s.sources.filenameBudgetExhausted).toBe(true);
    expect(s.sources.membersSampledForFilenames).toBeLessThan(members.length);
  });

  it('🔴 records WHICH read threw, in a field nothing but a `catch` can set', async () => {
    // 🔴 THE SILENT-ZERO SEAM. Every other evidence field answers "was this heuristic blind", and
    // each of them reads the same on a quiet day as on a broken one. `readFailures` is the field
    // that does not: it is written only inside a `catch`, so a non-zero has no quiet-day reading.
    const failed = await collectCohortSignals(
      fakeReader({ filenameError: new Error('replica timeout') }),
      members,
      { chunkSize: 2 }
    );
    expect(failed.sources.readFailures).toEqual({
      registrationIps: false,
      contentSamples: false,
      filenameSamples: true,
    });

    // 🔴 THE CONTROL THAT MAKES THE ABOVE MEAN ANYTHING: the identical run with a source that
    // simply found nothing. Every OTHER field this pair produces is identical — the availability
    // flag, the sample count, the budget — which is exactly the ambiguity being removed.
    const quiet = await collectCohortSignals(fakeReader({ filenames: [] }), members, {
      chunkSize: 2,
    });
    expect(quiet.sources.readFailures).toEqual({
      registrationIps: false,
      contentSamples: false,
      filenameSamples: false,
    });
  });

  it('🔴 an ABSENT ClickHouse client is not a read failure', async () => {
    // The distinction the availability flag cannot draw and this one must: a deployment with no
    // ClickHouse configured is a normal state, and reporting it as a failure would make the signal
    // permanently non-zero on those deployments and therefore unalertable — the same uselessness as
    // a permanently-zero one, from the other end.
    const s = await collectCohortSignals(fakeReader({ hasIps: false }), members, { chunkSize: 2 });
    expect(s.sources.registrationIps).toBe(false);
    expect(s.sources.readFailures.registrationIps).toBe(false);
  });

  it('🔴 an EMPTY cohort is not a read failure either', async () => {
    const s = await collectCohortSignals(fakeReader({}), []);
    expect(s.sources.readFailures).toEqual({
      registrationIps: false,
      contentSamples: false,
      filenameSamples: false,
    });
  });

  it('records a failing IP read and a failing content read on their own flags', async () => {
    // Asserted per source rather than as an aggregate, so one source's failure cannot be reported
    // under another's name — the same argument the availability flags are split for.
    const ip = await collectCohortSignals(fakeReader({ ipError: new Error('down') }), members, {
      chunkSize: 2,
    });
    expect(ip.sources.readFailures).toMatchObject({
      registrationIps: true,
      contentSamples: false,
      filenameSamples: false,
    });
    const content = await collectCohortSignals(
      fakeReader({ contentError: new Error('down') }),
      members,
      { chunkSize: 2 }
    );
    expect(content.sources.readFailures).toMatchObject({
      registrationIps: false,
      contentSamples: true,
      filenameSamples: false,
    });
  });

  it('🔴 walks filenames in its OWN batches, narrower than the chunk width', async () => {
    // The filename read is one statement per member now, so the `IN (…)` width is the wrong unit:
    // reusing `chunkSize` would put 500 statements in flight at once. The default is the narrower
    // of the two, which keeps a caller that deliberately asked for a small chunk reading filenames
    // at that same granularity.
    const many = Array.from({ length: 60 }, (_, i) => member(i + 1, 'ring.test'));
    const reader = fakeReader({});
    await collectCohortSignals(reader, many, { chunkSize: 500 });
    expect(FILENAME_READ_BATCH_SIZE).toBeLessThan(EVIDENCE_CHUNK_SIZE);
    for (const call of reader.filenameCalls)
      expect(call.ids.length).toBeLessThanOrEqual(FILENAME_READ_BATCH_SIZE);
    // The content read is unaffected: it still uses the chunk width it was given.
    expect(reader.contentCalls.map((c) => c.ids.length)).toEqual([60]);
  });

  it('🔴 a NARROW chunkSize does not narrow the filename batch — they are different units', async () => {
    // 🔴 RED BEFORE THIS CHANGE. The default was `Math.min(chunkSize, FILENAME_READ_BATCH_SIZE)`, so
    // a caller that deliberately asked for a small page — an on-demand pass run narrow to limit
    // blast radius — silently cut filename read concurrency with it. Two unrelated dials moving
    // together is exactly what the option's own docstring says must not happen, and the coupling
    // existed only to serve the tests here, which now pass the knob explicitly.
    const many = Array.from({ length: 30 }, (_, i) => member(i + 1, 'ring.test'));
    const reader = fakeReader({});
    await collectCohortSignals(reader, many, { chunkSize: 2 });
    expect(reader.filenameCalls.map((c) => c.ids.length)).toEqual([10, 10, 10]);
    // The point is INDEPENDENCE, not that the filename read overrides the caller: the content read
    // still walks at the width it was given. Asserted as the full list of widths rather than with
    // `.every`, which is true of an empty array and would pass if the content read never ran.
    expect(reader.contentCalls.map((c) => c.ids.length)).toEqual(
      Array.from({ length: 15 }, () => 2)
    );
  });

  it('honours an explicit filenameBatchSize (invariant guard — the knob had no caller before)', async () => {
    // Green at the PR head too: the option always worked, it simply had no caller anywhere in the
    // tree, which is why its coupling to `chunkSize` was never exercised as a knob. Asserted now
    // because removing the coupling is what makes this the only way to narrow the batch.
    const many = Array.from({ length: 12 }, (_, i) => member(i + 1, 'ring.test'));
    const reader = fakeReader({});
    await collectCohortSignals(reader, many, { chunkSize: 500, filenameBatchSize: 3 });
    expect(reader.filenameCalls.map((c) => c.ids.length)).toEqual([3, 3, 3, 3]);
  });

  it('does not claim filename exhaustion when the whole cohort fit inside the budget', async () => {
    const s = await collectCohortSignals(fakeReader({ filenames: [] }), members, { chunkSize: 2 });
    expect(s.sources.filenameBudgetExhausted).toBe(false);
    expect(s.sources.membersSampledForFilenames).toBe(members.length);
  });

  it('🔴 the two budgets are INDEPENDENT — a spent content budget does not starve filenames', async () => {
    // 🔴 THE FAILURE THIS PREVENTS RUNS IN THE WORST DIRECTION. The comment read is cheap and finds
    // almost nothing; the filename read is the one with the signal in it. A single shared budget
    // spent in source order would let the empty half consume the allowance on a wave day and
    // truncate the half being relied on — silently reproducing the defect this change fixes.
    const reader = fakeReader({
      content: Array.from({ length: 40 }, (_, i) => ({
        userId: (i % 5) + 1,
        content: 'Grab your 100 free credits at https://spam.example now',
      })),
      filenames: [
        { userId: 1, name: 'logo.jpg' },
        { userId: 2, name: 'logo.jpg' },
        { userId: 3, name: 'logo.jpg' },
      ],
    });
    const s = await collectCohortSignals(reader, members, {
      chunkSize: 2,
      maxContentSamples: 1,
    });
    expect(s.sources.contentBudgetExhausted).toBe(true);
    // The filename walk covered the whole cohort regardless.
    expect(s.sources.filenameBudgetExhausted).toBe(false);
    expect(s.sources.membersSampledForFilenames).toBe(members.length);
    expect(s.membersPerFingerprint.get(filenameFingerprint('logo.jpg') as string)).toBe(3);
  });

  it('hands the run clock down to the filename read as an upper bound', async () => {
    const reader = fakeReader({});
    const createdBefore = new Date('2026-09-03T12:00:00.000Z');
    await collectCohortSignals(reader, members, { chunkSize: 5, createdBefore });
    expect(reader.filenameCalls.map((c) => c.createdBefore)).toEqual([createdBefore]);
  });

  it('🔴 asks for a PER-MEMBER cap, never the remaining budget', async () => {
    // 🔴 THE INVERSION OF THE TEST THIS REPLACES, AND THE INVERSION IS THE FIX. The old assertion
    // was `take <= remaining budget` — i.e. it pinned the budget as a cap on the RESULT, which is
    // precisely the shape that let the newest rows in a chunk evict every other account in it. The
    // cap handed down must be the per-member one and must NOT shrink with the budget, because a
    // budget-shaped cap is a cap accounts compete for. The budget still bounds the run; it does so
    // by stopping the WALK, not by narrowing what one member may contribute.
    const reader = fakeReader({
      filenames: Array.from({ length: 5 }, (_, i) => ({ userId: i + 1, name: `f${i}.jpg` })),
    });
    await collectCohortSignals(reader, members, {
      chunkSize: 2,
      maxFilenameSamples: 3,
      maxFilenamesPerMember: 7,
    });
    expect(reader.filenameCalls.length).toBeGreaterThan(0);
    for (const call of reader.filenameCalls) expect(call.take).toBe(7);
  });

  it('hands the run window down to the registration-IP read', async () => {
    const reader = fakeReader({});
    const createdAfter = new Date('2026-09-02T03:20:00.000Z');
    await collectCohortSignals(reader, members, { chunkSize: 5, createdAfter });
    expect(reader.ipWindows).toEqual([createdAfter]);
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
    image: { findMany: vi.fn(async () => [{ userId: 3, name: 'logo.jpg' }]) },
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

  it('🔴 reads the image surface ONCE PER MEMBER, passing the bound through', async () => {
    // 🔴 ONE STATEMENT PER ACCOUNT, NOT ONE PER LIST. It used to be a single `IN (…)` read, and
    // that single statement carried both defects this change removes — see `filenameSampleArgs`.
    // The fan-out is asserted by CALL COUNT and by the arguments of each call, because "it returned
    // rows" is true of the broken shape too.
    const reader = createEvidenceReader({ db, ch: null });
    db.image.findMany.mockClear();
    const before = new Date('2026-09-03T12:00:00.000Z');
    expect(await reader.listFilenameSamples([1, 2], 10, before)).toEqual([
      { userId: 3, name: 'logo.jpg' },
      { userId: 3, name: 'logo.jpg' },
    ]);
    expect(db.image.findMany).toHaveBeenCalledTimes(2);
    expect(db.image.findMany).toHaveBeenNthCalledWith(1, filenameSampleArgs(1, 10, before));
    expect(db.image.findMany).toHaveBeenNthCalledWith(2, filenameSampleArgs(2, 10, before));
  });

  it('🔴 EVERY MEMBER CONTRIBUTES — a prolific uploader cannot evict the rest of the batch', async () => {
    // 🔴 THE COVERAGE HALF OF THE DEFECT, AT THE SEAM WHERE IT LIVED, AGAINST A FAKE THAT OBEYS
    // PRISMA'S SEMANTICS RATHER THAN THE CODE'S ASSUMPTIONS. The old read was ONE statement per
    // batch under ONE `take` with `ORDER BY id DESC`, so the newest rows in the batch consumed the
    // whole allowance: if a handful of accounts owned them, every other account in the batch
    // contributed NOTHING and the counters looked healthy while doing it. That is the shape a ring
    // of low-volume accounts is invisible in — which is the population this heuristic exists for.
    //
    // Measured on ten consecutive real daily cohorts: the global cap reached every member on eight
    // of them and collapsed on the other two — barely half the uploading members on one, about four
    // fifths on the other. It collapses on
    // the days the cohort uploaded MOST.
    //
    // The fixture is built so a global cap MUST fail it: one account owns every one of the newest
    // rows, and the cap is smaller than that account's holding.
    const rows = [
      ...Array.from({ length: 20 }, (_, i) => ({ id: 1000 + i, userId: 1, name: 'prolific.jpg' })),
      { id: 10, userId: 2, name: 'ring.jpg' },
      { id: 9, userId: 3, name: 'ring.jpg' },
    ];
    // 🔴 A `findMany` THAT BEHAVES LIKE ONE, AND THAT UNDERSTANDS BOTH SHAPES — the second half is
    // what makes this a regression test rather than a type error dressed as one. It honours a
    // scalar `userId` AND an `{ in: [...] }` list, so running this test against the pre-change
    // source reproduces the shipped statement faithfully (ONE query, the whole list, `ORDER BY id
    // DESC`, one `take`) and fails because accounts 2 and 3 were EVICTED — not because the fake
    // could not parse the old argument. A fake that only speaks the new shape would go red at base
    // for the wrong reason and prove nothing about the behaviour.
    const image = {
      findMany: vi.fn(async (args: ReturnType<typeof filenameSampleArgs>) => {
        const target = args.where.userId as unknown as number | { in: number[] };
        const matches =
          typeof target === 'number'
            ? (r: (typeof rows)[number]) => r.userId === target
            : (r: (typeof rows)[number]) => target.in.includes(r.userId);
        return rows
          .filter(matches)
          .sort((a, b) => b.id - a.id)
          .slice(0, args.take)
          .map((r) => ({ userId: r.userId, name: r.name }));
      }),
    };
    const reader = createEvidenceReader({
      db: { ...db, image } as unknown as Parameters<typeof createEvidenceReader>[0]['db'],
      ch: null,
    });

    const got = await reader.listFilenameSamples([1, 2, 3], 5);
    const contributors = new Set(got.map((r) => r.userId));
    // The assertion that a global cap of 5 over these rows cannot satisfy: under it, the five
    // newest rows are all account 1's and accounts 2 and 3 are absent.
    expect(contributors).toEqual(new Set([1, 2, 3]));
    // And the prolific account is still capped, so the fix does not trade eviction for unbounded
    // reads: the total is `members × cap`, never `members × everything`.
    expect(got.filter((r) => r.userId === 1)).toHaveLength(5);
  });

  it('issues no filename statement for an empty id list or a zero take', async () => {
    const reader = createEvidenceReader({ db, ch: null });
    db.image.findMany.mockClear();
    expect(await reader.listFilenameSamples([], 10)).toEqual([]);
    expect(await reader.listFilenameSamples([1], 0)).toEqual([]);
    expect(db.image.findMany).not.toHaveBeenCalled();
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
