import { describe, expect, it } from 'vitest';
import type { BotAccountCohortMember, SurfaceCounts } from '../cohort';
import { emptyCohortSignals, type CohortSignals, type StagedImageFacts } from '../evidence';
import { BOT_ACCOUNT_HEURISTICS } from '../heuristics';
import {
  COMMON_EMAIL_DOMAINS,
  DOMAIN_ONE_AT,
  DOMAIN_ZERO_AT,
  IP_ONE_AT,
  IP_ZERO_AT,
  domainClusterIsNamedInReason,
  domainClusterSize,
  isCommonEmailDomain,
  largestIpCluster,
  registrationClusterGroupKey,
  registrationClusterHeuristic,
} from '../heuristics/clustering';
import { rampScore } from '../heuristics/ramp';
import {
  CLUSTER_ONE_AT,
  CLUSTER_ZERO_AT,
  contentTemplatingHeuristic,
  contentTemplatingSourceScore,
  largestContentCluster,
} from '../heuristics/similarity';
import {
  BURST_ONE_AT,
  BURST_ZERO_AT,
  STAGED_ONE_AT,
  STAGED_ZERO_AT,
  assetStagingHalfScores,
  assetStagingHeuristic,
  stagedImageFacts,
} from '../heuristics/staging';
import { filenameFingerprint } from '../evidence';
import { FILENAME_FINGERPRINT_PREFIX } from '../fingerprint-keys';
import {
  MIN_AGE_HOURS,
  MIN_ITEMS,
  ONE_AT_PER_HOUR,
  ZERO_AT_PER_HOUR,
  effectiveAgeHours,
  itemsPerHour,
  postingVelocityHeuristic,
} from '../heuristics/velocity';
import {
  LONE_SIGNAL_CUT,
  MIN_REPORTED_CONFIDENCE,
  partitionByConfidence,
  scoreAccount,
  type BotAccountEvidence,
} from '../scoring';

const at = (iso: string) => new Date(iso);
const NOW = at('2026-09-03T12:00:00.000Z');

const surface = (partial: Partial<SurfaceCounts> = {}): SurfaceCounts => {
  const row = { comments: 0, models: 0, images: 0, ...partial };
  return { ...row, total: row.comments + row.models + row.images };
};

/**
 * `visible` defaults to everything posted. Where a case needs them to DIFFER it says so — the
 * velocity heuristic reading the wrong one is a specific regression with its own case below.
 */
const member = (
  overrides: Partial<BotAccountCohortMember> & { all?: Partial<SurfaceCounts> } = {}
): BotAccountCohortMember => {
  const { all, ...rest } = overrides;
  const allCounts = surface(all ?? { images: 3 });
  return {
    userId: 42,
    username: 'candidate',
    createdAt: at('2026-09-03T09:00:00.000Z'),
    posts: { all: allCounts, visible: allCounts, excluded: surface() },
    emailDomain: 'unusual.test',
    ...rest,
  };
};

const evidence = (
  m: BotAccountCohortMember,
  signals: CohortSignals = emptyCohortSignals(),
  now = NOW
): BotAccountEvidence => ({ member: m, now, signals });

/** A signals index built from plain declarations, so a case reads as the world it describes. */
function signalsWith(spec: {
  ips?: Record<number, string[]>;
  membersPerIp?: Record<string, number>;
  membersPerDomain?: Record<string, number>;
  fingerprints?: Record<number, string[]>;
  membersPerFingerprint?: Record<string, number>;
  staged?: Record<number, StagedImageFacts>;
  sources?: Partial<CohortSignals['sources']>;
}): CohortSignals {
  const s = emptyCohortSignals();
  for (const [userId, facts] of Object.entries(spec.staged ?? {}))
    s.stagedImagesByUser.set(Number(userId), facts);
  for (const [userId, ips] of Object.entries(spec.ips ?? {})) s.ipsByUser.set(Number(userId), ips);
  for (const [ip, n] of Object.entries(spec.membersPerIp ?? {})) s.membersPerIp.set(ip, n);
  for (const [d, n] of Object.entries(spec.membersPerDomain ?? {})) s.membersPerDomain.set(d, n);
  for (const [userId, fps] of Object.entries(spec.fingerprints ?? {}))
    s.fingerprintsByUser.set(Number(userId), fps);
  for (const [fp, n] of Object.entries(spec.membersPerFingerprint ?? {}))
    s.membersPerFingerprint.set(fp, n);
  s.sources = { ...s.sources, ...spec.sources };
  return s;
}

/** One member's staged-upload facts, as the index carries them. */
const stagedSignals = (userId: number, facts: StagedImageFacts) =>
  signalsWith({ staged: { [userId]: facts } });

// ---------------------------------------------------------------------------------------------
// The shared ramp
// ---------------------------------------------------------------------------------------------

describe('rampScore', () => {
  it('scores exactly 0 AT the zero boundary, not just below it', () => {
    // 🔴 THE OFF-BY-ONE THIS NAMING EXISTS TO PREVENT. `zeroAt` is the largest value still worth
    // nothing, so with `zeroAt: 2` a cluster of TWO scores nothing and a cluster of three is the
    // smallest that scores. Reading it as "the smallest value that fires" moves every threshold in
    // this directory one step earlier — which surfaces as noise on a board, not as an error.
    expect(rampScore(2, 2, 10)).toBe(0);
    expect(rampScore(1, 2, 10)).toBe(0);
    expect(rampScore(-5, 2, 10)).toBe(0);
  });

  it('scores exactly 1 AT the one boundary, and stays there above it', () => {
    expect(rampScore(10, 2, 10)).toBe(1);
    expect(rampScore(400, 2, 10)).toBe(1);
  });

  it('interpolates linearly between them', () => {
    // 5 of the way from 2 to 10 is 3/8 — deliberately not a half, a third or a round tenth, so a
    // mutant that averages the bounds, divides by `oneAt`, or drops the `- zeroAt` cannot land on
    // it. (Those give 0.5, 0.5 and 0.625 respectively.)
    expect(rampScore(5, 2, 10)).toBeCloseTo(0.375, 12);
    expect(rampScore(7, 2, 10)).toBeCloseTo(0.625, 12);
  });

  it('scores a non-finite value 0 rather than 1', () => {
    // Same asymmetry `clampScore` states: a non-finite input is a DEFECT in whatever produced it —
    // a divide by zero — not a maximal opinion about the account.
    expect(rampScore(Number.NaN, 2, 10)).toBe(0);
    expect(rampScore(Number.POSITIVE_INFINITY, 2, 10)).toBe(0);
  });

  it('🔴 throws on inverted or coincident boundaries rather than scoring', () => {
    // A heuristic with these constants would look calibrated while emitting only 0 and 1. Failing
    // at the call is how that is found in a test rather than in a moderator's queue.
    expect(() => rampScore(5, 10, 2)).toThrow(/oneAt > zeroAt/);
    expect(() => rampScore(5, 4, 4)).toThrow(/oneAt > zeroAt/);
  });
});

// ---------------------------------------------------------------------------------------------
// Heuristic 1 — posting velocity
// ---------------------------------------------------------------------------------------------

describe('posting-velocity', () => {
  const score = (m: BotAccountCohortMember, now = NOW) =>
    postingVelocityHeuristic.score(evidence(m, emptyCohortSignals(), now));

  it('🔴 pins its constants, separately from the behavioural cases', () => {
    // Same reasoning as the two ring heuristics: every behavioural case below uses LITERAL item
    // counts and timestamps, so none of them says anything about these values. This does.
    expect(MIN_ITEMS).toBe(5);
    expect(MIN_AGE_HOURS).toBe(0.25);
    expect(ZERO_AT_PER_HOUR).toBe(4);
    expect(ONE_AT_PER_HOUR).toBe(40);
  });

  it('floors the age divisor, so a minutes-old account is not scored on scheduler jitter', () => {
    // Without the floor the rate is unbounded and how extreme it looks depends on the gap between
    // the signup and the cron tick, which is nothing to do with the account.
    const oneMinuteOld = at('2026-09-03T11:59:00.000Z');
    expect(effectiveAgeHours(oneMinuteOld, NOW)).toBe(MIN_AGE_HOURS);
    // A clock that ran backwards is skew between the app and the database, not a negative age.
    expect(effectiveAgeHours(at('2026-09-03T13:00:00.000Z'), NOW)).toBe(MIN_AGE_HOURS);
  });

  it('computes items per hour against the floored age', () => {
    // 9 items over 3 hours — distinct from both operands and not a round rate.
    expect(itemsPerHour(9, at('2026-09-03T09:00:00.000Z'), NOW)).toBeCloseTo(3, 12);
  });

  it('🔴 scores 0 below the volume gate however fast the rate looks', () => {
    // The divisor floor makes a tiny numerator look fast: 4 items from a 6-minute-old account is
    // 16/hour, well past `ZERO_AT_PER_HOUR`. Four items is not a wave under any reading, and a
    // detector that says it is says it about a large share of every day's genuine signups.
    const tiny = member({
      all: { images: MIN_ITEMS - 1 },
      createdAt: at('2026-09-03T11:54:00.000Z'),
    });
    expect(itemsPerHour(MIN_ITEMS - 1, tiny.createdAt, NOW)).toBeGreaterThan(ZERO_AT_PER_HOUR);
    expect(score(tiny)).toBe(0);
  });

  it('scores a genuine wave at the top of the ramp', () => {
    // 40 uploads from an account 20 minutes old: 40 / 0.333h = 120/hour, three times
    // `ONE_AT_PER_HOUR`. Deliberately overshoots rather than landing on the boundary.
    const wave = member({ all: { images: 40 }, createdAt: at('2026-09-03T11:40:00.000Z') });
    expect(score(wave)).toBe(1);
  });

  it('scores an ordinary new account 0', () => {
    // 6 items over 11 hours is 0.55/hour — an enthusiastic newcomer, comfortably under the floor.
    const ordinary = member({
      all: { images: 4, comments: 2 },
      createdAt: at('2026-09-03T01:00:00.000Z'),
    });
    expect(score(ordinary)).toBe(0);
  });

  it('lands between the boundaries for a middling rate', () => {
    // 13 items in 1 hour = 13/hour. (13 - 4) / (40 - 4) = 0.25. Chosen so the numerator and the
    // span share no factor with the item count, and so no mutant reading `total` as the rate, or
    // dropping the `- ZERO_AT_PER_HOUR`, produces 0.25.
    const middling = member({ all: { images: 13 }, createdAt: at('2026-09-03T11:00:00.000Z') });
    expect(score(middling)).toBeCloseTo(0.25, 12);
  });

  it('🔴 counts everything posted, NOT what is still on the site', () => {
    // The canonical bot wave: 40 uploads, every one blocked by the scanner. Reading `visible` here
    // would score this account 0 — silently zeroing precisely the accounts the detector exists to
    // find, and by the same mistake membership was once decided on.
    const allBlocked = member({
      createdAt: at('2026-09-03T11:40:00.000Z'),
      posts: {
        all: surface({ images: 40 }),
        visible: surface(),
        excluded: surface({ images: 40 }),
      },
    });
    expect(score(allBlocked)).toBe(1);
  });

  it('explains itself with the numbers it used, and says nothing at zero', () => {
    const wave = member({ all: { images: 40 }, createdAt: at('2026-09-03T11:40:00.000Z') });
    const note = postingVelocityHeuristic.explain(evidence(wave), 1);
    expect(note).toContain('posted 40 items in');
    expect(note).toContain('/hour');
    // Singular too, at the other end: a helper hardcoded to always append `s` passes the line above
    // and fails only here.
    //
    // ⚠️ THE SINGULAR IS NOT REACHABLE THROUGH THE HEURISTIC, AND THIS CASE FABRICATES THE SCORE TO
    // GET AT IT. `score` returns 0 below `MIN_ITEMS` (5) and `explain` returns null at 0, so one
    // item can never render this clause on a real run — the `1` passed here is a score no caller
    // would produce for this member. The agreement is written anyway for the reason
    // `heuristics/staging.ts` gives for its own unreachable singular: `explain` is a pure function
    // anyone may call, and a boundary that moves must not leave a grammar bug behind it. An earlier
    // wording here claimed the fixture sat AT `MIN_ITEMS`; it is four below it.
    const lone = member({ all: { images: 1 }, createdAt: at('2026-09-03T11:40:00.000Z') });
    expect(postingVelocityHeuristic.score(evidence(lone))).toBe(0); // the premise, asserted
    expect(postingVelocityHeuristic.explain(evidence(lone), 1)).toContain('posted 1 item in');
    // A reason reciting every heuristic that did NOT fire buries the one that did.
    expect(postingVelocityHeuristic.explain(evidence(member()), 0)).toBeNull();
  });

  it('needs no cohort-level evidence at all', () => {
    // The cheapest of the three and the only one that cannot degrade: both numbers rode in on the
    // cohort read. Scoring against a wholly empty index must be unaffected.
    const wave = member({ all: { images: 40 }, createdAt: at('2026-09-03T11:40:00.000Z') });
    expect(score(wave)).toBe(postingVelocityHeuristic.score(evidence(wave, emptyCohortSignals())));
  });
});

// ---------------------------------------------------------------------------------------------
// Heuristic 2 — registration clustering
// ---------------------------------------------------------------------------------------------

describe('registration-cluster', () => {
  const score = (m: BotAccountCohortMember, s: CohortSignals) =>
    registrationClusterHeuristic.score(evidence(m, s));

  it('picks the LARGEST cluster among an account’s registration IPs', () => {
    // 🔴 THE LARGEST IS FIRST IN THE LIST, DELIBERATELY. With it last, "take the max" and "take the
    // last" agree, so a `>` → `>=` mutant — or a loop that simply keeps overwriting — survives a
    // green test. Ordering the fixture so the answer is NOT the last element is what makes this a
    // test of the comparison rather than of the iteration.
    const s = signalsWith({
      ips: { 42: ['big', 'small'] },
      membersPerIp: { big: 7, small: 3 },
    });
    expect(largestIpCluster(42, s)).toEqual({ size: 7, ip: 'big' });
  });

  it('reports nothing for an account with no recorded IP', () => {
    expect(largestIpCluster(42, signalsWith({}))).toEqual({ size: 0, ip: null });
  });

  it('🔴 pins the boundary CONSTANTS, so moving one is a deliberate edit', () => {
    // 🔴 SEPARATED FROM THE BEHAVIOURAL CASES ON PURPOSE. Those use literals; this pins the values.
    // Writing a boundary case as `membersPerIp: { x: IP_ZERO_AT }` reads as thorough and is
    // VACUOUS — the expectation is computed from the very constant under test, so shifting the
    // constant shifts the test with it and the case passes at any value. Measured: a mutant moving
    // `IP_ZERO_AT` from 2 to 1 survived its own boundary test for exactly that reason.
    expect(IP_ZERO_AT).toBe(2);
    expect(IP_ONE_AT).toBe(10);
    expect(DOMAIN_ZERO_AT).toBe(3);
    expect(DOMAIN_ONE_AT).toBe(15);
  });

  it('scores 0 at an IP cluster of two, and fires from three', () => {
    // Two accounts on one address is a household or a phone. LITERAL sizes, so this case is a
    // statement about behaviour at 2 and 3 rather than about whatever the constant happens to say.
    const two = signalsWith({ ips: { 42: ['x'] }, membersPerIp: { x: 2 } });
    expect(score(member(), two)).toBe(0);
    const three = signalsWith({ ips: { 42: ['x'] }, membersPerIp: { x: 3 } });
    expect(score(member(), three)).toBeCloseTo(0.125, 12);
  });

  it('saturates at a large IP ring', () => {
    // Overshoots the boundary rather than landing on it.
    const big = signalsWith({ ips: { 42: ['x'] }, membersPerIp: { x: 15 } });
    expect(score(member(), big)).toBe(1);
  });

  it('breaks a tie on the FIRST IP, deterministically', () => {
    // Two IPs of equal size: which one is named must not depend on iteration luck. Pinned because
    // `>` and `>=` in the max loop differ ONLY on a tie, so without this case the comparison is
    // untested — a survived mutant, measured.
    const tied = signalsWith({
      ips: { 42: ['first', 'second'] },
      membersPerIp: { first: 5, second: 5 },
    });
    expect(largestIpCluster(42, tied)).toEqual({ size: 5, ip: 'first' });
  });

  it('🔴 scores a common mail provider 0 at ANY cluster size', () => {
    // Without the suppression this heuristic is anti-correlated: `gmail.com` is the largest cluster
    // in every cohort every day, so cluster size would hand the board the day's most ordinary
    // accounts at maximum confidence while a real disposable-domain ring scored lower.
    const huge = signalsWith({ membersPerDomain: { 'gmail.com': 900 } });
    expect(score(member({ emailDomain: 'gmail.com' }), huge)).toBe(0);
    expect(domainClusterSize('gmail.com', huge.membersPerDomain)).toBe(0);
    // Case-insensitively, because the domain arrives lowercased but the set must not depend on it.
    expect(isCommonEmailDomain('GMAIL.COM')).toBe(true);
  });

  it('scores an uncommon domain ring, and 0 at the boundary', () => {
    // Literal sizes, for the reason given on the constants case above.
    const atBoundary = signalsWith({ membersPerDomain: { 'ring.test': 3 } });
    expect(score(member({ emailDomain: 'ring.test' }), atBoundary)).toBe(0);
    const justOver = signalsWith({ membersPerDomain: { 'ring.test': 5 } });
    expect(score(member({ emailDomain: 'ring.test' }), justOver)).toBeCloseTo(1 / 6, 12);
    const past = signalsWith({ membersPerDomain: { 'ring.test': 19 } });
    expect(score(member({ emailDomain: 'ring.test' }), past)).toBe(1);
  });

  it('scores an account with no email domain 0 rather than throwing', () => {
    expect(score(member({ emailDomain: null }), signalsWith({}))).toBe(0);
    expect(domainClusterSize(null, new Map())).toBe(0);
  });

  it('🔴 combines the two halves with max, so the sub-score stays a ring size', () => {
    // 7 accounts on an IP is (7-2)/8 = 0.625; 8 on a domain is (8-3)/12 = 0.4167. A sum would be
    // 1.04 — clamped to 1, i.e. indistinguishable from total certainty — and the number in the
    // reason string would stop meaning "the size of the ring this account is in".
    const both = signalsWith({
      ips: { 42: ['x'] },
      membersPerIp: { x: 7 },
      membersPerDomain: { 'unusual.test': 8 },
    });
    expect(score(member(), both)).toBeCloseTo(0.625, 12);
  });

  it('🔴 still scores on the domain half when the IP source was unavailable', () => {
    // The half that costs no query keeps working, which is the point of splitting them.
    const domainOnly = signalsWith({
      membersPerDomain: { 'unusual.test': DOMAIN_ONE_AT + 2 },
      sources: { registrationIps: false },
    });
    expect(score(member(), domainOnly)).toBe(1);
    // And the note SAYS the IP half did not run, so a reader does not take the score as a
    // statement about IPs.
    expect(registrationClusterHeuristic.explain(evidence(member(), domainOnly), 1)).toContain(
      'UNAVAILABLE'
    );
  });

  it('🔴 never quotes the IP address itself into the reason', () => {
    // The abuse board is a wider audience than the IP-lookup tool. A moderator who needs the
    // address has `getAccountsOnIps`, which carries the paging and already-banned marking this
    // sentence cannot.
    const s = signalsWith({ ips: { 42: ['203.0.113.7'] }, membersPerIp: { '203.0.113.7': 9 } });
    const note = registrationClusterHeuristic.explain(evidence(member(), s), 0.9);
    expect(note).toContain('9 new posting accounts share its registration IP');
    expect(note).not.toContain('203.0.113.7');
  });

  it('the common-domain list is lowercase and non-trivial', () => {
    expect(COMMON_EMAIL_DOMAINS.size).toBeGreaterThan(10);
    for (const d of COMMON_EMAIL_DOMAINS) expect(d).toBe(d.toLowerCase());
  });

  it('🔴 suppresses the NON-ANGLOPHONE providers too, where the false positives actually land', () => {
    // 🔴 THE ORIGINAL LIST WAS ANGLOPHONE, AND ITS OMISSIONS WERE NOT RANDOM. `hotmail.com` and
    // `hotmail.co.uk` were listed; `hotmail.fr/de/es/it` were not — so nine new posting accounts a
    // day on one country's ordinary free provider scored like a ring, and the standing false
    // positive fell systematically on people who do not write in English. Each of these is one
    // country's commonest webmail or ISP address, not an exotic case.
    for (const domain of [
      'hotmail.fr',
      'hotmail.de',
      'hotmail.es',
      'hotmail.it',
      'web.de',
      't-online.de',
      'free.fr',
      'orange.fr',
      'laposte.net',
      'libero.it',
      'virgilio.it',
      'uol.com.br',
      'terra.com.br',
      'seznam.cz',
      'wp.pl',
      'yandex.com',
      'ya.ru',
      'foxmail.com',
      'daum.net',
      'naver.com',
      'nate.com',
      'rediffmail.com',
      'comcast.net',
      'btinternet.com',
      'bigpond.com',
    ])
      expect(isCommonEmailDomain(domain), `${domain} is not suppressed`).toBe(true);
  });

  it('🔴 suppresses `pm.me` — Proton’s own alias domain, the sharpest omission', () => {
    // `proton.me` and `protonmail.com` were both listed and `pm.me` was not, although Proton offers
    // it to every paid account and it is exactly as ordinary as the other two. Asserted on its own
    // because the whole family has to be suppressed or none of it is: a ring on the missing member
    // of a listed family is the case the list is least likely to be re-read for.
    for (const domain of ['proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me'])
      expect(isCommonEmailDomain(domain)).toBe(true);
    // Scored, not merely classified — the classification only matters through this.
    const huge = signalsWith({ membersPerDomain: { 'pm.me': 40 } });
    expect(score(member({ emailDomain: 'pm.me' }), huge)).toBe(0);
  });

  it('🔴 a NEGATIVE control: the list does not swallow every domain', () => {
    // The three cases above are all `true`, and a predicate wired to `() => true` passes all of
    // them while destroying the heuristic. An uncommon domain must still cluster.
    for (const domain of ['ring.test', 'freshdomain.xyz', 'mail.proton.me', 'notgmail.com'])
      expect(isCommonEmailDomain(domain), `${domain} was wrongly suppressed`).toBe(false);
    const ring = signalsWith({ membersPerDomain: { 'ring.test': 15 } });
    expect(score(member({ emailDomain: 'ring.test' }), ring)).toBe(1);
  });

  it('🔴 the list stays a WORD LIST, and the evasion it cannot close is one keystroke', () => {
    // Not a guard on the code — a statement of what extending the list bought and what it did not.
    // A domain on the list scores 0 by construction, so the list is also a map of where a ring
    // should register. The IP half is what carries this heuristic against anyone who reads it, and
    // the principled fix is a base rate rather than a longer list.
    const ringOnGmail = signalsWith({ membersPerDomain: { 'gmail.com': 40 } });
    expect(score(member({ emailDomain: 'gmail.com' }), ringOnGmail)).toBe(0);
    // …and the IP half of the SAME account still scores it, which is the part that survives.
    const ringOnGmailSharingAnIp = signalsWith({
      ips: { 42: ['203.0.113.9'] },
      membersPerIp: { '203.0.113.9': IP_ONE_AT },
      membersPerDomain: { 'gmail.com': 40 },
    });
    expect(score(member({ emailDomain: 'gmail.com' }), ringOnGmailSharingAnIp)).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Heuristic 3 — content templating
// ---------------------------------------------------------------------------------------------

describe('content-templating', () => {
  const score = (m: BotAccountCohortMember, s: CohortSignals) =>
    contentTemplatingHeuristic.score(evidence(m, s));

  it('picks the largest group any of the account’s texts belongs to', () => {
    // Largest FIRST, for the reason spelled out on the IP twin: with it last, "max" and "last"
    // agree and the comparison goes untested.
    const s = signalsWith({
      fingerprints: { 42: ['bigger', 'smaller'] },
      membersPerFingerprint: { bigger: 6, smaller: 2 },
    });
    expect(largestContentCluster(42, s)).toEqual({ size: 6, fingerprint: 'bigger' });
  });

  it('🔴 pins the boundary CONSTANTS separately from the behaviour', () => {
    // Same reasoning as the clustering twin: a boundary case written in terms of the constant is
    // vacuous about its value. Measured — a mutant moving `CLUSTER_ZERO_AT` from 2 to 1 survived.
    expect(CLUSTER_ZERO_AT).toBe(2);
    expect(CLUSTER_ONE_AT).toBe(10);
  });

  it('scores 0 for a pair and fires from three accounts', () => {
    // A pair of strangers writing the same masked sentence is common enough — a quoted
    // announcement, a stock phrase with a number in it — that scoring it is noise. LITERAL sizes.
    const pair = signalsWith({ fingerprints: { 42: ['t'] }, membersPerFingerprint: { t: 2 } });
    expect(score(member(), pair)).toBe(0);
    const trio = signalsWith({ fingerprints: { 42: ['t'] }, membersPerFingerprint: { t: 3 } });
    expect(score(member(), trio)).toBeCloseTo(0.125, 12);
  });

  it('saturates on a large ring', () => {
    const ring = signalsWith({ fingerprints: { 42: ['t'] }, membersPerFingerprint: { t: 17 } });
    expect(score(member(), ring)).toBe(1);
  });

  it('breaks a tie on the FIRST fingerprint, deterministically', () => {
    const tied = signalsWith({
      fingerprints: { 42: ['one', 'two'] },
      membersPerFingerprint: { one: 4, two: 4 },
    });
    expect(largestContentCluster(42, tied)).toEqual({ size: 4, fingerprint: 'one' });
  });

  it('scores an account whose content was never sampled 0, without throwing', () => {
    expect(score(member(), signalsWith({}))).toBe(0);
  });

  it('🔴 quotes the shared value so a moderator can confirm or dismiss it', () => {
    // The whole reason this is exact-match-after-normalisation rather than a distance measure: the
    // finding has to be checkable at a glance. The QUOTED form is what was actually compared, so a
    // reader is not shown a different string from the one that scored.
    //
    // An UNPREFIXED key is used deliberately: `unprefixFingerprint` returns it unchanged, so this
    // case exercises the quoting and the truncation rather than the namespace strip, which the
    // filename cases below own.
    const s = signalsWith({
      fingerprints: { 42: ['some-long-shared-upload-name.png'] },
      membersPerFingerprint: { 'some-long-shared-upload-name.png': 6 },
    });
    const note = contentTemplatingHeuristic.explain(evidence(member(), s), 0.5);
    expect(note).toBe(
      '6 new accounts uploaded a file with the same name — “some-long-shared-upload-name.png”'
    );
  });

  // -------------------------------------------------------------------------------------------
  // The filename half
  // -------------------------------------------------------------------------------------------

  /** A signals index holding one filename cluster of `size`, owned by member 42. */
  const filenameSignals = (name: string, size: number) => {
    const key = filenameFingerprint(name) as string;
    return signalsWith({ fingerprints: { 42: [key] }, membersPerFingerprint: { [key]: size } });
  };

  it('🔴 THE BOUNDARY, BOTH SIDES: two accounts sharing a filename score 0, three score', () => {
    // 🔴 THREE DISTINCT MEMBERS IS THE SMALLEST SCORING GROUP, and — together with the fact that
    // every member is an account under 24h old — it IS the innocent-collision defence. There is
    // deliberately no stoplist of generic filenames: the measured rings share exactly the
    // unremarkable names a stoplist would remove.
    //
    // LITERAL sizes and a LITERAL expected score, not expressions over the constants: a boundary
    // case written in terms of `CLUSTER_ZERO_AT` is vacuous about its value.
    expect(score(member(), filenameSignals('logo.jpg', 2))).toBe(0);
    expect(score(member(), filenameSignals('logo.jpg', 3))).toBeCloseTo(0.125, 12);
  });

  it('a lone account is not a cluster', () => {
    expect(score(member(), filenameSignals('logo.jpg', 1))).toBe(0);
  });

  it('saturates on a large filename ring', () => {
    expect(score(member(), filenameSignals('logo.jpg', 26))).toBe(1);
  });

  it('🔴 REGRESSION: no length floor reaches filenames — both of these cluster', () => {
    // 🔴 THE FILENAMES A CONFIRMED RING ACTUALLY SHARED. The deleted prose fingerprinter rejected
    // both outright (`1900.jpg.jpeg` → "nummask jpg jpeg", 16 chars / 3 tokens; `logo.jpg` →
    // "logo jpg", 8 / 2, against floors of 24 and 4 — measured by executing the shipped normaliser
    // while it existed). Had this source reused the prose fingerprint, the entire signal would have
    // been discarded before scoring.
    expect(score(member(), filenameSignals('1900.jpg.jpeg', 3))).toBeGreaterThan(0);
    expect(score(member(), filenameSignals('logo.jpg', 3))).toBeGreaterThan(0);
  });

  it('🔴 explain() quotes the PLAIN filename, never the namespaced key', () => {
    // The prefix is an implementation detail of the shared index. A moderator shown “file:logo.jpg”
    // would reasonably conclude the account uploaded a file by that literal name.
    const note = contentTemplatingHeuristic.explain(
      evidence(member(), filenameSignals('logo.jpg', 8)),
      0.75
    );
    expect(note).toContain('8 new accounts uploaded a file with the same name');
    expect(note).toContain('logo.jpg');
    expect(note).not.toContain(FILENAME_FINGERPRINT_PREFIX);
    // And it is named as a FILENAME rather than as posted text — a claim about an upload and a claim
    // about a comment call for different moderator actions, and the wording is the only thing that
    // distinguishes them. Pinned as a WHOLE STRING rather than as keywords, because a reword is
    // exactly how a guard on words gets walked past.
    expect(note).toBe('8 new accounts uploaded a file with the same name — “logo.jpg”');
  });

  // -------------------------------------------------------------------------------------------
  // Source isolation. One source is registered today; the mechanism is what the next one needs.
  // -------------------------------------------------------------------------------------------

  /**
   * A namespace this module does not currently produce.
   *
   * The comment-text source that used to supply `text:` keys is deleted, so a second REAL namespace
   * no longer exists — and the three cases below would be untestable if they were written in terms
   * of one. They are INVARIANT GUARDS, labelled as such: none of them was red at any base, and none
   * catches a bug that exists today. They exist because `largestContentCluster`'s prefix argument
   * and `contentTemplatingSourceScore` are kept deliberately (see `similarity.ts`) so the next
   * source folded in here arrives with its own counter from the first run, and an unexercised
   * mechanism is one that has quietly stopped working by the time that happens.
   */
  const OTHER_PREFIX = 'other:';

  it('scores on the LARGEST cluster across every source, whichever surface it is on', () => {
    const otherK = `${OTHER_PREFIX}some other surface`;
    const fileK = filenameFingerprint('logo.jpg') as string;
    const s = signalsWith({
      fingerprints: { 42: [otherK, fileK] },
      membersPerFingerprint: { [otherK]: 3, [fileK]: 9 },
    });
    expect(largestContentCluster(42, s)).toEqual({ size: 9, fingerprint: fileK });
  });

  it('🔴 contentTemplatingSourceScore isolates ONE source (invariant guard)', () => {
    // 🔴 WITHOUT THIS THE COUNTERS CANNOT SEE WHICH SOURCE FIRED — and an invisible zero-firing
    // source is precisely how the deleted comment source survived every run it shipped in.
    const otherK = `${OTHER_PREFIX}some other surface`;
    const fileK = filenameFingerprint('logo.jpg') as string;
    const s = signalsWith({
      fingerprints: { 42: [otherK, fileK] },
      // The other source's cluster is below the floor; the filename cluster is not.
      membersPerFingerprint: { [otherK]: 2, [fileK]: 9 },
    });
    expect(contentTemplatingSourceScore(42, s, OTHER_PREFIX)).toBe(0);
    expect(contentTemplatingSourceScore(42, s, FILENAME_FINGERPRINT_PREFIX)).toBeGreaterThan(0);
    // The blended score is carried entirely by the filename source.
    expect(score(member(), s)).toBe(
      contentTemplatingSourceScore(42, s, FILENAME_FINGERPRINT_PREFIX)
    );
  });

  it('🔴 a source score ignores the OTHER source entirely, even when it is larger', () => {
    // The isolation has to hold in both directions, or the decomposition just re-reports the max.
    const otherK = `${OTHER_PREFIX}some other surface`;
    const fileK = filenameFingerprint('logo.jpg') as string;
    const s = signalsWith({
      fingerprints: { 42: [otherK, fileK] },
      membersPerFingerprint: { [otherK]: 9, [fileK]: 3 },
    });
    expect(contentTemplatingSourceScore(42, s, FILENAME_FINGERPRINT_PREFIX)).toBeCloseTo(0.125, 12);
    expect(contentTemplatingSourceScore(42, s, OTHER_PREFIX)).toBeCloseTo(0.875, 12);
  });

  it('bounds the quote, so one long text cannot truncate the whole finding', () => {
    // `reason` is capped at 2,000 characters by the wire contract and an over-long quote here would
    // cost the post counts and the other two notes, not just itself.
    const long = 'a'.repeat(400);
    const s = signalsWith({ fingerprints: { 42: [long] }, membersPerFingerprint: { [long]: 5 } });
    const note = contentTemplatingHeuristic.explain(evidence(member(), s), 0.5) ?? '';
    expect(note.length).toBeLessThan(200);
    expect(note).toContain('…');
  });
});

// ---------------------------------------------------------------------------------------------
// Heuristic 4 — asset staging
// ---------------------------------------------------------------------------------------------

describe('asset-staging', () => {
  const score = (m: BotAccountCohortMember, s: CohortSignals) =>
    assetStagingHeuristic.score(evidence(m, s));

  it('🔴 pins the boundary CONSTANTS separately from the behaviour', () => {
    // Same reasoning as the three heuristics above: every behavioural case below uses LITERAL
    // counts and LITERAL expected scores, so none of them says anything about these values. A
    // boundary case written as `{ count: STAGED_ZERO_AT }` is vacuous about the constant under
    // test — measured on this module: a mutant moving `CLUSTER_ZERO_AT` survived exactly that.
    expect(STAGED_ZERO_AT).toBe(1);
    expect(STAGED_ONE_AT).toBe(2);
    expect(BURST_ZERO_AT).toBe(1);
    expect(BURST_ONE_AT).toBe(3);
  });

  it('🔴 the volume boundaries stay no wider than the burst ones, so the burst arm cannot lead', () => {
    // 🔴 ITS OWN CASE, NOT A TAIL ON THE ONE ABOVE, AND THAT IS THE WHOLE REASON IT IS HERE. These
    // two lines were first written at the end of the CONSTANTS case, directly after four literal
    // `toBe` pins on the same four constants. Vitest aborts an `it` at the first failed `expect`, so
    // behind those literals they were UNREACHABLE: every mutant they claimed to catch died two lines
    // earlier, and a relational assertion that can never be the failing line is documentation
    // wearing a guard's clothes. Split out, they can fail on their own and the claim below is true.
    //
    // WHAT THEY GUARD, stated no wider than it is: the volume ramp must be at or above the burst
    // ramp at every input — same or lower `zeroAt`, same or lower `oneAt`. Why that relationship is
    // what makes `max(volume, burst)` identically `volume`, and which half of it is actually load-
    // bearing at the shipped constants, is on `BURST_ONE_AT`. The literal pins above catch a BLIND
    // mutant of either constant.
    //
    // 🔴 THIS CASE IS NEVER THE SOLE FAILURE, AND CLAIMING IT CATCHES A RE-TUNE "THE LITERALS
    // CANNOT" WOULD OVERSELL IT. Measured: a dominance-breaking re-tune with its literal pin updated
    // turns ~10 other cases red too, because every such edit also moves a ramp and the behavioural
    // cases see it. Its unique value is one step further out — the author who re-tunes, updates the
    // literal pin AND updates the behavioural expectations, where this relation is the last thing
    // standing. That is the edit this PR itself performed on the volume side, which is why it is
    // worth four lines.
    //
    // 🔴 THE TWO LINES GUARD OPPOSITE SIDES, AND SAYING "BOTH CATCH A BURST RE-TUNE" WOULD BE ONE
    // BOUNDARY TOO WIDE. Measured: the `zeroAt` line fires on a BURST re-tune — `BURST_ZERO_AT` to 0
    // with its pin updated gives `expected 1 to be less than or equal to 0` here. The `oneAt` line
    // is what catches a VOLUME widening — `STAGED_ONE_AT` to 4 with its pin updated gives
    // `expected 4 to be less than or equal to 3`.
    //
    // A burst re-tune CAN reach the `oneAt` line — `BURST_ONE_AT` to 1 with its pin updated fires it
    // with `expected 2 to be less than or equal to 1`, because this case reads constants and never
    // calls `rampScore`. It is simply not a viable edit: that pair throws inside `rampScore` and
    // takes ~80 other cases with it. An earlier wording here said the line was "not reachable by any
    // integer burst re-tune", which was a false absolute of exactly the kind this file has spent
    // several rounds removing — unreachable and unviable are different claims.
    expect(STAGED_ZERO_AT).toBeLessThanOrEqual(BURST_ZERO_AT);
    expect(STAGED_ONE_AT).toBeLessThanOrEqual(BURST_ONE_AT);
  });

  it('🔴 THE ORDERING: three or more staged uploads never OUTSCORES exactly two', () => {
    // 🔴 THE PROPERTY THE RAMP GOT BACKWARDS, PINNED AS A COMPARISON RATHER THAN AS TWO VALUES.
    // WHY the old ordering was backwards — which population clusters where, and what the old
    // boundaries therefore weighted highest — is on `STAGED_ONE_AT` and is deliberately not
    // reproduced here. It was, for two rounds, and the two copies had already drifted apart on the
    // detail before anyone noticed; one argument, one place.
    //
    // 🔴 ASSERTED AS `>=`, DELIBERATELY, SO IT PINS THE ORDERING AND NOT ONE PARTICULAR CURE. A
    // plateau (3+ scoring the same as a pair) and a decline (3+ scoring less) both satisfy it, and
    // both are defensible shapes; what is NOT defensible is the direction, which is the thing that
    // was measured. A case asserting literal values here would go red on a later re-shaping that
    // kept the ordering intact, and would then be pinning an implementation rather than a finding.
    //
    // 🔴 NOT FULLY SHAPE-NEUTRAL, THOUGH, AND SAYING "IT IS" WOULD BE FALSE. The non-suppression
    // floor further down requires `at3 >= LONE_SIGNAL_CUT`, which rules out a decline to, say, 0.3 —
    // a shape that satisfies the ordering and keeps the arm scoring. That is deliberate rather than
    // an oversight: a 3+ arm scoring below the lone-signal cut is no longer independently reportable,
    // so an account carried by that arm alone leaves the board entirely. For an arm that still
    // carries genuine catches — it graded worse than the pair rung, not empty — that is suppression
    // by another route, and
    // the floor is where this case says so. A re-shape that genuinely intends it must move the floor
    // deliberately, which is the point of making it an assertion rather than an assumption.
    //
    // 🔴 AND READ THE `>=` COMPARISONS AS REGRESSION COVERAGE, NOT AS A STANDING INVARIANT. `at2` is
    // the ramp's ceiling at today's constants and `rampScore` clamps at 1, so `at2 >= at3` and the
    // loop below hold for every NON-DEGENERATE boundary pair with `oneAt <= 2` — a pair with
    // `zeroAt >= oneAt` satisfies that quantifier and throws instead, which is why the qualifier is
    // there. They were red at the pre-change
    // constants — which is what they exist to pin — but going forward the teeth are in the three
    // assertions after the loop, not in the comparisons. Do not "simplify" this case by deleting
    // them.
    const at2 = score(member(), stagedSignals(42, { count: 2, largestSameSecondBurst: 1 }));
    const at3 = score(member(), stagedSignals(42, { count: 3, largestSameSecondBurst: 1 }));
    expect(at2).toBeGreaterThanOrEqual(at3);

    // The claim is about the whole arm, not about its first member: `3+` is one population and a
    // ramp that merely delayed its rise by a step would satisfy the line above while still putting
    // its top rung on the wrong accounts. Counts pairwise distinct, and distinct from every
    // constant this case names.
    //
    // 🔴 FOUR SAMPLES RATHER THAN ONE, AND UNDER MONOTONICITY THAT WOULD BE THREE TOO MANY — the
    // largest count would subsume the rest. They earn their place because this case deliberately
    // admits a NON-MONOTONE re-shape (that is what the `>=` above is for), and under a decline the
    // binding count need not be the largest.
    for (const count of [4, 7, 11, 40]) {
      expect(
        score(member(), stagedSignals(42, { count, largestSameSecondBurst: 1 }))
      ).toBeLessThanOrEqual(at2);
    }

    // 🔴 AND NOT SATISFIABLE BY SUPPRESSION, WHICH IS THE CHEAP WAY TO PASS THE LINES ABOVE AND IS
    // THE WRONG FIX. The 3+ arm is worse than the pair arm; it is not empty, and zeroing it would
    // discard the genuine catches it still carries. So the arm must keep scoring, and keep scoring
    // enough to reach a moderator ON ITS OWN — the same `s >= LONE_SIGNAL_CUT` test the firing
    // point below is derived from, asserted here on the arm that must not be thrown away.
    expect(at3).toBeGreaterThan(0);
    // ⚠️ This line cannot fail for any plausible value of `LONE_SIGNAL_CUT` — `at3` is 1 today, so
    // any cut at or below 1 satisfies it. It is not a guard on the cut; it fires only on a re-shape
    // that declines the 3+ arm below it, which is the thing it is here for.
    expect(at3).toBeGreaterThanOrEqual(LONE_SIGNAL_CUT);

    // Nor by flattening the ramp into a constant: ONE staged upload is the commonest shape on the
    // site that matches this predicate at all, and it must still be worth nothing.
    expect(score(member(), stagedSignals(42, { count: 1, largestSameSecondBurst: 1 }))).toBe(0);
  });

  it('🔴 THE FIRING POINT: a LONE asset-staging signal is REPORTED at two staged uploads, not one', () => {
    // 🔴 THE PROPERTY THE BOUNDARY WAS DERIVED TO PRODUCE, PINNED END-TO-END RATHER THAN AS
    // ARITHMETIC. The constants above say what the ramp returns; they say nothing about whether the
    // account reaches a moderator, which is the thing that was actually decided. That answer is a
    // composition of four separate values — the ramp boundaries, the registry's SIZE, the blend's
    // whole-registry denominator, and `MIN_REPORTED_CONFIDENCE` — living in three files, and any
    // one of them moving silently breaks it. So this case runs the REAL registry through the REAL
    // blend and the REAL partition, and asserts the reported/suppressed verdict itself.
    //
    // The property it pins: a lone signal is reported exactly when `s >= LONE_SIGNAL_CUT`. The
    // algebra behind that, and the bound it puts on `oneAt`, are on `STAGED_ONE_AT` — this segment
    // had to edit BOTH copies of that derivation to make one change, which is the argument for
    // keeping it in one place. Here: a pair saturates at 1 and clears the cut, a single upload
    // scores 0 and does not.
    //
    // The member is built so every OTHER heuristic scores 0 — a common mail provider, no shared
    // address, no templated text, 7 images over 11 hours (0.64/hour, far under the velocity floor).
    // 🔴 ONE FIXTURE VALUE DOES COLLIDE WITH AN EXPECTED ONE — the same-second burst is 1, which is
    // also what the pair's sub-score now saturates to, and a mutant returning the raw burst tally
    // would satisfy that line. It is separated by the OTHER verdict rather than by the fixture: this
    // fixture also pins the burst tally at 1 for a count of ONE, where the expected sub-score is 0,
    // so that mutant fails on `verdict(1)`. (A tally of 0 beside a count of 1 IS buildable — a row
    // whose timestamp will not parse increments the count and is skipped by the burst fold — it is
    // simply not what this fixture supplies.) The staged COUNT of 1 also equals the expected
    // sub-score of 1 in `verdict(2)`; same separation, same reason. The remaining numbers are
    // pairwise distinct: 7 images against 0.25, 0.45 and 0.1125.
    const loner = () =>
      member({
        all: { images: 7 },
        createdAt: at('2026-09-03T01:00:00.000Z'),
        emailDomain: 'gmail.com',
      });
    const verdict = (count: number) => {
      const result = scoreAccount(
        BOT_ACCOUNT_HEURISTICS,
        evidence(loner(), stagedSignals(42, { count, largestSameSecondBurst: 1 }))
      );
      const staged = result.subScores.find((s) => s.id === 'asset-staging');
      return {
        staged: staged?.score,
        others: result.subScores.filter((s) => s.id !== 'asset-staging').map((s) => s.score),
        confidence: result.confidence,
        reported: partitionByConfidence([result], MIN_REPORTED_CONFIDENCE).reported.length,
      };
    };

    // ONE staged upload: the heuristic scores nothing, so nothing is reported.
    expect(verdict(1)).toEqual({ staged: 0, others: [0, 0, 0], confidence: 0, reported: 0 });

    // TWO: the sub-score clears the lone-signal cut on its own, and the account reaches the board.
    //
    // 🔴 THE VERDICT IS ASSERTED FIRST, DELIBERATELY. The sub-score and confidence numbers below
    // are the mechanism; `reported` is the decision, and it is the one a reader of a failure
    // message needs to see named. Against the pre-change boundaries this line reads
    // `expected 0 to be 1` — the defect itself — rather than a ramp value that has to be translated
    // back into what it meant for the account.
    const pair = verdict(2);
    expect(pair.reported).toBe(1);
    expect(pair.others).toEqual([0, 0, 0]);
    expect(pair.staged).toBe(1);
    expect(pair.staged as number).toBeGreaterThanOrEqual(LONE_SIGNAL_CUT);
    expect(pair.confidence).toBeCloseTo(0.25, 12);
    expect(pair.confidence).toBeGreaterThanOrEqual(MIN_REPORTED_CONFIDENCE);
    // 🔴 TWO OF THESE ASSERTIONS GOT SLACKER IN THE CHANGE THAT MOVED THE SUB-SCORE TO 1, AND THE
    // CASE'S OWN RATIONALE ABOVE ("any one of the four moving silently breaks it") IS WHY THAT IS
    // WORTH WRITING DOWN. The confidence is now 0.25, so the window of `MIN_REPORTED_CONFIDENCE`
    // values this case tolerates doubled from `(0, 0.125]` to `(0, 0.25]` — a mutant raising it to
    // 0.2 used to flip `reported` to 0 and now does not. And `pair.staged >= LONE_SIGNAL_CUT` is
    // satisfied by any cut at or below 1, so it can no longer fail for a plausible value. Both
    // constants are still pinned literally in `scoring.test.ts`, so neither mutant escapes the
    // suite; what changed is that THIS case stopped being the place they die.
  });

  it('starts at 0 below the volume boundary, saturates ON it, and stays there', () => {
    // Below the boundary, exactly ON it, one past it, then far past it — 1, 2, 3 and 11 against a
    // boundary of 2. The plateau is the shape the ORDERING case requires and this is its other half:
    // every count above the boundary scores the SAME as the boundary, rather than tailing off.
    //
    // 🔴 THE `count: 1` LINE IS WHAT MAKES THE TITLE TRUE, AND WITHOUT IT THE CASE IS BLIND. The
    // other three counts are all at or above `oneAt`, so all three of those assertions are the upper
    // clamp: a `score` that returned 1 for EVERY input would satisfy them, and the case could not
    // distinguish "saturates at 2" from "always 1". One count below the boundary separates them.
    //
    // LITERAL counts and LITERAL expected values. The mutants this separates, named rather than
    // assumed: `zeroAt` 1→0 puts a single upload at (1-0)/(2-0) = 0.5 instead of 0; `oneAt` 2→3 puts
    // a pair at 0.5 instead of 1, which is the inversion the ORDERING case above exists for;
    // `oneAt` 2→1 throws at `rampScore`'s own guard.
    //
    // (This case absorbed a separate `scores 0 for ONE staged upload and fires from two`, whose two
    // assertions had become a subset of the first two here — so no mutant could separate them, and
    // counting it as a second guard was counting the same coverage twice. Its rationale is not
    // reproduced here: the "commonest shape on the site" argument lives on `STAGED_ZERO_AT` and in
    // the ORDERING case, and the boundary derivation is on `STAGED_ONE_AT`. A below-boundary control
    // still appears in several other
    // cases in this file and in `run.test.ts`, each as that case's own negative control — moving
    // `STAGED_ZERO_AT` turns all of them red, deliberately. No count is given here: a ledger of them
    // went stale inside the change that wrote it.)
    //
    // 🔴 WHAT THE VOLUME HALF CANNOT SEE, SAID PLAINLY RATHER THAN LEFT TO BE ASSUMED FROM THE
    // GREEN: with `zeroAt = 1` and `oneAt = 2` there is NO INTEGER strictly between the two
    // boundaries, so no count reaches `rampScore`'s interpolation line THROUGH THIS CALL SITE —
    // both ends are clamps. A mutant of that arithmetic (dropping the `- zeroAt`, dividing by
    // `oneAt` rather than by the span) is therefore invisible through `score`. It is NOT invisible
    // through this heuristic: the BURST call site runs at (1, 3), a tally of 2 lands strictly
    // between, and the two assertions that read `assetStagingHalfScores(...).burst` at 0.5 go red on
    // exactly those mutants. The other three heuristics cover it as well.
    expect(score(member(), stagedSignals(42, { count: 1, largestSameSecondBurst: 1 }))).toBe(0);
    expect(score(member(), stagedSignals(42, { count: 2, largestSameSecondBurst: 1 }))).toBe(1);
    expect(score(member(), stagedSignals(42, { count: 3, largestSameSecondBurst: 1 }))).toBe(1);
    expect(score(member(), stagedSignals(42, { count: 11, largestSameSecondBurst: 1 }))).toBe(1);
  });

  it('🔴 the SCORE is identically the volume half — the burst arm cannot raise it', () => {
    // 🔴 THE HONEST REPLACEMENT FOR A CASE THAT USED TO ASSERT THE OPPOSITE. Long ago the burst
    // boundaries sat tighter than the volume ones (4 against 8) and a same-second pair genuinely
    // scored HIGHER than the same count spread out; a case here asserted exactly that. A
    // same-second group is a SUBSET of the staged rows, so `largestSameSecondBurst <= count`
    // always, and the volume ramp (1, 2) is at or above the burst ramp (1, 3) at every input, so a
    // monotonic ramp cannot turn the smaller input into the larger score. `max(volume, burst)` is
    // therefore identically `volume`: the burst arm changes neither whether this heuristic fires
    // nor how high it scores. Asserting a comparison it can no longer satisfy would be a guard
    // describing behaviour the code does not have.
    //
    // 🔴 THE LOOP BELOW IS VACUOUS ABOUT THE BURST RAMP — NOT MERELY ABOUT ITS BOUNDARIES — AND THE
    // TITLE WAS RENAMED BECAUSE OF IT. Every row of the table has `count >= 2`, so `volume` is 1 for
    // all five, and `rampScore` clamps at 1: `burst <= 1 === volume` therefore holds for any burst
    // implementation whose output STAYS IN [0, 1] — which is every boundary mutation `rampScore`
    // ACCEPTS, since it clamps those — including one that returned a constant 1. (Not for literally
    // any implementation: a burst half returning 2, or returning the raw same-second tally unramped,
    // does fail that line. The clamp is the hypothesis.) 🔴 "ACCEPTS" IS LOAD-BEARING AND AN EARLIER
    // WORDING OMITTED IT, SAYING "every boundary mutation": a DEGENERATE pair does not produce an
    // output in [0, 1] at all, it THROWS (`rampScore` guards `!(oneAt > zeroAt)`), so the loop goes
    // red rather than holding. That is the same false-absolute class the case two hundred lines up
    // retracts by name, and this file would have held two paragraphs disagreeing about it. The error
    // ran in the safe direction — it overstated the loop's vacuity, i.e. understated coverage — but
    // it was still wrong. This case used to double
    // as the guard that went red if the burst pair were tightened below the volume pair; it cannot
    // any more, because the volume half is now a STEP at two and is already saturated wherever the
    // burst half is non-zero.
    //
    // WHAT ACTUALLY GUARDS THE BURST PAIR, so nobody deletes it believing this loop has them
    // covered: the four literal pins in the CONSTANTS case (which kill a blind mutant of either
    // constant), the separate dominance case beside them (which catches a deliberate re-tune that
    // updates those literals), and `spread.burst` in the penultimate block of THIS case — 2 in one second on an
    // account with 5 staged is `rampScore(2, 1, 3) = 0.5`, and both `BURST_ZERO_AT -> 0` (0.666…)
    // and `BURST_ONE_AT -> 2` (1) fail it. That last one is the only burst-pair guard inside this
    // case, and it is the reason the case is not merely the `x <= x` its loop has become.
    //
    // 🔴 READ THAT LIST AS THE DESIGNATED GUARDS, NOT AS THE COMPLETE SET — it understates, which is
    // the safe direction, but a reader deciding what is safe to delete needs to know. Dropping
    // `BURST_ZERO_AT` below `STAGED_ZERO_AT` turns far more cases red than the three named, most of
    // them ordinary behavioural ones; the measured count is recorded once, on the `max` in
    // `staging.ts`, rather than copied here where it would go stale separately.
    //
    // What the loop pins is that `score` is not `burst` (a burst-half mutant fails it) and not a
    // sum (1.5 against 1). It does NOT by itself pin "not a constant": every row has `count >= 2`,
    // so `halves.volume` is 1 throughout and `score(...) === halves.volume` reduces to `1 === 1` —
    // `score: () => 1` walks the loop untouched. The below-boundary line AFTER it is what closes
    // that, the same control the two neighbouring cases carry.
    //
    // 🔴 AND NONE OF IT KEEPS THE `max` FROM BEING REWRITTEN TO A BARE `volume`, WHICH THIS COMMENT
    // USED TO CLAIM: that rewrite satisfies `score === volume` BY CONSTRUCTION, and it is recorded
    // on the `max` in `staging.ts` as a measured survivor of the whole suite. Nothing in this file
    // catches it, and saying otherwise here would be a coverage claim about the one mutation this
    // module is measured to miss.
    //
    // Every pair respects `burst <= count`, because a pair that does not is a state the evidence
    // layer cannot build and proves nothing about the shipped code.
    const realistic: Array<[number, number]> = [
      [2, 1],
      [2, 2],
      [5, 2],
      [9, 4],
      [11, 11],
    ];
    for (const [count, largestSameSecondBurst] of realistic) {
      const s = stagedSignals(42, { count, largestSameSecondBurst });
      const halves = assetStagingHalfScores(42, s);
      expect(halves.burst).toBeLessThanOrEqual(halves.volume);
      expect(score(member(), s)).toBe(halves.volume);
    }
    // 🔴 THE TWO VALUES ARE GENUINELY DIFFERENT HERE, AND THIS IS THE CASE'S BURST-PAIR ASSERTION.
    // The loop's FIRST line is `x <= x` five times over (see the note at the top); its second line
    // is a real assertion, and `spread.burst` is where a burst BOUNDARY is observable here.
    const spread = assetStagingHalfScores(
      42,
      stagedSignals(42, { count: 5, largestSameSecondBurst: 2 })
    );
    expect(spread.volume).toBe(1);
    expect(spread.burst).toBeCloseTo(0.5, 12);

    // 🔴 LAST, AND THE ORDER IS LOAD-BEARING. This is the negative control the loop cannot supply —
    // every row it iterates is at or above the boundary, so `score: () => 1` walks all of them; one
    // count below the boundary is what closes that. It sits AFTER the spread block deliberately:
    // placed before it, this line is the first to fail under `BURST_ZERO_AT -> 0` (a count of 1
    // scores `rampScore(1, 0, 3)` = 0.333 on the burst half), vitest aborts the case there, and
    // `spread.burst` — the assertion the comment above credits with catching that mutant — never
    // executes. That is the same unreachability the dominance case was split out to remove, and it
    // was introduced here by an earlier round's fix before being measured.
    expect(score(member(), stagedSignals(42, { count: 1, largestSameSecondBurst: 1 }))).toBe(0);
  });

  it('scores a burst of ONE as nothing — every upload shares its own second', () => {
    // 🔴 THE OFF-BY-ONE THAT WOULD MAKE THIS HALF FIRE ON EVERY MEMBER WITH ANY STAGED IMAGE. A
    // lone upload trivially has a largest-same-second group of 1, so reading `zeroAt` as "the
    // smallest value that fires" would give every staged upload a burst score and the half would
    // stop distinguishing anything — which matters for the `fired_burst` counter and the moderator
    // clause even now that the half cannot move the score.
    //
    // 🔴 ASSERTED ON THE HALF, NOT ON THE BLEND, BECAUSE THE BLEND CANNOT SEE THIS MUTANT AT THE
    // SHIPPED CONSTANTS. `max` is identically `volume` while the burst pair stays no steeper than
    // the volume pair, so a mutation of `BURST_ONE_AT` is invisible through `score`. It is NOT true
    // that no burst mutation is visible at all — dropping `BURST_ZERO_AT` below `STAGED_ZERO_AT`
    // breaks the dominance and does move the score — but that is the one BOUNDARY direction. Other
    // mutations of this half are visible through `score` too (replacing it with a constant 1 moves
    // 16 cases); the narrow claim is about its two boundaries, not about the half. Reading the half
    // directly is what makes this arm assertable without depending on any of that. (Measured before
    // two pairs met: moving
    // `BURST_ZERO_AT` to 0 made a burst of one score 0.25 while the volume half at a count of 3 was
    // already 0.2857, so the blended expectation passed at BOTH values of the constant.)
    const facts = stagedSignals(42, { count: 2, largestSameSecondBurst: 1 });
    expect(assetStagingHalfScores(42, facts).burst).toBe(0);
    // And the blend is then the volume half saturating at its boundary of two, and nothing else.
    expect(score(member(), facts)).toBe(1);
  });

  it('saturates the burst half at its own boundary', () => {
    // Asserted on the HALF for the reason above — the blend cannot express it. 4 in one second on
    // an account with 9 staged, so the fixture respects `burst <= count`.
    expect(
      assetStagingHalfScores(42, stagedSignals(42, { count: 9, largestSameSecondBurst: 4 })).burst
    ).toBe(1);
  });

  it('🔴 does NOT sum the two halves', () => {
    // A sum would double-count the same uploads — every burst member is also a count member — and
    // would make the sub-score stop meaning "how far past ordinary these uploads are". Still worth
    // pinning although `max` currently resolves to `volume`: the combination is what becomes wrong
    // first if the volume half ever stops being a step.
    //
    // 2 staged in one second saturates the volume half at 1 and puts the burst half at 0.5, so max
    // is 1 and a sum is 1.5 — above the clamp, so the sum mutant is visible in this function's own
    // return value before `scoreAccount` flattens it. A mutant returning the BURST half gives 0.5
    // and fails too.
    //
    // 🔴 THE TITLE SAYS "DOES NOT SUM" RATHER THAN "COMBINES WITH MAX" BECAUSE THE COMBINATION IS NO
    // LONGER OBSERVABLE HERE. At the previous boundaries both halves scored 0.5 on this fixture and
    // the expected 0.5 was a value neither `1` nor `0` could impersonate; now the expected value IS
    // the ceiling, so `score: () => 1` and `Math.max(volume, burst, 1)` both survive the FIRST line
    // below. The second — the `count: 1` control — is what kills them, measured: `return 1` fails it
    // with `expected 1 to be +0`. The mutant this case genuinely cannot see either way is one
    // returning the VOLUME half: semantically equivalent at these constants, and named as a known
    // survivor on the `max` in `staging.ts`.
    const both = stagedSignals(42, { count: 2, largestSameSecondBurst: 2 });
    expect(score(member(), both)).toBe(1);
    expect(score(member(), stagedSignals(42, { count: 1, largestSameSecondBurst: 1 }))).toBe(0);
  });

  it('scores an account with nothing staged 0, without throwing', () => {
    expect(score(member(), signalsWith({}))).toBe(0);
    expect(stagedImageFacts(42, signalsWith({}))).toEqual({
      count: 0,
      largestSameSecondBurst: 0,
    });
  });

  it('reads only its OWN member’s facts', () => {
    // The index is keyed by user, and a heuristic reading the wrong entry would score one account
    // on another's uploads. The fixture gives member 7 a maximal shape and member 42 nothing, so a
    // mutant reading "the first entry" or "any entry" scores 1 where this expects 0.
    const s = signalsWith({ staged: { 7: { count: 40, largestSameSecondBurst: 40 } } });
    expect(score(member({ userId: 42 }), s)).toBe(0);
    expect(score(member({ userId: 7 }), s)).toBe(1);
  });

  it('🔴 assetStagingHalfScores reports the halves separately — and one direction is now impossible', () => {
    // 🔴 WITHOUT THIS THE COUNTERS CANNOT SEE WHICH HALF FIRED, and a half that never fires on an
    // account the other did not already carry is a boundary doing nothing while looking like
    // evidence — the failure mode that kept a zero-firing comment source alive for five runs one
    // heuristic over. `run.ts` publishes `fired_volume` and `fired_burst` off this function, and
    // those two counters are now the ONLY product the burst arm has, so the decomposition matters
    // more than it did when the arm could also move the score.
    //
    // 🔴 THE ASYMMETRY IS THE HONEST PART. "Volume without burst" is a real and common state. Its
    // mirror — a burst half firing on an account whose volume half did not — was asserted here
    // until the boundaries met, and it is now UNREACHABLE for any index the evidence layer can
    // build: `burst <= count` and the volume ramp is at or above the burst ramp everywhere, so
    // `burst > 0` implies `volume >= burst > 0`. Asserting the old direction would have required a
    // fixture with more same-second rows than staged rows, which is not a state that exists. So the
    // reachable claim is stated instead: the two halves are separately readable, one can be zero
    // while the other is not, and the impossible direction is named rather than faked with an
    // invalid fixture.
    const volumeOnly = signalsWith({ staged: { 42: { count: 2, largestSameSecondBurst: 1 } } });
    expect(assetStagingHalfScores(42, volumeOnly).volume).toBe(1);
    expect(assetStagingHalfScores(42, volumeOnly).burst).toBe(0);

    // Both halves non-zero, read independently and NOT as two names for the max: 9 staged saturates
    // the volume half while a burst of 2 sits at the ramp's midpoint, so a mutant returning the max
    // under both names gives 1 for `burst` and fails here.
    const both = signalsWith({ staged: { 42: { count: 9, largestSameSecondBurst: 2 } } });
    expect(assetStagingHalfScores(42, both).volume).toBe(1);
    expect(assetStagingHalfScores(42, both).burst).toBeCloseTo(0.5, 12);

    // 🔴 AND A CONTROL ON `volume` ITSELF, WHICH THIS CASE LOST WHEN THE RAMP BECAME A STEP. Both
    // fixtures above now score 1 on the volume half — at the previous boundaries they were 0.5 and
    // 1, two distinct values, so a mutant returning a constant for `volume` died inside this case.
    // It no longer would. One fixture below the boundary restores the separation.
    const belowBoundary = signalsWith({ staged: { 42: { count: 1, largestSameSecondBurst: 1 } } });
    expect(assetStagingHalfScores(42, belowBoundary).volume).toBe(0);
    expect(assetStagingHalfScores(42, belowBoundary).burst).toBe(0);
  });

  it('🔴 explains itself with the numbers it used, and states the account’s image total', () => {
    // The ratio is what tells a moderator whether these uploads are ALL of the account's images or
    // a corner of them — the heuristic deliberately does not require "all" (the per-member cap makes
    // that test unreachable on exactly the busiest accounts), so the denominator is disclosed rather
    // than folded into the score.
    const m = member({ all: { images: 12 } });
    const note = assetStagingHeuristic.explain(
      evidence(m, stagedSignals(42, { count: 9, largestSameSecondBurst: 4 })),
      1
    );
    expect(note).toContain('9 of this account');
    expect(note).toContain('12 uploaded images');
    expect(note).toContain('no generation metadata');
    expect(note).toContain('4 of them were created within the same second');
  });

  it('🔴 omits the same-second clause when the burst half did not fire', () => {
    // The reason clause and the score read ONE predicate. A note claiming a burst on an account
    // whose burst half scored nothing would send a moderator looking for a batch that is not there
    // — the defect `domainClusterIsNamedInReason` exists one heuristic over to prevent.
    const note = assetStagingHeuristic.explain(
      evidence(member(), stagedSignals(42, { count: 4, largestSameSecondBurst: 1 })),
      0.42
    );
    expect(note).toContain('4 of this account');
    expect(note).not.toContain('same second');
  });

  it('says nothing at zero, rather than reciting a signal that did not fire', () => {
    expect(assetStagingHeuristic.explain(evidence(member(), signalsWith({})), 0)).toBeNull();
  });

  it('🔴 needs no OTHER account to exist — the property no ring heuristic has', () => {
    // Stated as a test because it is the reason this heuristic was added: the cohort-level indexes
    // are entirely empty here (no IPs, no domains, no fingerprints), which is the state every ring
    // heuristic scores 0 in, and this one still fires.
    const alone = signalsWith({ staged: { 42: { count: 8, largestSameSecondBurst: 1 } } });
    expect(alone.membersPerIp.size).toBe(0);
    expect(alone.membersPerFingerprint.size).toBe(0);
    expect(score(member(), alone)).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// The registry, blended
// ---------------------------------------------------------------------------------------------

describe('the four heuristics together', () => {
  it('score independently — one firing does not move the others', () => {
    // The operator chose shadow mode to grade each signal ON ITS OWN, so this is the property that
    // matters most: a wave-shaped account with no ring evidence must show velocity alone.
    const wave = member({ all: { images: 40 }, createdAt: at('2026-09-03T11:40:00.000Z') });
    const result = scoreAccount(BOT_ACCOUNT_HEURISTICS, evidence(wave));
    expect(result.subScores.map((s) => [s.id, s.score])).toEqual([
      ['posting-velocity', 1],
      ['registration-cluster', 0],
      ['content-templating', 0],
      ['asset-staging', 0],
    ]);
    // One of FOUR equally weighted heuristics fully convinced blends to a quarter — which is above
    // the reporting threshold, and is the arithmetic that threshold was chosen against. It was a
    // third before `asset-staging` was registered; the same account, unchanged, now blends lower,
    // which is the denominator effect the threshold was re-derived for.
    expect(result.confidence).toBeCloseTo(1 / 4, 12);
  });

  it('an ordinary new account scores 0 on all four', () => {
    // The population this detector must NOT report: a real newcomer, a common mail provider, no
    // shared IP, no templated text.
    const ordinary = member({
      all: { images: 2, comments: 1 },
      createdAt: at('2026-09-03T01:00:00.000Z'),
      emailDomain: 'gmail.com',
    });
    const result = scoreAccount(BOT_ACCOUNT_HEURISTICS, evidence(ordinary));
    expect(result.subScores.every((s) => s.score === 0)).toBe(true);
    expect(result.confidence).toBe(0);
  });

  it('a coordinated ring member scores on the two ring heuristics without any velocity', () => {
    // 🔴 THE CASE PER-ACCOUNT SCORING MISSES ENTIRELY. Three posts over eleven hours is nothing;
    // this account is only visible because of who it registered and posted ALONGSIDE.
    const quiet = member({
      all: { comments: 3 },
      createdAt: at('2026-09-03T01:00:00.000Z'),
      emailDomain: 'ring.test',
    });
    const s = signalsWith({
      ips: { 42: ['x'] },
      membersPerIp: { x: IP_ONE_AT + 3 },
      membersPerDomain: { 'ring.test': DOMAIN_ONE_AT + 3 },
      fingerprints: { 42: ['buy nummask credits at linkmask right now'] },
      membersPerFingerprint: { 'buy nummask credits at linkmask right now': CLUSTER_ONE_AT + 2 },
      sources: { registrationIps: true },
    });
    const result = scoreAccount(BOT_ACCOUNT_HEURISTICS, evidence(quiet, s));
    expect(result.subScores.map((x) => [x.id, x.score])).toEqual([
      ['posting-velocity', 0],
      ['registration-cluster', 1],
      ['content-templating', 1],
      ['asset-staging', 0],
    ]);
    expect(result.confidence).toBeCloseTo(2 / 4, 12);
  });

  it('🔴 a LONE stager scores on asset-staging alone — the shape no ring heuristic can see', () => {
    // 🔴 THE CASE THE REGISTRY HAD NO ANSWER TO BEFORE THIS HEURISTIC. Every other entry asks "how
    // many OTHER new accounts share this", so one account working by itself is invisible to all
    // three: nothing is shared, so nothing clusters. This member posts slowly, registered on a
    // common provider, shares no address and templated nothing — and it has staged nine uploads
    // with five of them inside one second.
    const loner = member({
      all: { images: 9 },
      createdAt: at('2026-09-03T01:00:00.000Z'),
      emailDomain: 'gmail.com',
    });
    const s = stagedSignals(42, { count: 9, largestSameSecondBurst: 5 });
    const result = scoreAccount(BOT_ACCOUNT_HEURISTICS, evidence(loner, s));
    expect(result.subScores.map((x) => [x.id, x.score])).toEqual([
      ['posting-velocity', 0],
      ['registration-cluster', 0],
      ['content-templating', 0],
      ['asset-staging', 1],
    ]);
    // One of four, fully convinced — above the reporting threshold on its own.
    expect(result.confidence).toBeCloseTo(1 / 4, 12);
  });
});

// ---------------------------------------------------------------------------------------------
// The cluster key the board rules on
// ---------------------------------------------------------------------------------------------

describe('registrationClusterGroupKey', () => {
  const key = (m: BotAccountCohortMember, s: CohortSignals) => registrationClusterGroupKey(m, s);
  const explain = (m: BotAccountCohortMember, s: CohortSignals) =>
    registrationClusterHeuristic.explain?.(
      evidence(m, s),
      registrationClusterHeuristic.score(evidence(m, s))
    ) ?? null;

  it('names the shared domain once the cluster is big enough to be reported', () => {
    // LITERAL size, so this is a statement about behaviour at four rather than about whatever
    // `DOMAIN_ZERO_AT` happens to say — the constant is pinned separately above.
    const s = signalsWith({ membersPerDomain: { 'ring.test': 4 } });
    expect(key(member({ emailDomain: 'ring.test' }), s)).toBe('domain:ring.test');
  });

  it('returns nothing AT the boundary — a cluster of three is not reported, so it is not a key', () => {
    // 🔴 THE OFF-BY-ONE. `DOMAIN_ZERO_AT` is the largest cluster still worth nothing, so three is
    // silent and four speaks. A `>` → `>=` mutant groups every three-account coincidence into one
    // ruling, and publishes a domain the reason never mentions.
    const s = signalsWith({ membersPerDomain: { 'ring.test': 3 } });
    expect(key(member({ emailDomain: 'ring.test' }), s)).toBeNull();
  });

  it.each([
    ['an account whose domain nobody else shares', { 'ring.test': 1 }],
    ['a domain absent from the index entirely', {}],
  ])('returns nothing for %s', (_label, membersPerDomain) => {
    expect(key(member({ emailDomain: 'ring.test' }), signalsWith({ membersPerDomain }))).toBeNull();
  });

  it('returns nothing for an account with no email domain at all', () => {
    expect(key(member({ emailDomain: null }), signalsWith({ membersPerDomain: {} }))).toBeNull();
  });

  it('🔴 returns nothing for a COMMON provider, however large the cluster', () => {
    // `gmail.com` is the largest cluster in every cohort, every day. Keying on it would collapse the
    // day's most ordinary accounts into ONE ruling — a single click recording a verdict about
    // hundreds of unrelated people.
    const s = signalsWith({ membersPerDomain: { 'gmail.com': 250 } });
    expect(key(member({ emailDomain: 'gmail.com' }), s)).toBeNull();
  });

  it('is IDENTICAL for every member of one cluster, and different across clusters', () => {
    // Stability within a run is what makes one ruling cover the ring: two members deriving two
    // strings would be two decisions wearing one name.
    const s = signalsWith({ membersPerDomain: { 'ring.test': 9, 'other.test': 9 } });
    const a = key(member({ userId: 1, emailDomain: 'ring.test' }), s);
    const b = key(member({ userId: 2, emailDomain: 'ring.test' }), s);
    const c = key(member({ userId: 3, emailDomain: 'other.test' }), s);
    expect(a).toBe('domain:ring.test');
    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });

  it('🔴 NEVER carries a domain the reason text does not already name — swept, both directions', () => {
    // THE DISCLOSURE RULE. The board has a wider audience than the investigative tools, and a key is
    // rendered. A key naming a domain the finding's own reason never mentions would be a disclosure
    // the finding does not otherwise make — so the two must move together at EVERY size, not just at
    // the one a single case happens to pick.
    for (const size of [0, 1, 2, 3, 4, 5, 9, 15, 40]) {
      const s = signalsWith({ membersPerDomain: { 'ring.test': size } });
      const m = member({ emailDomain: 'ring.test' });
      const named = (explain(m, s) ?? '').includes('ring.test');
      expect(key(m, s) === null, `size ${size}: key present but domain unnamed in the reason`).toBe(
        !named
      );
    }
  });

  it('the sweep above is not vacuous — the reason DOES name the domain at a reportable size', () => {
    // 🔴 POSITIVE CONTROL. An `explain` that returned null at every size would satisfy the iff above
    // by making both halves false forever, and it would read as coverage.
    const s = signalsWith({ membersPerDomain: { 'ring.test': 9 } });
    const m = member({ emailDomain: 'ring.test' });
    expect(explain(m, s)).toContain('ring.test');
    expect(key(m, s)).toBe('domain:ring.test');
  });

  it('🔴 never carries a registration IP, which the reason deliberately withholds', () => {
    // The IP is the STRONGER signal and is left out of the reason on purpose — `explain` says so and
    // points a moderator at the tool built for that lookup. Keying on it would publish, on the
    // board, the one fact this heuristic goes out of its way not to publish.
    const s = signalsWith({
      ips: { 42: ['203.0.113.9'] },
      membersPerIp: { '203.0.113.9': 40 },
      membersPerDomain: {},
      sources: { registrationIps: true },
    });
    const m = member({ emailDomain: null });
    expect(registrationClusterHeuristic.score(evidence(m, s))).toBeGreaterThan(0);
    expect(key(m, s)).toBeNull();
  });
});

describe('domainClusterIsNamedInReason', () => {
  it('is the one predicate both the reason clause and the key read', () => {
    // Literal boundary, pinned here so a mutation to it fails with its own name attached rather than
    // only as a knock-on somewhere else.
    expect(domainClusterIsNamedInReason(3)).toBe(false);
    expect(domainClusterIsNamedInReason(4)).toBe(true);
    expect(domainClusterIsNamedInReason(0)).toBe(false);
  });
});
