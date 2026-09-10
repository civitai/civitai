import { vi, describe, it, expect, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * 🔴 The MX half of this guard is deliberate and is NOT redundant with the blocklist.
 *
 * The blocklist covers ~8,500 KNOWN disposable providers — real domains that accept mail. It cannot
 * cover an INVENTED domain, and the burner ring measured on 2026-08-26 was typing invented ones
 * (`gof33etchbitch.ccc`, `eh8798wit.com`) into the onboarding email field, which is free text and is
 * never verified. Five of the eight domains their banned accounts used resolve to NXDOMAIN.
 *
 * If you are here to simplify this to "the blocklist already covers it", it does not, and removing
 * the MX check reopens the door. The fail-open case below is equally deliberate: a resolver blip
 * must not stop everyone from setting an email address.
 */

const resolveMx = vi.hoisted(() => vi.fn());
vi.mock('dns/promises', () => ({ default: { resolveMx }, resolveMx }));

import { assertEmailAllowed, matchesBlockedSuffix } from '../blocklist.service';
import { BlocklistType } from '~/server/common/enums';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const redisGet = redisMock.redis.get;

/**
 * Keyed by the Redis key, not a single payload for every read. `assertEmailAllowed` reads TWO
 * lists now, and a mock that answers both with the same array makes the exact list behave like a
 * suffix list — under which "matches the WHOLE domain, not a substring of it" below passes for the
 * wrong reason, or fails for one. The two lists are separate rows in production and have to be
 * separate here.
 */
let blockedDomains: string[] = [];
let blockedSuffixes: string[] = [];

function installBlocklistReads() {
  redisGet.mockImplementation(async (key: string) => {
    // `:EmailDomain` is a PREFIX of `:EmailDomainSuffix`, so the suffix key must be tested first.
    const isSuffix = key.endsWith(`:${BlocklistType.EmailDomainSuffix}`);
    return JSON.stringify({
      type: isSuffix ? BlocklistType.EmailDomainSuffix : BlocklistType.EmailDomain,
      data: isSuffix ? blockedSuffixes : blockedDomains,
    });
  });
}

function setBlockedDomains(domains: string[]) {
  blockedDomains = domains;
  installBlocklistReads();
}

function setBlockedSuffixes(suffixes: string[]) {
  blockedSuffixes = suffixes;
  installBlocklistReads();
}

function dnsError(code: string) {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

async function reject(email: string) {
  let caught: unknown;
  try {
    await assertEmailAllowed(email);
  } catch (e) {
    caught = e;
  }
  return caught;
}

describe('assertEmailAllowed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setBlockedDomains([]);
    setBlockedSuffixes([]);
    resolveMx.mockResolvedValue([{ exchange: 'mx.example.com', priority: 10 }]);
  });

  it('allows a normal address on a domain with MX records', async () => {
    await expect(assertEmailAllowed('someone@allowed-normal.test')).resolves.toBeUndefined();
  });

  it('rejects a blocklisted domain as BAD_REQUEST, not a 500', async () => {
    setBlockedDomains(['blocked-basic.test']);

    const caught = await reject('someone@blocked-basic.test');

    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe('BAD_REQUEST');
  });

  it('rejects a blocklisted domain whose LIST ENTRY is mixed case', async () => {
    // The upstream sync writes lowercase, but the same row is hand-edited by moderators. Comparing
    // raw would make one capital letter silently match nothing.
    setBlockedDomains(['Blocked-MixedCase.TEST']);

    expect(await reject('someone@blocked-mixedcase.test')).toBeInstanceOf(TRPCError);
  });

  it('rejects a blocklisted domain typed in mixed case', async () => {
    setBlockedDomains(['blocked-input-case.test']);

    expect(await reject('someone@Blocked-Input-Case.TEST')).toBeInstanceOf(TRPCError);
  });

  it('rejects an invented domain that does not resolve (ENOTFOUND)', async () => {
    resolveMx.mockRejectedValue(dnsError('ENOTFOUND'));

    const caught = await reject('someone@gof33etchbitch.ccc');

    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe('BAD_REQUEST');
  });

  it('rejects a parked domain that resolves but publishes no MX (ENODATA)', async () => {
    resolveMx.mockRejectedValue(dnsError('ENODATA'));

    expect(await reject('someone@parked-no-mx.test')).toBeInstanceOf(TRPCError);
  });

  it('rejects a domain whose MX lookup returns an empty record set', async () => {
    resolveMx.mockResolvedValue([]);

    expect(await reject('someone@empty-mx.test')).toBeInstanceOf(TRPCError);
  });

  it('FAILS OPEN when the resolver itself fails (SERVFAIL)', async () => {
    // A DNS blip must not become "nobody can set an email address". Only ENOTFOUND/ENODATA are
    // answers; everything else is the absence of one.
    resolveMx.mockRejectedValue(dnsError('SERVFAIL'));

    await expect(assertEmailAllowed('someone@resolver-down.test')).resolves.toBeUndefined();
  });

  it('FAILS OPEN when the resolver times out', async () => {
    resolveMx.mockRejectedValue(dnsError('ETIMEOUT'));

    await expect(assertEmailAllowed('someone@resolver-slow.test')).resolves.toBeUndefined();
  });

  it('checks the blocklist BEFORE DNS, so a blocked domain never costs a lookup', async () => {
    setBlockedDomains(['blocked-no-dns.test']);

    await reject('someone@blocked-no-dns.test');

    expect(resolveMx).not.toHaveBeenCalled();
  });

  it('does not throw when the cached blocklist value carries NO `data` key', async () => {
    // `getBlocklistDTO` returns `JSON.parse(cached)` verbatim, and this shape is one three
    // separately-released apps can write into the shared key — the auth hub's blocklist test
    // asserts it directly. Without the `?? []` in getBlockedEmailDomains this is a TypeError on
    // `.some`, i.e. a 500 on every signup, which is how it surfaced in the full suite.
    redisGet.mockResolvedValue(JSON.stringify({ type: BlocklistType.EmailDomain }));

    await expect(assertEmailAllowed('someone@no-data-key.test')).resolves.toBeUndefined();
  });

  it('DEGRADES OPEN when the blocklist lookup itself fails', async () => {
    // The lookup is a redis GET falling back to a `dbWrite` read. Rejecting on a failure there
    // would take down signup, profile-email set and email change together, for as long as the blip
    // lasts — and Reddit accounts arrive with no address, so that is the whole funnel.
    redisGet.mockRejectedValue(new Error('redis unreachable'));

    await expect(assertEmailAllowed('someone@lookup-down.test')).resolves.toBeUndefined();
  });

  it('strips a trailing FQDN dot before comparing against the list', async () => {
    // `provider.com.` resolves identically to `provider.com` but is a distinct string, so without
    // this it misses every entry AND takes a second slot in a citext-unique column.
    setBlockedDomains(['blocked-fqdn.test']);

    expect(await reject('someone@blocked-fqdn.test.')).toBeInstanceOf(TRPCError);
  });

  it('rejects a malformed domain the resolver refuses to look up (EBADNAME)', async () => {
    // EBADNAME is an answer — "this cannot be a hostname" — not a failed lookup. Folding it into
    // the fail-open branch would ACCEPT exactly the invented input this check exists to reject.
    resolveMx.mockRejectedValue(dnsError('EBADNAME'));

    expect(await reject('someone@!!!')).toBeInstanceOf(TRPCError);
  });

  it('rejects an address with no domain part', async () => {
    expect(await reject('not-an-email')).toBeInstanceOf(TRPCError);
  });

  it('rejects an address that is all local part and a trailing @', async () => {
    expect(await reject('someone@')).toBeInstanceOf(TRPCError);
  });

  it('reads the domain after the LAST @, not the first', async () => {
    // A quoted-local address carries more than one `@`. Taking the first segment yields a domain
    // that matches no list entry, which admits a blocked address rather than rejecting it.
    setBlockedDomains(['blocked-last-at.test']);

    expect(await reject('"a@b"@blocked-last-at.test')).toBeInstanceOf(TRPCError);
  });

  it('matches the WHOLE domain, not a substring of it', async () => {
    // Negative control for the matcher. Without an allowed address tested against a NON-empty list,
    // widening the comparison to `domain.includes(entry)` passes every other test in this file — and
    // in production an entry of `com` would then block everything, on a list moderators hand-edit.
    setBlockedDomains(['owed-substring.test', 'test']);

    await expect(assertEmailAllowed('someone@allowed-substring.test')).resolves.toBeUndefined();
  });

  it('matches a list entry that carries surrounding whitespace', async () => {
    setBlockedDomains(['  blocked-untrimmed.test  ']);

    expect(await reject('someone@blocked-untrimmed.test')).toBeInstanceOf(TRPCError);
  });

  it('matches an address typed with surrounding whitespace', async () => {
    setBlockedDomains(['blocked-input-space.test']);

    expect(await reject('someone@ blocked-input-space.test ')).toBeInstanceOf(TRPCError);
  });

  /**
   * The suffix list is a SEPARATE, opt-in list. `EmailDomain` stays exact-match on purpose: making
   * it cover subdomains would apply suffix semantics to the ~8,800 entries the weekly upstream sync
   * maintains, 1,357 of which are themselves subdomains of a shared parent (`dynv6.net` alone has
   * 337, and `co.uk` and `org.uk` are on it). Measured on production 2026-09-09.
   *
   * If you are here to delete this list and "just match subdomains everywhere", that is the change
   * these tests exist to stop.
   *
   * This case table is the twin of the one in `apps/auth/src/lib/server/auth/__tests__/blocklist.test.ts`,
   * beside the hub's `isBlockedSuffix`. Keep the two identical — one rule, two separately-released
   * apps, and they have already disagreed once on a cell only one of them covered.
   */
  describe('EmailDomainSuffix', () => {
    it('blocks a subdomain of an opted-in entry', async () => {
      setBlockedSuffixes(['suffix-farm.test']);

      expect(await reject('someone@aftvyzuh.suffix-farm.test')).toBeInstanceOf(TRPCError);
    });

    it('blocks a DEEP subdomain of an opted-in entry', async () => {
      setBlockedSuffixes(['suffix-farm.test']);

      expect(await reject('someone@a.b.c.suffix-farm.test')).toBeInstanceOf(TRPCError);
    });

    it('blocks the opted-in domain itself, not only its subdomains', async () => {
      setBlockedSuffixes(['suffix-apex.test']);

      expect(await reject('someone@suffix-apex.test')).toBeInstanceOf(TRPCError);
    });

    it('does NOT block a different registrable domain that merely ENDS with the entry', async () => {
      // The branch that separates `endsWith('.' + entry)` from `endsWith(entry)`. Without the dot,
      // an entry of `farm.test` also blocks `notfarm.test`, which belongs to someone else.
      setBlockedSuffixes(['farm.test']);

      await expect(assertEmailAllowed('someone@notfarm.test')).resolves.toBeUndefined();
    });

    it('refuses a SINGLE-LABEL entry, so one typo cannot block a whole TLD', async () => {
      // `com` is one keystroke from `com.example`, and nothing validates what a moderator types.
      // Without the `entry.includes('.')` guard this rejects every address under `.test`.
      setBlockedSuffixes(['test']);

      await expect(assertEmailAllowed('someone@single-label.test')).resolves.toBeUndefined();
    });

    it('still enforces the EXACT list when only the suffix read fails', async () => {
      // 🔴 The halves degrade open INDEPENDENTLY. Under `Promise.all` with one shared catch, a
      // failure of the suffix read — which is normally an EMPTY list contributing no policy — also
      // zeroed the ~8,800-entry exact list. Revert to `Promise.all` and this test reports an
      // address that should have been refused resolving instead.
      setBlockedDomains(['still-enforced.test']);
      redisGet.mockImplementation(async (key: string) => {
        if (key.endsWith(`:${BlocklistType.EmailDomainSuffix}`))
          throw new Error('redis unreachable');
        return JSON.stringify({
          type: BlocklistType.EmailDomain,
          data: ['still-enforced.test'],
        });
      });

      expect(await reject('someone@still-enforced.test')).toBeInstanceOf(TRPCError);
    });

    it('still enforces the SUFFIX list when only the exact read fails', async () => {
      // The other direction, so the pair cannot both pass by degrading everything open.
      redisGet.mockImplementation(async (key: string) => {
        if (key.endsWith(`:${BlocklistType.EmailDomainSuffix}`))
          return JSON.stringify({
            type: BlocklistType.EmailDomainSuffix,
            data: ['suffix-survives.test'],
          });
        throw new Error('redis unreachable');
      });

      expect(await reject('someone@a.suffix-survives.test')).toBeInstanceOf(TRPCError);
    });

    it('checks the SUFFIX list before DNS, so a blocked subdomain never costs a lookup', async () => {
      // Worse here than for the exact list: this list exists for owners minting FRESH subdomains,
      // and `mxCache` keys on the full domain, so every one of them is a guaranteed cache miss and
      // a real lookup against the 3s budget.
      setBlockedSuffixes(['no-dns-farm.test']);

      await reject('someone@a.no-dns-farm.test');

      expect(resolveMx).not.toHaveBeenCalled();
    });

    it('does NOT block an unrelated domain while a suffix entry is present', async () => {
      // Negative control for the whole list. A matcher that returns true unconditionally passes
      // every other test in this block.
      setBlockedSuffixes(['suffix-farm.test']);

      await expect(assertEmailAllowed('someone@unrelated-allowed.test')).resolves.toBeUndefined();
    });

    it('leaves EmailDomain exact-matching alone — a subdomain of an EXACT entry is still allowed', async () => {
      // 🔴 DELIBERATE, and the reason the suffix list is a separate type. Do not "fix" this by
      // making the exact list cover subdomains: it would apply to every entry the upstream sync
      // adds, including shared hosts like `dynv6.net`, `co.uk` and `org.uk`.
      setBlockedDomains(['exact-only.test']);
      setBlockedSuffixes([]);

      await expect(assertEmailAllowed('someone@sub.exact-only.test')).resolves.toBeUndefined();
      expect(await reject('someone@exact-only.test')).toBeInstanceOf(TRPCError);
    });

    it('matches a wildcard entry with whitespace AFTER the prefix', async () => {
      // The other side of the strip from the case below. `*. x` leaves ` x` behind, which matches
      // nothing, so the entry is silently inert. The hub's table carries the twin of this case.
      setBlockedSuffixes(['*. after-space.test']);

      expect(await reject('someone@a.after-space.test')).toBeInstanceOf(TRPCError);
    });

    it('matches a wildcard entry that ALSO carries leading whitespace', async () => {
      // 🔴 The PRODUCT of the two cases below, and the cell where this rule and the hub's
      // `isBlockedSuffix` (apps/auth/src/lib/server/auth/blocklist.ts) actually disagreed: the hub
      // stripped the `^`-anchored prefix from the RAW string, so the `*.` survived and the entry
      // matched nothing. Both sides now normalize first. The table below enumerated whitespace and
      // wildcards independently and never their combination, which is how a review found this and
      // the tests did not.
      setBlockedSuffixes(['  *.combo-written.test']);

      expect(await reject('someone@a.combo-written.test')).toBeInstanceOf(TRPCError);
    });

    it('matches an entry a moderator wrote as a wildcard or with a leading dot', async () => {
      // `*.x` and `.x` are how someone writes "and its subdomains" by hand. Unstripped, both are
      // entries that match no address at all, and a suffix entry has no feedback but accounts
      // continuing to arrive.
      setBlockedSuffixes(['*.wildcard-written.test', '.dot-written.test']);

      expect(await reject('someone@a.wildcard-written.test')).toBeInstanceOf(TRPCError);
      expect(await reject('someone@a.dot-written.test')).toBeInstanceOf(TRPCError);
    });

    it('matches an entry with mixed case, whitespace, or a trailing dot', async () => {
      setBlockedSuffixes(['  Suffix-Messy.TEST.  ']);

      expect(await reject('someone@a.suffix-messy.test')).toBeInstanceOf(TRPCError);
    });

    it('an entry that normalizes to EMPTY matches nothing, even for an unnormalized domain', () => {
      // Called DIRECTLY, because that is what makes it capable of failing. Through
      // `assertEmailAllowed` the domain always has its trailing dots stripped, so `endsWith('.')`
      // is false and this assertion passes with the `if (!entry)` guard deleted. Handed a domain
      // nobody normalized, a `'.'` entry without that guard blocks every address on the site.
      expect(matchesBlockedSuffix(['.'], 'example.test.')).toBe(false);
      expect(matchesBlockedSuffix([''], 'example.test')).toBe(false);
      expect(matchesBlockedSuffix(['   '], 'example.test')).toBe(false);
    });
  });
});
