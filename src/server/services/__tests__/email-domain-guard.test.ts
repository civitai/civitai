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

import { assertEmailAllowed } from '../blocklist.service';
import { BlocklistType } from '~/server/common/enums';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const redisGet = redisMock.redis.get;

function setBlockedDomains(domains: string[]) {
  redisGet.mockResolvedValue(JSON.stringify({ type: BlocklistType.EmailDomain, data: domains }));
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
});
