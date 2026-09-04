import { describe, expect, it } from 'vitest';
import type { BotAccountCohortMember, SurfaceCounts } from '../cohort';
import { emptyCohortSignals, type CohortSignals } from '../evidence';
import { BOT_ACCOUNT_HEURISTICS } from '../heuristics';
import {
  COMMON_EMAIL_DOMAINS,
  DOMAIN_ONE_AT,
  DOMAIN_ZERO_AT,
  IP_ONE_AT,
  IP_ZERO_AT,
  domainClusterSize,
  isCommonEmailDomain,
  largestIpCluster,
  registrationClusterHeuristic,
} from '../heuristics/clustering';
import { rampScore } from '../heuristics/ramp';
import {
  CLUSTER_ONE_AT,
  CLUSTER_ZERO_AT,
  contentTemplatingHeuristic,
  largestContentCluster,
} from '../heuristics/similarity';
import {
  MIN_AGE_HOURS,
  MIN_ITEMS,
  ONE_AT_PER_HOUR,
  ZERO_AT_PER_HOUR,
  effectiveAgeHours,
  itemsPerHour,
  postingVelocityHeuristic,
} from '../heuristics/velocity';
import { scoreAccount, type BotAccountEvidence } from '../scoring';

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
  sources?: Partial<CohortSignals['sources']>;
}): CohortSignals {
  const s = emptyCohortSignals();
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
    expect(note).toContain('40 item(s)');
    expect(note).toContain('/hour');
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

  it('🔴 quotes the shared text so a moderator can confirm or dismiss it', () => {
    // The whole reason this is exact-match-after-masking rather than a distance measure: the
    // finding has to be checkable at a glance. The QUOTED form is the normalised one — what was
    // actually compared — so a reader is not shown a different string from the one that scored.
    const s = signalsWith({
      fingerprints: { 42: ['check out my page at linkmask for nummask free credits'] },
      membersPerFingerprint: { 'check out my page at linkmask for nummask free credits': 6 },
    });
    const note = contentTemplatingHeuristic.explain(evidence(member(), s), 0.5);
    expect(note).toContain('6 new accounts posted the same text');
    expect(note).toContain('check out my page at linkmask');
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
// The registry, blended
// ---------------------------------------------------------------------------------------------

describe('the three heuristics together', () => {
  it('score independently — one firing does not move the others', () => {
    // The operator chose shadow mode to grade each signal ON ITS OWN, so this is the property that
    // matters most: a wave-shaped account with no ring evidence must show velocity alone.
    const wave = member({ all: { images: 40 }, createdAt: at('2026-09-03T11:40:00.000Z') });
    const result = scoreAccount(BOT_ACCOUNT_HEURISTICS, evidence(wave));
    expect(result.subScores.map((s) => [s.id, s.score])).toEqual([
      ['posting-velocity', 1],
      ['registration-cluster', 0],
      ['content-templating', 0],
    ]);
    // One of three equally weighted heuristics fully convinced blends to a third — which is above
    // the reporting threshold, and is the arithmetic that threshold was chosen against.
    expect(result.confidence).toBeCloseTo(1 / 3, 12);
  });

  it('an ordinary new account scores 0 on all three', () => {
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
    ]);
    expect(result.confidence).toBeCloseTo(2 / 3, 12);
  });
});
