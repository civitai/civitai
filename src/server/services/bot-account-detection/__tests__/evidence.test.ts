import { NON_PUBLIC_IP_RANGES, publicIpOnlySql } from '@civitai/shared/clickhouse-ip-filters';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { MAX_COHORT_ACCOUNTS } from '../cohort';
import type { BotAccountCohortMember, SurfaceCounts } from '../cohort';
import {
  MAX_IPS_PER_ACCOUNT,
  EVIDENCE_CHUNK_SIZE,
  buildCohortSignals,
  chunk,
  clickhouseDateTime,
  collectCohortSignals,
  createEvidenceReader,
  emptyCohortSignals,
  registrationIpSql,
  MAX_FILENAME_SAMPLES,
  MAX_FILENAMES_PER_MEMBER,
  FILENAME_READ_BATCH_SIZE,
  MAX_STAGED_IMAGE_SAMPLES,
  MAX_STAGED_IMAGES_PER_MEMBER,
  filenameFingerprint,
  filenameSampleArgs,
  normalizeFilename,
  stagedImageSampleArgs,
  type CohortSignals,
  type EvidenceClickhouse,
  type EvidenceReader,
  type FilenameSampleRow,
  type RegistrationIpRow,
  type StagedImageRow,
} from '../evidence';
import { FILENAME_FINGERPRINT_PREFIX, unprefixFingerprint } from '../fingerprint-keys';
import { STAGED_ONE_AT } from '../heuristics/staging';

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
    // The whole reason this is not the prose normaliser the deleted comment-text source used. Under
    // that function both of these became `nummask jpg jpeg`, so every `<digits>.jpg` on the site was
    // ONE cluster and the largest group in any cohort became an artefact of camera naming rather
    // than a ring.
    expect(normalizeFilename('1900.jpg.jpeg')).toBe('1900.jpg.jpeg');
    expect(normalizeFilename('2749.jpg.jpeg')).toBe('2749.jpg.jpeg');
    expect(normalizeFilename('1900.jpg.jpeg')).not.toBe(normalizeFilename('2749.jpg.jpeg'));
  });

  it('🔴 does NOT strip punctuation — the dot and the extension are part of the identity', () => {
    expect(normalizeFilename('my-file_v2.final.png')).toBe('my-file_v2.final.png');
  });
});

describe('filenameFingerprint', () => {
  it('namespaces the key, so the index can carry more than one source without collisions', () => {
    expect(filenameFingerprint('logo.jpg')).toBe(`${FILENAME_FINGERPRINT_PREFIX}logo.jpg`);
  });

  it('🔴 THE REGRESSION THIS SOURCE EXISTS FOR: NO length floor is applied to a filename', () => {
    // 🔴 THE OTHER HALF OF THIS CASE WENT WITH THE COMMENT-TEXT SOURCE, AND SAYING SO IS THE POINT.
    // It used to assert that the prose fingerprinter REJECTED both of these outright — measured by
    // executing the shipped normaliser, `1900.jpg.jpeg` became `"nummask jpg jpeg"` (16 chars, 3
    // tokens) and `logo.jpg` became `"logo jpg"` (8 chars, 2 tokens), against floors of 24 chars and
    // 4 tokens. That function no longer exists, so the assertion cannot: what survives is the claim
    // about THIS function, which is the one a regression could break.
    //
    // Both are filenames a confirmed ring actually shared. A length floor is right for prose,
    // because a SHORT SENTENCE is written independently by unrelated people; a filename is an
    // identifier, and a short one is no weaker evidence than a long one.
    expect(filenameFingerprint('1900.jpg.jpeg')).not.toBeNull();
    expect(filenameFingerprint('logo.jpg')).not.toBeNull();
    // A short name and a long one are both keys, and they are DIFFERENT keys — the positive control
    // that stops the two lines above passing because the function returns a constant.
    expect(filenameFingerprint('a.png')).not.toBe(filenameFingerprint('logo.jpg'));
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
  it('strips the namespace and leaves an unprefixed key alone', () => {
    expect(unprefixFingerprint(`${FILENAME_FINGERPRINT_PREFIX}logo.jpg`)).toBe('logo.jpg');
    expect(unprefixFingerprint('no prefix here')).toBe('no prefix here');
  });

  it('🔴 does not truncate an unprefixed key at its first colon', () => {
    // The naive implementation — slice at `indexOf(':')` — would eat the front of any value
    // containing a colon. (This used to be motivated by generation-parameter pastes arriving
    // through the comment-text source, which is gone; the naive implementation is still wrong, and
    // a filename may legitimately carry a colon.)
    expect(unprefixFingerprint('my: photo.png')).toBe('my: photo.png');
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

describe('stagedImageSampleArgs', () => {
  it('🔴 pins the staged budget CONSTANTS, separately from the behavioural cases', () => {
    // Every walk case below passes its own budget and its own per-member cap explicitly, so none of
    // them says anything about the shipped values. This does.
    //
    // 🔴 THE PER-MEMBER CAP IS ALSO THE LARGEST COUNT THE HEURISTIC CAN EVER SEE, which the
    // filename cap is not — a filename sample folds into a set, while this one IS the measurement.
    // That is harmless only while the scoring ramp saturates well below it, so the relationship is
    // asserted rather than left to a reader to notice. The margin WIDENED when the volume boundary
    // was re-derived downwards, so the assertion is written against the constant rather than
    // restating its value — a literal here goes stale exactly when the coupling it guards moves.
    expect(MAX_STAGED_IMAGE_SAMPLES).toBe(20_000);
    expect(MAX_STAGED_IMAGES_PER_MEMBER).toBe(50);
    expect(MAX_STAGED_IMAGES_PER_MEMBER).toBeGreaterThan(STAGED_ONE_AT * 4);
  });

  it('reads ONE account’s unattached, metadata-free uploads, bounded, two columns', () => {
    const args = stagedImageSampleArgs(1, 50);
    expect(args.where.userId).toBe(1);
    expect(args.select).toEqual({ userId: true, createdAt: true });
    expect(args.take).toBe(50);
  });

  it('🔴 requires BOTH staged facts — neither half alone is the signal', () => {
    // `postId IS NULL` alone is ordinary: an upload sits unattached for as long as it takes someone
    // to finish a post, so a snapshot at any instant catches real people mid-flow. `meta IS NULL`
    // alone is more ordinary still — every image uploaded from a disk rather than generated here
    // has no generation metadata. It is the PAIR that is unusual, so a mutant dropping either
    // predicate widens the population to something the heuristic's boundaries were not set against.
    //
    // Asserted as the EXACT key set, so dropping one predicate fails AND adding a third does too.
    expect(Object.keys(stagedImageSampleArgs(1, 10).where).sort()).toEqual([
      'meta',
      'postId',
      'userId',
    ]);
    expect(stagedImageSampleArgs(1, 10).where.postId).toBeNull();
  });

  it('🔴 matches BOTH spellings of a null `meta`, not just the SQL one', () => {
    // 🔴 THE HALF-POPULATION BUG THIS PREVENTS. `Image.meta` is a `Json?`, so "no metadata" is
    // written two ways — a database NULL and the JSON literal `null` — and the two are
    // indistinguishable to anyone reading the site. A filter matching one of them scores half of an
    // identical population and reports the difference as a fact about the accounts.
    //
    // `Prisma.AnyNull` is the only filter value that covers both; `equals: null` on a `Json?` column
    // is rejected by the query engine as ambiguous rather than silently meaning either. Asserted
    // against the sentinel itself rather than against a string, because the sentinel IS the
    // contract with the query engine.
    expect(stagedImageSampleArgs(1, 10).where.meta).toEqual({ equals: Prisma.AnyNull });
    expect(stagedImageSampleArgs(1, 10).where.meta.equals).toBe(Prisma.AnyNull);
    // The negative half of the same claim: NOT the DB-null-only sentinel, which is the mistake a
    // reader reaching for "meta is null" makes first.
    expect(stagedImageSampleArgs(1, 10).where.meta.equals).not.toBe(Prisma.DbNull);
    expect(stagedImageSampleArgs(1, 10).where.meta.equals).not.toBe(Prisma.JsonNull);
  });

  it('🔴 pins `userId` to a SCALAR EQUALITY — never an `IN (…)` list under a LIMIT', () => {
    // The same regression guard the filename read carries, for the same measured reason: a wide
    // `IN (…)` over `Image` under a `LIMIT` produced a backward primary-key scan that walked the
    // whole table, and narrowing the list does not fix it. This read is newer than that incident
    // and would have been written the broken way just as easily.
    const where = stagedImageSampleArgs(7, 10).where;
    expect(typeof where.userId).toBe('number');
    expect(where.userId).not.toHaveProperty('in');
  });

  it('🔴 orders by id, NOT createdAt — even though createdAt is the column it reads', () => {
    // The tempting mistake, and the one a reader would call an obvious improvement: the heuristic's
    // burst half is about TIME, so ordering by time looks natural. There is no declared
    // `(userId, createdAt)` index, so that sort would run outside every declared index, while `id`
    // is monotonic on an append-only table and descending `id` is descending upload order. The
    // `take` bounds the read, so the order decides WHICH rows survive it.
    expect(stagedImageSampleArgs(1, 10).orderBy).toEqual({ id: 'desc' });
  });

  it('bounds on createdAt when given a window, and omits it when not', () => {
    const before = new Date('2026-09-03T12:00:00.000Z');
    expect(stagedImageSampleArgs(1, 10, before).where).toMatchObject({
      createdAt: { lte: before },
    });
    expect(stagedImageSampleArgs(1, 10).where).not.toHaveProperty('createdAt');
  });
});

describe('the module constants', () => {
  it('🔴 pins every bound a run is sized by, so moving one is a deliberate edit', () => {
    // 🔴 A CONSTANT NOTHING ASSERTS can be changed by a mutant — or by a maintainer — with the
    // entire suite green, and each of these decides how much of a wave a run actually sees: the
    // budget is the ceiling on rows read at all, and the chunk size is the width of every `IN (…)`
    // list.
    //
    // 🔴 A SEPARATE BUDGET PER SOURCE. Pinned so a later "tidy-up" that folds two reads into one
    // allowance is a deliberate, visible edit rather than a silent one — two reads sharing one
    // budget is one read able to spend the other's, and it starves whichever runs second.
    expect(MAX_FILENAME_SAMPLES).toBe(20_000);
    expect(EVIDENCE_CHUNK_SIZE).toBe(500);
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

// ---------------------------------------------------------------------------------------------
// Index building
// ---------------------------------------------------------------------------------------------

describe('buildCohortSignals', () => {
  /**
   * The source flags every case in this block hands `buildCohortSignals`.
   *
   * 🔴 ANNOTATED, WHICH IS THE POINT, NOT DECORATION. This fixture was written as a bare object
   * literal and silently went out of date the day `CohortSignals['sources']` grew `readFailures`:
   * every one of the fifteen call sites below became a TS2741, and not one gate in this repo could
   * see it — `tsconfig.json` drops this directory from the program and vitest does not typecheck.
   * With the annotation the next field added to that type is one error here rather than fifteen
   * over there, and it lands on the fixture that actually needs updating.
   *
   * `readFailures` is all-false: every case in this block is about the FOLD, and a fold reads the
   * rows it is handed and consults no flag. The cases that are about the flags build their own.
   */
  const sources: CohortSignals['sources'] = {
    readFailures: {
      registrationIps: false,
      filenameSamples: false,
      stagedImages: false,
    },
    registrationIps: true,
    filenameSamples: true,
    filenameBudgetExhausted: false,
    membersSampledForFilenames: 3,
    stagedImages: true,
    stagedImageBudgetExhausted: false,
    membersSampledForStagedImages: 3,
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
      sources,
    });
    expect(s.membersPerIp.get('x')).toBe(2);
    // And the account's own IP list is deduplicated too.
    expect(s.ipsByUser.get(1)).toEqual(['x']);
  });

  it('🔴 counts DISTINCT accounts per FILENAME, not uploads', () => {
    // The same invariant in the filename axis, and the one that stops a single prolific account
    // manufacturing a ring out of itself: account 1 uploads `logo.jpg` ninety times and is ONE
    // member of that cluster. Without this a lone bulk uploader tops the run's distribution.
    const s = buildCohortSignals({
      members: [member(1), member(2)],
      registrationIps: [],
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

  it('🔴 EVERY KEY IT WRITES CARRIES A SOURCE NAMESPACE, not a bare value', () => {
    // 🔴 WHAT SURVIVES OF THE NAMESPACE-COLLISION GUARD NOW THAT ONE SOURCE REMAINS. It used to be
    // reachable and measured: `membersPerFingerprint` is ONE `Map<string, number>` carrying every
    // source, and the deleted prose normaliser stripped the dot out of `logo.jpg` to give
    // `logo jpg`, which is exactly what a comment reading "logo jpg" normalised to — so two accounts
    // uploading `logo.jpg` and one commenting about it read as a ring of three. With the comment
    // source gone that specific collision cannot happen, so the case cannot be written as a
    // collision any more without inventing a second source the module does not have.
    //
    // What is still testable is the property that made it safe, and it is the property a future
    // source depends on: the index NEVER holds a bare value. A fold that wrote one would collide
    // with the first source added after it, silently, and in the direction that inflates a ring.
    const s = buildCohortSignals({
      members: [member(1), member(2), member(3)],
      registrationIps: [],
      filenameSamples: [
        { userId: 1, name: 'logo jpg' },
        { userId: 2, name: 'Logo.JPG' },
        { userId: 3, name: 'unrelated-shot.png' },
      ],
      sources,
    });
    const keys = [...s.membersPerFingerprint.keys()];
    // A positive control first: the fold ran and produced keys, so the `every` below is not
    // vacuously true over an empty set.
    expect(keys).toHaveLength(3);
    expect(keys.every((k) => k.startsWith(FILENAME_FINGERPRINT_PREFIX))).toBe(true);
    expect([...s.fingerprintsByUser.values()].flat()).not.toHaveLength(0);
    expect(
      [...s.fingerprintsByUser.values()]
        .flat()
        .every((k) => k.startsWith(FILENAME_FINGERPRINT_PREFIX))
    ).toBe(true);
    // And the namespace is strippable back to exactly what was compared, which is what the reason
    // string shows a moderator.
    expect(keys.map(unprefixFingerprint).sort()).toEqual([
      'logo jpg',
      'logo.jpg',
      'unrelated-shot.png',
    ]);
  });

  it('drops an upload with no filename rather than clustering on the empty string', () => {
    const s = buildCohortSignals({
      members: [member(1), member(2), member(3)],
      registrationIps: [],
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
      filenameSamples: [{ userId: 99, name: 'logo.jpg' }],
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
      sources,
    });
    expect(s.membersPerDomain.get('ring.test')).toBe(2);
    expect(s.membersPerDomain.get('other.test')).toBe(1);
    // A null domain is not a cluster key — see `normalizeEmailDomain`.
    expect(s.membersPerDomain.size).toBe(2);
  });

  // -------------------------------------------------------------------------------------------
  // The staged-image fold
  // -------------------------------------------------------------------------------------------

  /** `n` staged uploads for one member, all in distinct seconds unless `second` says otherwise. */
  const staged = (userId: number, isos: string[]): StagedImageRow[] =>
    isos.map((iso) => ({ userId, createdAt: new Date(iso) }));

  it('🔴 counts staged ROWS, not distinct members — the one fold here that must', () => {
    // 🔴 THE INVERSION OF THIS FILE'S CENTRAL RULE, AND IT IS CORRECT HERE. Every other fold counts
    // DISTINCT ACCOUNTS, because every other heuristic asks "how many others share this" and one
    // account repeating itself must not manufacture a ring. `asset-staging` asks how much THIS
    // account staged, so its unit is the upload — deduplicating to one-per-member would collapse
    // the whole signal to a boolean and the scoring ramp would have nothing to range over.
    //
    // Four rows from one member. A fold that counted members returns 1 here, which is below the
    // scoring boundary, i.e. the mutant silently switches the heuristic off rather than skewing it.
    const s = buildCohortSignals({
      members: [member(1)],
      registrationIps: [],
      stagedImageSamples: staged(1, [
        '2026-09-03T10:00:00.000Z',
        '2026-09-03T10:05:00.000Z',
        '2026-09-03T10:11:00.000Z',
        '2026-09-03T10:30:00.000Z',
      ]),
      sources,
    });
    expect(s.stagedImagesByUser.get(1)?.count).toBe(4);
  });

  it('🔴 finds the largest SAME-SECOND group, not the total and not the first group', () => {
    // Seven uploads: two sharing one second, three sharing a later one, two alone. The answer is 3.
    // Deliberately distinct from the count (7), from the first group's size (2), from the number of
    // groups (5) and from 1 — so a mutant returning any of those cannot land on it. The largest
    // group is also NOT the first one seen, which is what makes this a test of the max rather than
    // of the iteration.
    const s = buildCohortSignals({
      members: [member(1)],
      registrationIps: [],
      stagedImageSamples: staged(1, [
        '2026-09-03T10:00:00.000Z',
        '2026-09-03T10:00:00.500Z',
        '2026-09-03T10:00:04.000Z',
        '2026-09-03T10:00:09.100Z',
        '2026-09-03T10:00:09.400Z',
        '2026-09-03T10:00:09.900Z',
        '2026-09-03T10:00:14.000Z',
      ]),
      sources,
    });
    expect(s.stagedImagesByUser.get(1)).toEqual({ count: 7, largestSameSecondBurst: 3 });
  });

  it('🔴 a WHOLE second, not a rolling window — 999ms apart across the boundary is not a burst', () => {
    // Stated as a limitation rather than defended: two uploads 100ms apart that straddle a second
    // boundary are NOT counted together, which is a false negative the truncation buys in exchange
    // for a threshold nobody has to pick. A reader who assumes a window would read this heuristic's
    // burst number as larger than it is.
    const s = buildCohortSignals({
      members: [member(1)],
      registrationIps: [],
      stagedImageSamples: staged(1, ['2026-09-03T10:00:00.950Z', '2026-09-03T10:00:01.050Z']),
      sources,
    });
    expect(s.stagedImagesByUser.get(1)).toEqual({ count: 2, largestSameSecondBurst: 1 });
  });

  it('keeps members’ staged facts apart', () => {
    // One index, many members: a fold that accumulated into a shared record would score every
    // member on the cohort's total. The two members have different counts AND different bursts, so
    // a cross-contaminating mutant cannot produce both.
    const s = buildCohortSignals({
      members: [member(1), member(2)],
      registrationIps: [],
      stagedImageSamples: [
        ...staged(1, ['2026-09-03T10:00:00.100Z', '2026-09-03T10:00:00.200Z']),
        ...staged(2, [
          '2026-09-03T11:00:00.000Z',
          '2026-09-03T12:00:00.000Z',
          '2026-09-03T13:00:00.000Z',
        ]),
      ],
      sources,
    });
    expect(s.stagedImagesByUser.get(1)).toEqual({ count: 2, largestSameSecondBurst: 2 });
    expect(s.stagedImagesByUser.get(2)).toEqual({ count: 3, largestSameSecondBurst: 1 });
  });

  it('🔴 ignores a row for an account outside the cohort', () => {
    // The same guard the IP and fingerprint folds carry: a row for an id the run is not scoring —
    // a stale row, an account banned since — must not appear in the index at all, or a member that
    // was never scored acquires facts nothing will ever read and the map's size stops matching the
    // cohort.
    const s = buildCohortSignals({
      members: [member(1)],
      registrationIps: [],
      stagedImageSamples: [
        ...staged(1, ['2026-09-03T10:00:00.000Z']),
        ...staged(99, ['2026-09-03T10:00:00.000Z']),
      ],
      sources,
    });
    expect([...s.stagedImagesByUser.keys()]).toEqual([1]);
  });

  it('🔴 an UNPARSEABLE timestamp counts as an upload but never as a burst', () => {
    // 🔴 THE MAXIMAL SCORE BUILT OUT OF BAD DATA. `NaN` is a usable Map key — SameValueZero treats
    // two NaNs as the same key — so admitting undated rows into the per-second tally would gather
    // EVERY one of a member's bad rows into a single "burst" and saturate the burst half. That is
    // the one direction a detector must not fail in: a top-confidence finding on the strength of
    // corrupt timestamps.
    //
    // The row is still counted as an upload, because it IS one; only the time-based claim is
    // withheld. Three bad rows plus one good one: count 4, burst 1.
    const s = buildCohortSignals({
      members: [member(1)],
      registrationIps: [],
      stagedImageSamples: [
        { userId: 1, createdAt: new Date('not a date') },
        { userId: 1, createdAt: new Date('not a date') },
        { userId: 1, createdAt: new Date('not a date') },
        { userId: 1, createdAt: new Date('2026-09-03T10:00:00.000Z') },
      ],
      sources,
    });
    expect(s.stagedImagesByUser.get(1)).toEqual({ count: 4, largestSameSecondBurst: 1 });
  });

  it('indexes nothing when the staged samples are absent entirely', () => {
    const s = buildCohortSignals({
      members: [member(1)],
      registrationIps: [],
      sources,
    });
    expect(s.stagedImagesByUser.size).toBe(0);
  });

  it('carries the source flags through unchanged', () => {
    const s = buildCohortSignals({
      members: [],
      registrationIps: [],
      sources: {
        readFailures: {
          registrationIps: true,
          filenameSamples: false,
          stagedImages: false,
        },
        registrationIps: false,
        filenameSamples: true,
        filenameBudgetExhausted: true,
        membersSampledForFilenames: 4,
        stagedImages: true,
        stagedImageBudgetExhausted: true,
        membersSampledForStagedImages: 2,
      },
    });
    expect(s.sources).toEqual({
      readFailures: {
        registrationIps: true,
        filenameSamples: false,
        stagedImages: false,
      },
      registrationIps: false,
      filenameSamples: true,
      filenameBudgetExhausted: true,
      membersSampledForFilenames: 4,
      stagedImages: true,
      stagedImageBudgetExhausted: true,
      membersSampledForStagedImages: 2,
    });
  });
});

describe('emptyCohortSignals', () => {
  it('🔴 defaults every source to "did not run", which is the safe reading', () => {
    // A run with no evidence reader must not look like a run that found no rings. Every source
    // flag defaults to false for that reason — a false means "this was not read", never "the cohort
    // had nothing that matched".
    expect(emptyCohortSignals().sources).toEqual({
      // 🔴 THE ONE GROUP WHOSE `false` IS NOT "did not run". An index over nothing is not an
      // outage, and defaulting these to true would make every empty cohort page an operator.
      readFailures: {
        registrationIps: false,
        filenameSamples: false,
        stagedImages: false,
      },
      registrationIps: false,
      // The filename source defaults the same way and for the same reason: a run with no evidence
      // reader must not look like a cohort that shared no filenames.
      filenameSamples: false,
      filenameBudgetExhausted: false,
      membersSampledForFilenames: 0,
      // And the staged-image source, for the third time and for the same reason: `asset-staging`
      // scoring 0 on a run where nobody read anything must not read as "these accounts published
      // what they uploaded".
      stagedImages: false,
      stagedImageBudgetExhausted: false,
      membersSampledForStagedImages: 0,
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
  filenames?: FilenameSampleRow[];
  staged?: StagedImageRow[];
  hasIps?: boolean;
  ipError?: Error;
  filenameError?: Error;
  stagedError?: Error;
}): EvidenceReader & {
  ipCalls: number[][];
  ipWindows: Array<Date | undefined>;
  filenameCalls: Array<{ ids: number[]; take: number; createdBefore: Date | undefined }>;
  stagedCalls: Array<{ ids: number[]; take: number; createdBefore: Date | undefined }>;
} {
  const ipCalls: number[][] = [];
  const ipWindows: Array<Date | undefined> = [];
  const filenameCalls: Array<{ ids: number[]; take: number; createdBefore: Date | undefined }> = [];
  const stagedCalls: Array<{ ids: number[]; take: number; createdBefore: Date | undefined }> = [];
  return {
    ipCalls,
    ipWindows,
    filenameCalls,
    stagedCalls,
    // 🔴 THE FAKE MODELS THE PER-MEMBER CAP, for the reason spelled out on `listFilenameSamples`
    // below: a fake that slices the whole batch encodes the very defect the real read was changed to
    // remove, and then no test built on it can observe one account evicting another.
    listStagedImageSamples: async (ids, perMemberTake, createdBefore) => {
      stagedCalls.push({ ids, take: perMemberTake, createdBefore });
      if (opts.stagedError) throw opts.stagedError;
      return ids.flatMap((id) =>
        (opts.staged ?? []).filter((r) => r.userId === id).slice(0, perMemberTake)
      );
    },
    hasRegistrationIps: opts.hasIps ?? true,
    listRegistrationIps: async (ids, createdAfter) => {
      ipCalls.push(ids);
      ipWindows.push(createdAfter);
      if (opts.ipError) throw opts.ipError;
      return (opts.ips ?? []).filter((r) => ids.includes(r.userId));
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
    expect(reader.filenameCalls).toEqual([]);
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

  it('a failing IP read does not stop the filename read', async () => {
    // The heuristics are independent; one dead source must not cost the others.
    const reader = fakeReader({
      ipError: new Error('down'),
      filenames: [
        { userId: 1, name: 'logo.jpg' },
        { userId: 2, name: 'logo.jpg' },
        { userId: 3, name: 'logo.jpg' },
      ],
    });
    const s = await collectCohortSignals(reader, members, { chunkSize: 2 });
    expect(s.sources.registrationIps).toBe(false);
    expect(s.sources.filenameSamples).toBe(true);
    expect(s.membersPerFingerprint.get(filenameFingerprint('logo.jpg') as string)).toBe(3);
  });

  it('discards the PARTIAL filenames already read when a later batch fails', async () => {
    // Same argument as the IP loop's: a cluster count built from some of the batches understates
    // every ring that straddles the missing ones, and understating produces the confident zero.
    //
    // 🔴 THE FAILURE MUST LAND IN A LATER BATCH OR THE DISCARD IS UNREACHABLE. With `filenameBatchSize
    // : 2` over five members the walk issues three batches; this one fails on the SECOND, so batch
    // one's rows are already in hand when it arrives and only the discard can remove them.
    let calls = 0;
    const reader: EvidenceReader = {
      hasRegistrationIps: false,
      listRegistrationIps: async () => [],
      listStagedImageSamples: async () => [],
      listFilenameSamples: async (ids) => {
        calls += 1;
        if (calls > 1) throw new Error('replica timeout');
        return ids.map((userId) => ({ userId, name: 'logo.jpg' }));
      },
    };
    const s = await collectCohortSignals(reader, members, { chunkSize: 5, filenameBatchSize: 2 });
    expect(calls).toBe(2);
    expect(s.sources.filenameSamples).toBe(false);
    // The two rows the FIRST batch returned are gone, not scored as a two-account cluster.
    expect(s.membersPerFingerprint.size).toBe(0);
    expect(s.fingerprintsByUser.size).toBe(0);
  });

  it('reports the filename source as present on an ordinary run that matched nothing', async () => {
    // Emitted true, not merely absent-when-false: the flag has to distinguish "read fine, nobody
    // matched" from "read did not happen", and only asserting the false side leaves the true side
    // free to be wrong.
    const s = await collectCohortSignals(fakeReader({ filenames: [] }), members, { chunkSize: 2 });
    expect(s.sources.filenameSamples).toBe(true);
    expect(s.membersPerFingerprint.size).toBe(0);
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
    // 🔴 WHAT THIS FIXTURE CAN AND CANNOT SHOW. `filenameError` throws on EVERY call, so the walk
    // fails on its FIRST batch with nothing yet in hand. This test therefore pins that a filename
    // failure DEGRADES the run — no throw escapes, availability goes false, the flag is not
    // mistaken for an exhausted budget, and `membersSampledForFilenames` claims nobody — and it
    // does NOT show that data already read is discarded, because there is none to discard. That
    // claim needs a failure in a LATER batch; it is carried by 'discards the PARTIAL filenames
    // already read when a later batch fails' above, and end to end through the real reader by '…and
    // `collectCohortSignals` DISCARDS the partial data already read and RECORDS the failure' in the
    // `createEvidenceReader` block below. This comment used to assert the discard here, over a fixture that cannot reach
    // it — reading as coverage while providing none, which is the defect class this module's tests
    // exist to remove.
    const s = await collectCohortSignals(
      fakeReader({
        filenameError: new Error('replica timeout'),
        staged: [{ userId: 1, createdAt: new Date('2026-09-03T10:00:00.000Z') }],
      }),
      members,
      { chunkSize: 2 }
    );
    expect(s.sources.filenameSamples).toBe(false);
    expect(s.sources.filenameBudgetExhausted).toBe(false);
    expect(s.sources.membersSampledForFilenames).toBe(0);
    // 🔴 THE OTHER SOURCES ARE UNHARMED. The reads fail independently, which is exactly why they
    // carry separate flags rather than one shared one.
    expect(s.sources.stagedImages).toBe(true);
    expect(s.stagedImagesByUser.get(1)?.count).toBe(1);
  });

  it('🔴 a failing STAGED read does not take the filename read down with it', async () => {
    // The mirror direction, asserted separately: a single flag covering both would let a live
    // filename read vouch for a staged read that never happened, or vice versa. Both reads hit the
    // SAME table through the same `image.findMany`, which is exactly why the independence has to be
    // asserted rather than assumed.
    const s = await collectCohortSignals(
      fakeReader({
        stagedError: new Error('down'),
        filenames: [
          { userId: 1, name: 'logo.jpg' },
          { userId: 2, name: 'logo.jpg' },
          { userId: 3, name: 'logo.jpg' },
        ],
      }),
      members,
      { chunkSize: 2 }
    );
    expect(s.sources.stagedImages).toBe(false);
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

  // -------------------------------------------------------------------------------------------
  // The staged-image walk
  // -------------------------------------------------------------------------------------------

  /** `n` staged rows for a member, one second apart, so nothing bursts unless a case says so. */
  const stagedRows = (userId: number, n: number, iso = '2026-09-03T10:00:00.000Z') =>
    Array.from({ length: n }, (_, i) => ({
      userId,
      createdAt: new Date(new Date(iso).getTime() + i * 1000),
    }));

  it('walks the cohort for staged images and indexes what comes back', async () => {
    const reader = fakeReader({ staged: [...stagedRows(1, 3), ...stagedRows(4, 1)] });
    const s = await collectCohortSignals(reader, members, { chunkSize: 2, filenameBatchSize: 2 });
    expect(s.sources.stagedImages).toBe(true);
    expect(s.sources.membersSampledForStagedImages).toBe(members.length);
    expect(s.stagedImagesByUser.get(1)?.count).toBe(3);
    expect(s.stagedImagesByUser.get(4)?.count).toBe(1);
    expect(s.stagedImagesByUser.has(2)).toBe(false);
  });

  it('🔴 passes the PER-MEMBER cap and the snapshot bound to the read', async () => {
    // The cap is per account, not across the batch — a cap one account can spend is the defect the
    // filename read was rewritten to remove, and this read was written after it. The snapshot bound
    // is what makes two runs over one window sample the same rows instead of drifting.
    const before = new Date('2026-09-03T12:00:00.000Z');
    const reader = fakeReader({});
    await collectCohortSignals(reader, members, {
      chunkSize: 5,
      filenameBatchSize: 2,
      maxStagedImagesPerMember: 7,
      createdBefore: before,
    });
    expect(reader.stagedCalls.map((c) => c.take)).toEqual([7, 7, 7]);
    expect(reader.stagedCalls.map((c) => c.createdBefore)).toEqual([before, before, before]);
    // Batched at the filename width, not at the chunk width: five members at batch size 2 is three
    // calls, not one call of five.
    expect(reader.stagedCalls.map((c) => c.ids)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('🔴 a failing STAGED read degrades the run instead of killing it, and says so', async () => {
    // A dead source must not throw the run away, and it must not look like a quiet day. For this
    // heuristic specifically the quiet-day reading is not merely weaker, it is FALSE: "these
    // accounts published what they uploaded", asserted about accounts nobody looked at.
    const log = vi.fn();
    const s = await collectCohortSignals(
      fakeReader({
        stagedError: new Error('replica timeout'),
        filenames: [
          { userId: 1, name: 'logo.jpg' },
          { userId: 2, name: 'logo.jpg' },
          { userId: 3, name: 'logo.jpg' },
        ],
      }),
      members,
      { chunkSize: 2, filenameBatchSize: 2, log }
    );
    expect(s.sources.stagedImages).toBe(false);
    expect(s.sources.readFailures.stagedImages).toBe(true);
    // A failed read is not an exhausted budget — reporting it as one sends a grading pass looking
    // for a cohort too large rather than for a broken replica.
    expect(s.sources.stagedImageBudgetExhausted).toBe(false);
    expect(s.sources.membersSampledForStagedImages).toBe(0);
    expect(log.mock.calls.map(([name]) => name)).toContain(
      'bot-account-detection:staged-images-failed'
    );
    // 🔴 THE OTHER SOURCES ARE UNHARMED — three reads, three independent failure modes. Without
    // this the case would pass just as well on a mutant that abandoned the whole walk.
    expect(s.sources.filenameSamples).toBe(true);
    expect(s.membersPerFingerprint.get(filenameFingerprint('logo.jpg') as string)).toBe(3);
  });

  it('🔴 DISCARDS the staged rows already in hand when a LATER batch fails', async () => {
    // 🔴 THE ASSERTION THE DISCARD OWNS, and the first-batch fixture above cannot make it: there is
    // nothing in hand to discard when the very first call throws. Five members at batch size 2 fail
    // in batch TWO, so batch one's rows exist when the failure arrives and only the discard removes
    // them. Without it, member 1 keeps three staged uploads out of a read that FAILED — a scored
    // finding built on a broken read, while the flags say the source is unavailable.
    let call = 0;
    const reader: EvidenceReader = {
      hasRegistrationIps: false,
      listRegistrationIps: async () => [],
      listFilenameSamples: async () => [],
      listStagedImageSamples: async (ids) => {
        call += 1;
        if (call > 1) throw new Error('replica timeout');
        return ids.flatMap((id) => stagedRows(id, 3));
      },
    };
    const s = await collectCohortSignals(reader, members, { chunkSize: 5, filenameBatchSize: 2 });
    expect(call).toBe(2);
    expect(s.stagedImagesByUser.size).toBe(0);
    expect(s.sources.stagedImages).toBe(false);
    expect(s.sources.readFailures.stagedImages).toBe(true);
  });

  it('🔴 stops the staged walk when its OWN budget runs out, and says which', async () => {
    // Its own budget, not a share of the filename one: two reads sharing an allowance is one read
    // able to spend the other's. The budget is checked per batch, so a run can overshoot by at most
    // one batch's worth — bounded and stated rather than eliminated.
    const reader = fakeReader({ staged: members.flatMap((m) => stagedRows(m.userId, 3)) });
    const s = await collectCohortSignals(reader, members, {
      chunkSize: 5,
      filenameBatchSize: 1,
      maxStagedImageSamples: 4,
    });
    expect(s.sources.stagedImageBudgetExhausted).toBe(true);
    expect(s.sources.membersSampledForStagedImages).toBeLessThan(members.length);
    // The read itself did not fail — an exhausted budget and a broken read are different states
    // and the flags must not blur them.
    expect(s.sources.stagedImages).toBe(true);
    expect(s.sources.readFailures.stagedImages).toBe(false);
  });

  it('🔴 a failing FILENAME read does not take the staged read down with it', async () => {
    // The mirror of the case above, on the pair most likely to be conflated: both reads hit the
    // SAME table through the same `image.findMany`, so a single shared flag — or a walk that gave
    // up after the first failure — would be invisible in production and would read as "nobody
    // staged anything" on every day the filename read had a bad minute.
    const s = await collectCohortSignals(
      fakeReader({
        filenameError: new Error('replica timeout'),
        staged: stagedRows(1, 4),
      }),
      members,
      { chunkSize: 2, filenameBatchSize: 2 }
    );
    expect(s.sources.filenameSamples).toBe(false);
    expect(s.sources.stagedImages).toBe(true);
    expect(s.stagedImagesByUser.get(1)?.count).toBe(4);
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
      filenameSamples: true,
      stagedImages: false,
    });

    // 🔴 THE CONTROL THAT MAKES THE ABOVE MEAN ANYTHING: the identical run with a source that
    // simply found nothing. Every OTHER field this pair produces is identical — the availability
    // flag, the sample count, the budget — which is exactly the ambiguity being removed.
    const quiet = await collectCohortSignals(fakeReader({ filenames: [] }), members, {
      chunkSize: 2,
    });
    expect(quiet.sources.readFailures).toEqual({
      registrationIps: false,
      filenameSamples: false,
      stagedImages: false,
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
      filenameSamples: false,
      stagedImages: false,
    });
  });

  it('records a failing IP read and a failing filename read on their own flags', async () => {
    // Asserted per source rather than as an aggregate, so one source's failure cannot be reported
    // under another's name — the same argument the availability flags are split for.
    const ip = await collectCohortSignals(fakeReader({ ipError: new Error('down') }), members, {
      chunkSize: 2,
    });
    expect(ip.sources.readFailures).toMatchObject({
      registrationIps: true,
      filenameSamples: false,
      stagedImages: false,
    });
    const filename = await collectCohortSignals(
      fakeReader({ filenameError: new Error('down') }),
      members,
      { chunkSize: 2 }
    );
    expect(filename.sources.readFailures).toMatchObject({
      registrationIps: false,
      filenameSamples: true,
      stagedImages: false,
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
    // The IP read is unaffected: it still uses the chunk width it was given. Asserted as the full
    // list of widths rather than with `.every`, which is true of an empty array and would pass if
    // that read never ran at all.
    expect(reader.ipCalls.map((ids) => ids.length)).toEqual([60]);
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
    // The point is INDEPENDENCE, not that the filename read overrides the caller: the chunked read
    // still walks at the width it was given. Asserted as the full list of widths rather than with
    // `.every`, which is true of an empty array and would pass if that read never ran.
    expect(reader.ipCalls.map((ids) => ids.length)).toEqual(Array.from({ length: 15 }, () => 2));
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

  it('🔴 the budgets are INDEPENDENT — a spent staged budget does not starve filenames', async () => {
    // 🔴 A SINGLE SHARED BUDGET IS ONE READ ABLE TO SPEND THE OTHER'S, and the direction it fails
    // in is the one that silently blinds whichever read runs second. Both of these reads hit the
    // SAME table through the same `image.findMany`, which is exactly why the independence has to be
    // asserted rather than assumed from the fact that they are different methods.
    const reader = fakeReader({
      staged: members.flatMap((m) =>
        Array.from({ length: 8 }, (_, i) => ({
          userId: m.userId,
          createdAt: new Date(new Date('2026-09-03T10:00:00.000Z').getTime() + i * 1000),
        }))
      ),
      filenames: [
        { userId: 1, name: 'logo.jpg' },
        { userId: 2, name: 'logo.jpg' },
        { userId: 3, name: 'logo.jpg' },
      ],
    });
    const s = await collectCohortSignals(reader, members, {
      chunkSize: 5,
      filenameBatchSize: 1,
      maxStagedImageSamples: 1,
    });
    expect(s.sources.stagedImageBudgetExhausted).toBe(true);
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
  /**
   * The port's dependency bag, named once.
   *
   * 🔴 `NonNullable`, BECAUSE THE PARAMETER HAS A DEFAULT. `createEvidenceReader(deps = {})`
   * makes its parameter optional, so `Parameters<typeof createEvidenceReader>[0]` is
   * `{…} | undefined` and indexing `['db']` off it does not compile. Spelled out because the naked
   * form was written at four call sites here and every one of them was a type error invisible to
   * every gate in this repo: `tsconfig.json` excludes this whole directory from the program, and
   * vitest does not typecheck. Nothing would have gone red.
   */
  type ReaderDeps = NonNullable<Parameters<typeof createEvidenceReader>[0]>;

  /**
   * The shared image double.
   *
   * 🔴 IT ANSWERS THE FILENAME OVERLOAD, AND THE CAST AT EACH CALL SITE IS WHY THAT IS SAYABLE.
   * `EvidenceDb['image']['findMany']` is an OVERLOAD PAIR — one signature returning
   * `FilenameSampleRow[]`, one returning `StagedImageRow[]` — and a single `vi.fn` cannot be
   * assignable to both while returning one row shape. The cases that drive the staged read through
   * this double assert its CALL ARGUMENTS and never its rows, so answering one overload is the
   * honest encoding rather than a gap; the cases that need real staged rows build their own double.
   *
   * The declared parameter is not decoration either: with an implementation that takes none, the
   * mock's recorded calls are typed `[]` and destructuring `([a]) => …` off an empty tuple does not
   * compile. It is declared on the TYPE ARGUMENT rather than on the implementation so the double
   * still ignores what it is handed, without an unused binding.
   */
  const db = {
    image: {
      findMany: vi.fn<(args: unknown) => Promise<{ userId: number; name: string }[]>>(async () => [
        { userId: 3, name: 'logo.jpg' },
      ]),
    },
  };
  const readerDb = db as unknown as ReaderDeps['db'];

  it('🔴 reports the IP source as unavailable when there is no ClickHouse client', async () => {
    const reader = createEvidenceReader({ db: readerDb, ch: null });
    expect(reader.hasRegistrationIps).toBe(false);
    // And asking anyway returns nothing rather than throwing — the caller's flag is the record.
    expect(await reader.listRegistrationIps([1, 2])).toEqual([]);
  });

  it('🔴 reads the image surface ONCE PER MEMBER, passing the bound through', async () => {
    // 🔴 ONE STATEMENT PER ACCOUNT, NOT ONE PER LIST. It used to be a single `IN (…)` read, and
    // that single statement carried both defects this change removes — see `filenameSampleArgs`.
    // The fan-out is asserted by CALL COUNT and by the arguments of each call, because "it returned
    // rows" is true of the broken shape too.
    const reader = createEvidenceReader({ db: readerDb, ch: null });
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
      db: { ...db, image } as unknown as ReaderDeps['db'],
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

  it('🔴 ONE per-member read rejecting inside the fan-out REJECTS THE WHOLE BATCH', async () => {
    // 🔴 THE ONLY PLACE IN THIS MODULE WHERE N INDEPENDENT I/O CALLS ARE COMBINED, AND IT HAD NO
    // PARTIAL-FAILURE GUARD. Every existing failure case throws at the `EvidenceReader` BOUNDARY
    // (`fakeReader({ filenameError })`), one level ABOVE this seam — nothing drove a single
    // per-member `findMany` rejection through `createEvidenceReader`. Mutating the `Promise.all`
    // here to a `Promise.allSettled` that keeps the fulfilled results left the suite 362/362 green.
    //
    // 🔴 "MAKE IT RESILIENT WITH allSettled" IS THE OBVIOUS FUTURE EDIT AND IT INVERTS THIS
    // MODULE'S CENTRAL INVARIANT. A fingerprint count built from SOME of the members understates
    // every ring that straddles the missing ones, and understating is the direction that produces a
    // confident zero — while `evidence_source_read_failures` would read 0, because nothing threw
    // out of this method. A quieter, lower, cleaner-looking number: the exact failure shape this
    // whole PR exists to remove, arrived at from the other side.
    const image = {
      findMany: vi.fn(async (args: ReturnType<typeof filenameSampleArgs>) => {
        // Only ONE member's read fails, and it is not the first — so a fan-out that abandoned the
        // rest on the first rejection, and one that kept everything else, both still have data.
        if ((args.where.userId as unknown as number) === 2) throw new Error('replica timeout');
        return [{ userId: args.where.userId as unknown as number, name: 'logo.jpg' }];
      }),
    };
    const reader = createEvidenceReader({
      db: { ...db, image } as unknown as ReaderDeps['db'],
      ch: null,
    });

    // ALL OR NOTHING: the rejection propagates, so the caller never sees members 1 and 3's rows.
    // Under `allSettled`-keep-fulfilled this resolves to two rows instead and the assertion fails
    // with its own message rather than with someone else's.
    await expect(reader.listFilenameSamples([1, 2, 3], 5)).rejects.toThrow('replica timeout');
  });

  it('🔴 …and `collectCohortSignals` DISCARDS the partial data already read and RECORDS the failure', async () => {
    // The other half of the invariant, driven end to end through the REAL reader rather than
    // through a fake that models the boundary. The structural claim above (it rejects) is not the
    // claim that matters on its own — what matters is what the walk then does with it: the rows
    // ALREADY IN HAND from an earlier batch are dropped, availability goes false, and
    // `readFailures.filenameSamples` goes true so the run is legible as BROKEN rather than as quiet.
    //
    // 🔴 THE FIXTURE MUST SPAN MORE THAN ONE BATCH AND THE FAILURE MUST LAND IN A LATER ONE, or the
    // discard is unreachable and this test is coverage that covers nothing. It previously used 3
    // members at `filenameBatchSize: 3` — ONE batch, which rejects with `filenameSamples` still
    // empty, so every assertion below held whether or not the discard existed and deleting
    // `filenameSamples.length = 0;` from `collectCohortSignals`'s filename `catch` left the module
    // suite fully green. Nine members at batch size 3 fail in batch TWO of three: batch one's rows
    // are in hand when the failure arrives, so only the discard can remove them, and batch three is
    // never issued. This mirrors the content-side template — 'discards the PARTIAL content already
    // read when a later chunk fails' in the `collectCohortSignals` block above. In production the
    // batch is `FILENAME_READ_BATCH_SIZE` (10) over up to `MAX_COHORT_ACCOUNTS` members, roughly
    // 2,500 batches, so failing after the first batch is the ORDINARY case, not the exotic one.
    // 🔴 THE STAGED-IMAGE READ SHARES THIS MOCK, BECAUSE IT SHARES THE TABLE. Both reads are
    // `image.findMany`, so a mock that threw for member 5 whatever it was asked would fail BOTH
    // walks — and this case's closing assertion, that the failure is scoped to its own source,
    // would then be passing because the fixture made every source fail rather than because the
    // code keeps them apart. Discriminating on the arguments is what keeps the two claims separate.
    const isStaged = (args: { where: Record<string, unknown> }) => 'postId' in args.where;
    const image = {
      findMany: vi.fn(async (args: ReturnType<typeof filenameSampleArgs>) => {
        const userId = args.where.userId as unknown as number;
        if (isStaged(args as unknown as { where: Record<string, unknown> })) return [];
        // Member 5 sits in the SECOND batch of [1,2,3] [4,5,6] [7,8,9].
        if (userId === 5) throw new Error('replica timeout');
        return [{ userId, name: 'ring.jpg' }];
      }),
    };
    const reader = createEvidenceReader({
      db: { ...db, image } as unknown as ReaderDeps['db'],
      ch: null,
    });
    const members = Array.from({ length: 9 }, (_, i) => member(i + 1, 'ring.test'));
    const s = await collectCohortSignals(reader, members, {
      chunkSize: 9,
      filenameBatchSize: 3,
    });

    // 🔴 THE ASSERTION THE DISCARD OWNS. Without it, batch one's three `ring.jpg` rows survive the
    // `catch` and this map holds one filename key counted at 3 — three accounts scored as a
    // filename ring out of a read that FAILED, while `sources.filenameSamples` is false and
    // `readFailures` says so, because `buildCohortSignals` indexes the rows it is handed and
    // consults neither flag.
    expect([...s.membersPerFingerprint.keys()]).toEqual([]);
    expect(s.sources.filenameSamples).toBe(false);
    expect(s.sources.readFailures.filenameSamples).toBe(true);
    expect(s.sources.membersSampledForFilenames).toBe(0);
    // Six statements, not nine: the walk stops at the failing batch instead of carrying on into the
    // third. Asserted by count because "it returned nothing" is true of a walk that kept going too.
    // Counted over the FILENAME calls only — the staged-image walk issues its own nine against the
    // same mock, so a bare `toHaveBeenCalledTimes` would be reading the sum of two walks.
    const filenameCalls = image.findMany.mock.calls.filter(
      ([args]) => !isStaged(args as unknown as { where: Record<string, unknown> })
    );
    expect(filenameCalls).toHaveLength(6);
    // And the failure is scoped to its own source — the other three flags are untouched. The
    // staged-image flag is the sharp one here: its read hit the SAME mock on the SAME table and
    // completed, so a `true` would mean one source's failure had been recorded under another's name.
    expect(s.sources.readFailures).toEqual({
      registrationIps: false,
      filenameSamples: true,
      stagedImages: false,
    });
  });

  it('issues no filename statement for an empty id list or a zero take', async () => {
    const reader = createEvidenceReader({ db: readerDb, ch: null });
    db.image.findMany.mockClear();
    expect(await reader.listFilenameSamples([], 10)).toEqual([]);
    expect(await reader.listFilenameSamples([1], 0)).toEqual([]);
    expect(db.image.findMany).not.toHaveBeenCalled();
  });

  it('🔴 reads STAGED images once per member too, with the staged predicates on every call', async () => {
    // 🔴 THE SAME SHAPE AS THE FILENAME READ AND FOR THE SAME MEASURED REASON — a wide `IN (…)` over
    // `Image` under a `LIMIT` never completed. Asserted by call count AND by each call's arguments,
    // because "it returned rows" is true of the broken shape as well. The predicates are checked on
    // every call rather than on the first: a fan-out that built the filter once and reused it for
    // member one only is a shape this assertion would otherwise pass.
    const reader = createEvidenceReader({ db: readerDb, ch: null });
    db.image.findMany.mockClear();
    const before = new Date('2026-09-03T12:00:00.000Z');
    await reader.listStagedImageSamples([4, 5, 6], 9, before);
    expect(db.image.findMany).toHaveBeenCalledTimes(3);

    // The mock is declared with no parameters, so its recorded calls are untyped. Narrowed once
    // here rather than at each assertion, to the shape the builder under test actually returns.
    const stagedArgs = db.image.findMany.mock.calls.map(
      ([a]) => a as unknown as ReturnType<typeof stagedImageSampleArgs>
    );
    expect(stagedArgs.map((a) => a.where.userId)).toEqual([4, 5, 6]);
    for (const args of stagedArgs) {
      expect(args.where.postId).toBeNull();
      expect(args.where.meta).toEqual({ equals: Prisma.AnyNull });
      expect(args.where).toHaveProperty('createdAt', { lte: before });
      expect(args.take).toBe(9);
    }
  });

  it('🔴 ONE per-member staged read rejecting inside the fan-out REJECTS THE WHOLE BATCH', async () => {
    // 🔴 DO NOT "MAKE THIS RESILIENT" WITH `Promise.allSettled`. Keeping the fulfilled half would
    // not produce a vaguer answer here, it would produce a LOWER one: this heuristic scores a member
    // on how many staged uploads it HAS, so a member whose rows went missing is scored 0 and reads
    // as an account that published everything. The rejection is what makes
    // `collectCohortSignals` discard the batch and record the failure instead.
    const image = {
      findMany: vi.fn(async (args: ReturnType<typeof stagedImageSampleArgs>) => {
        const userId = args.where.userId as unknown as number;
        if (userId === 2) throw new Error('replica timeout');
        return [{ userId, createdAt: new Date('2026-09-03T10:00:00.000Z') }];
      }),
    };
    const reader = createEvidenceReader({
      db: { ...db, image } as unknown as ReaderDeps['db'],
      ch: null,
    });
    await expect(reader.listStagedImageSamples([1, 2, 3], 5)).rejects.toThrow('replica timeout');
  });

  it('issues no staged statement for an empty id list or a zero take', async () => {
    const reader = createEvidenceReader({ db: readerDb, ch: null });
    db.image.findMany.mockClear();
    expect(await reader.listStagedImageSamples([], 10)).toEqual([]);
    expect(await reader.listStagedImageSamples([1], 0)).toEqual([]);
    expect(db.image.findMany).not.toHaveBeenCalled();
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
    const reader = createEvidenceReader({ db: readerDb, ch });
    expect(await reader.listRegistrationIps([7, 8])).toEqual([{ userId: 7, ip: '203.0.113.9' }]);
  });
});
