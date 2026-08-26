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

  it('rejects an address with no domain part', async () => {
    expect(await reject('not-an-email')).toBeInstanceOf(TRPCError);
  });
});
