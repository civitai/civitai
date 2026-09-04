import type { BotAccountHeuristic } from '../scoring';
import { rampScore } from './ramp';

/**
 * HEURISTIC 2 — do these accounts look like ONE actor.
 *
 * Adapted from `apps/moderator/src/lib/server/bulk-ban.service.ts`, which is the moderator-facing
 * version of this question: `getRegistrationIps` groups a set of accounts by the IP they registered
 * from, `getEmailDomains` groups them by email domain, and `getAccountsOnIps` grows a ring from one
 * account outwards. What carries over, and what changes:
 *
 *  - CARRIED OVER, and it is the load-bearing choice: REGISTRATION IPs ONLY. That service says why —
 *    a shared LOGIN ip is weak evidence, because mobile carriers and offices put thousands of
 *    unrelated people behind one address, while a shared REGISTRATION ip across many accounts is the
 *    ban-evasion signal. Widening this to logins would flood the board.
 *  - CARRIED OVER: a disposable-domain ring shows up as one domain with a high count.
 *  - INVERTED: that service is INVESTIGATIVE — a moderator supplies the accounts and it counts them.
 *    Nothing supplies accounts here, so the population is the cohort itself, and "how many accounts
 *    share this" means "how many of the day's new posting accounts share this". That is a much
 *    narrower denominator than the whole user table, which is what makes an unbounded count usable
 *    as a score without a base rate to divide by.
 *
 * 🔴 THIS IS THE ONLY HEURISTIC OF THE THREE THAT CAN SEE A COORDINATED RING, and it is also the
 * only one that can go dark. Its IP half needs ClickHouse, which is `undefined` on any deployment
 * without `CLICKHOUSE_HOST`. When that happens the heuristic does NOT silently score 0 — a zero from
 * a missing source is indistinguishable from a zero meaning "these accounts share nothing", and the
 * two call for opposite conclusions. `CohortSignals.sources.registrationIps` carries the state, the
 * note below says which halves actually ran, and `run.ts` publishes it as a counter so a grading
 * pass can throw the affected runs out rather than average them in.
 *
 * 🔴 THE TWO HALVES ARE COMBINED WITH `max`, NOT A SUM. An account caught by both is not twice as
 * suspicious as one caught by either; more importantly, summing would make the heuristic's own
 * sub-score uninterpretable — the number in the reason string could no longer be read as "the size
 * of the ring this account is in". Keeping it a max means the sub-score always means one thing, and
 * the note names which half produced it.
 */

export const REGISTRATION_CLUSTER_ID = 'registration-cluster';

/**
 * The largest cluster still worth nothing, and the size at which the heuristic is convinced.
 *
 * Separate boundaries for IPs and domains because the two have different innocent explanations at
 * the same size. Two accounts on one IP is a household or a phone; two on one domain is a coincidence
 * among however many domains a day's signups use. But a domain is a far weaker signal than an IP at
 * every size — one is "these were created from the same machine", the other is "these use the same
 * mail provider" — so the domain boundaries sit higher and its ramp is longer.
 *
 * 🔴 NAT IS THE KNOWN FALSE-POSITIVE, and no threshold removes it. `bulk-ban.service.ts` warns that
 * a carrier-NAT address can carry thousands of unrelated registrations, and nothing here can tell
 * that apart from a ring. Two things hold it down and neither is a fix: the population is only the
 * day's new accounts THAT POSTED, which is a small fraction of registrations behind any NAT, and the
 * ramp does not reach 1 until ten of them. It is a real limitation and the shadow phase is where its
 * rate gets measured.
 */
export const IP_ZERO_AT = 2;
export const IP_ONE_AT = 10;
export const DOMAIN_ZERO_AT = 3;
export const DOMAIN_ONE_AT = 15;

/**
 * Mail providers whose domain carries no signal at any cluster size.
 *
 * 🔴 WITHOUT THIS LIST THE DOMAIN HALF IS WORSE THAN USELESS — IT IS ANTI-CORRELATED. Most of any
 * day's genuine signups use a handful of free providers, so `gmail.com` is the largest cluster in
 * every cohort by a wide margin, every day, and a heuristic that scores cluster size would hand the
 * board the day's most ordinary accounts with maximum confidence while a ten-account disposable-domain
 * ring scored lower. This is the exact "fires on 90% of accounts" failure the scoring seam was built
 * to expose, and here it is foreseeable rather than something to discover in shadow.
 *
 * 🔴 IT IS A HARDCODED LIST AND THEREFORE BRITTLE, WHICH IS THE HONEST COST. The principled version
 * is a base rate — how over-represented is this domain against its ordinary share of signups — and
 * that needs a historical query this change does not make. A list has two failure modes worth
 * stating: a provider missing from it produces a standing false positive that looks exactly like a
 * ring, and a provider ON it hides a real ring that happened to use it. `domains_suppressed_common`
 * in the run counters is what makes the first measurable; nothing measures the second.
 *
 * Deliberately SHORT. Every entry is a domain that hides real rings, so the list earns its length
 * only where the provider is common enough that its cluster would dominate anyway.
 */
export const COMMON_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.uk',
  'hotmail.com',
  'hotmail.co.uk',
  'outlook.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'gmx.de',
  'mail.com',
  'mail.ru',
  'yandex.ru',
  'qq.com',
  '163.com',
  '126.com',
  'naver.com',
]);

/** Whether a domain is one whose cluster size means nothing. */
export const isCommonEmailDomain = (domain: string): boolean =>
  COMMON_EMAIL_DOMAINS.has(domain.toLowerCase());

/** The largest number of cohort members sharing any one of this account's registration IPs,
 *  including the account itself. `0` when nothing is known. */
export function largestIpCluster(
  userId: number,
  signals: { ipsByUser: Map<number, string[]>; membersPerIp: Map<string, number> }
): { size: number; ip: string | null } {
  let best = { size: 0, ip: null as string | null };
  for (const ip of signals.ipsByUser.get(userId) ?? []) {
    const size = signals.membersPerIp.get(ip) ?? 0;
    if (size > best.size) best = { size, ip };
  }
  return best;
}

/** The number of cohort members sharing this account's email domain — `0` for a common provider,
 *  which is the encoding that keeps a suppressed domain from ever scoring. */
export function domainClusterSize(
  emailDomain: string | null,
  membersPerDomain: Map<string, number>
): number {
  if (!emailDomain || isCommonEmailDomain(emailDomain)) return 0;
  return membersPerDomain.get(emailDomain) ?? 0;
}

export const registrationClusterHeuristic: BotAccountHeuristic = {
  id: REGISTRATION_CLUSTER_ID,
  description:
    'How many OTHER new posting accounts share this account’s registration IP or its (uncommon) ' +
    'email domain. The only heuristic here that can see a coordinated ring; needs ClickHouse for ' +
    'its IP half and says so when that is missing.',
  weight: 1,
  score: ({ member, signals }) => {
    const ip = largestIpCluster(member.userId, signals);
    const domain = domainClusterSize(member.emailDomain, signals.membersPerDomain);
    return Math.max(
      rampScore(ip.size, IP_ZERO_AT, IP_ONE_AT),
      rampScore(domain, DOMAIN_ZERO_AT, DOMAIN_ONE_AT)
    );
  },
  explain: ({ member, signals }, score) => {
    if (score <= 0) return null;
    const ip = largestIpCluster(member.userId, signals);
    const domain = domainClusterSize(member.emailDomain, signals.membersPerDomain);
    const clauses: string[] = [];
    // The IP itself is NOT quoted into the reason. A moderator who needs it has
    // `getAccountsOnIps` — the tool built for exactly that lookup, with the paging and the
    // already-banned marking this sentence cannot carry — and the abuse board is a wider audience
    // than that tool.
    if (ip.size > IP_ZERO_AT)
      clauses.push(`${ip.size} new posting accounts share its registration IP`);
    if (domain > DOMAIN_ZERO_AT)
      clauses.push(
        `${domain} share its email domain ${member.emailDomain ?? ''} (not a common provider)`
      );
    if (!signals.sources.registrationIps)
      clauses.push('registration-IP data was UNAVAILABLE this run — domain half only');
    return clauses.length ? clauses.join('; ') : null;
  },
};
