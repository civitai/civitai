import dns from 'dns/promises';
import { createLruCache } from '~/server/utils/lru-cache';

/**
 * Domains resolve to the same answer for every user and change on the order of days, so a short
 * pod-local TTL is the whole cache story — a burst of signups from one ring hits DNS once.
 */
const mxCache = createLruCache<string, { deliverable: boolean }>({
  name: 'email-domain-mx',
  ttl: 10 * 60 * 1000,
  max: 5000,
  keyFn: (domain) => domain,
  fetchFn: async (domain) => ({ deliverable: await resolveDeliverable(domain) }),
});

/**
 * 🔴 FAIL OPEN on anything that is not a definitive "this domain has no mail exchanger".
 *
 * `ENOTFOUND` (no such domain) and `ENODATA` (domain exists, no MX record) are answers. Everything
 * else — SERVFAIL, timeouts, a resolver that is briefly unreachable — is the absence of an answer,
 * and treating it as a rejection turns a DNS blip into "nobody can set an email address".
 */
async function resolveDeliverable(domain: string) {
  try {
    const records = await dns.resolveMx(domain);
    return records.length > 0;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return code !== 'ENOTFOUND' && code !== 'ENODATA';
  }
}

/**
 * Does this domain publish an MX record? Deliberately NOT satisfied by an A record: an implicit-MX
 * fallback is legal but in practice a domain with an A record and no MX is a parked squat, which is
 * how the burner ring's addresses look (`ehotmail.com` resolves, accepts no mail).
 *
 * Measured against production 2026-08-26, users created since Aug 19 with no ban: of the top 400
 * domains (56,462 users) this rejects 2 domains / 6 users (0.011%); of a random 400 domains seen
 * once or twice (428 users) it rejects 9 domains / 9 users (2.10%), of which 6 are disposable or
 * typo'd. Requiring MX is the part that generalizes — an invented domain cannot be on a blocklist.
 */
export async function domainAcceptsMail(domain: string) {
  if (!domain) return false;
  const { deliverable } = await mxCache.fetch(domain.toLowerCase());
  return deliverable;
}
