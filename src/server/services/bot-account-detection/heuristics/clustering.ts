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
 * 🔴 WHAT A WORD LIST STRUCTURALLY CANNOT DO, stated here because the length below invites the
 * opposite reading. Extending it is a PATCH, not a fix, and no amount of extending changes any of
 * these three:
 *
 *   1. IT IS WALKABLE IN ONE KEYSTROKE, and the evasion is to register the ring on `gmail.com`.
 *      A domain on this list scores 0 by construction, so the list is a map of where a ring should
 *      go. The domain half is therefore a signal against the CARELESS only, and the IP half is what
 *      carries the heuristic against anyone who has read this file.
 *   2. EVERY OMISSION IS A STANDING FALSE POSITIVE, and they do not fall evenly. The omissions are
 *      whatever the author did not think of, and an English-speaking author does not think of
 *      `hotmail.fr`, `libero.it`, `uol.com.br`, `daum.net` or `foxmail.com` — so the false positives
 *      land systematically on people who do not write in English. Nine new posting accounts a day on
 *      one country's ordinary free provider is not a ring; before this list was widened it scored
 *      like one. The list can only ever be as complete as the last person to look at it.
 *   3. A DOMAIN ON IT HIDES A REAL RING THAT USED IT, and nothing measures that.
 *      `domains_suppressed_common` in the run counters (see `run.ts`) is how many members had their
 *      domain suppressed this way — it makes the SIZE of that blind spot visible, which is the most
 *      the shadow phase can do; it cannot say how many of those members were a ring.
 *
 * The principled version is a BASE RATE — how over-represented is this domain against its ordinary
 * share of signups — which needs a historical query this change does not make and which removes
 * failure modes 1 and 2 outright. That is the fix; this is the patch, and it is labelled as one.
 *
 * Grouped by provider family rather than alphabetically, because the way an entry goes missing is
 * that someone adds `hotmail.fr` and does not think about `hotmail.be`.
 */
export const COMMON_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  // Google
  'gmail.com',
  'googlemail.com',
  // Microsoft — the country variants are the single largest omission class, because the .com is
  // obvious and the rest are only obvious to whoever uses them.
  'hotmail.com',
  'hotmail.co.uk',
  'hotmail.fr',
  'hotmail.de',
  'hotmail.es',
  'hotmail.it',
  'hotmail.be',
  'hotmail.nl',
  'hotmail.com.br',
  'hotmail.com.ar',
  'hotmail.gr',
  'hotmail.se',
  'outlook.com',
  'outlook.fr',
  'outlook.de',
  'outlook.es',
  'outlook.it',
  'outlook.com.br',
  'live.com',
  'live.co.uk',
  'live.fr',
  'live.de',
  'live.it',
  'live.nl',
  'live.se',
  'live.ca',
  'live.com.au',
  'msn.com',
  // Yahoo and its acquisitions
  'yahoo.com',
  'yahoo.co.uk',
  'yahoo.fr',
  'yahoo.de',
  'yahoo.es',
  'yahoo.it',
  'yahoo.ca',
  'yahoo.co.jp',
  'yahoo.co.in',
  'yahoo.com.br',
  'yahoo.com.mx',
  'yahoo.com.ar',
  'yahoo.com.au',
  'ymail.com',
  'rocketmail.com',
  'aol.com',
  'aol.co.uk',
  // Apple
  'icloud.com',
  'me.com',
  'mac.com',
  // Proton. 🔴 `pm.me` is Proton's own short alias domain, offered to every paid account — it is as
  // ordinary as `proton.me` and was the sharpest omission on the original list.
  'proton.me',
  'protonmail.com',
  'protonmail.ch',
  'pm.me',
  // Germany / Austria / Switzerland
  'gmx.com',
  'gmx.de',
  'gmx.net',
  'gmx.at',
  'gmx.ch',
  'web.de',
  't-online.de',
  'freenet.de',
  'bluewin.ch',
  // France
  'free.fr',
  'orange.fr',
  'wanadoo.fr',
  'laposte.net',
  'sfr.fr',
  'bbox.fr',
  // Italy
  'libero.it',
  'virgilio.it',
  'alice.it',
  'tiscali.it',
  // Iberia and Latin America
  'terra.com.br',
  'uol.com.br',
  'bol.com.br',
  'globo.com',
  'prodigy.net.mx',
  // Russia, Ukraine and the CIS
  'mail.ru',
  'inbox.ru',
  'list.ru',
  'bk.ru',
  'internet.ru',
  'yandex.ru',
  'yandex.com',
  'yandex.by',
  'yandex.kz',
  'ya.ru',
  'rambler.ru',
  'ukr.net',
  // Central and eastern Europe
  'seznam.cz',
  'wp.pl',
  'o2.pl',
  'onet.pl',
  'interia.pl',
  'abv.bg',
  'mynet.com',
  // China
  'qq.com',
  'foxmail.com',
  '163.com',
  '126.com',
  'sina.com',
  'sina.cn',
  'sohu.com',
  '139.com',
  '189.cn',
  // Korea and Japan
  'naver.com',
  'daum.net',
  'hanmail.net',
  'nate.com',
  'docomo.ne.jp',
  'ezweb.ne.jp',
  // India
  'rediffmail.com',
  // Generic and privacy-first providers
  'mail.com',
  'email.com',
  'usa.com',
  'zoho.com',
  'fastmail.com',
  'tutanota.com',
  'tuta.io',
  'hushmail.com',
  'gmx.us',
  // Consumer ISPs — an ISP address is as ordinary as a webmail one and clusters the same way
  'comcast.net',
  'verizon.net',
  'att.net',
  'sbcglobal.net',
  'cox.net',
  'charter.net',
  'bellsouth.net',
  'btinternet.com',
  'sky.com',
  'virginmedia.com',
  'talktalk.net',
  'bigpond.com',
  'optusnet.com.au',
  'shaw.ca',
  'rogers.com',
  'telus.net',
  'sympatico.ca',
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
