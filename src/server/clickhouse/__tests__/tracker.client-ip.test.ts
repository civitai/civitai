import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * BEHAVIOURAL guard on the address the Tracker stamps into the `ip` column.
 *
 * The relationship under test, stated as a property so it survives a refactor
 * of how the value is obtained:
 *
 *   For any request, the address the Tracker writes is the one the shared
 *   attribution derivation reports for that same request.
 *
 * This is deliberately NOT "the Tracker calls `resolveClientIp`". A test that
 * pinned the call would be satisfied by a comment naming it, and would go red
 * on a rename that changed nothing. This drives the REAL Tracker, captures the
 * payload it actually POSTs, and compares the address on the wire against the
 * shared predicate's own answer for the same request — so it holds whatever the
 * derivation is spelled as, and fails the moment the two disagree.
 *
 * 🔴 WHY THE COMPARISON IS AGAINST THE PREDICATE AND NOT A LITERAL. Both are
 * asserted. A literal alone would drift with the fixture; the predicate alone
 * would pass if BOTH sides collapsed to a constant. The fixtures below are
 * chosen so the expected literal is written down independently, and the
 * predicate agreement is the property.
 *
 * WHAT THIS COVERS THAT THE LEDGER CANNOT: the ledger is a source-text check —
 * it sees an import and a call, not which value reaches the column. An import
 * that was present but applied to the wrong request object, or a value
 * overwritten later in the constructor, is invisible to it and caught here.
 */

vi.mock('~/env/server', () => ({
  env: {
    CLICKHOUSE_TRACKER_URL: 'http://tracker.test',
    CLICKHOUSE_HOST: undefined,
    CLICKHOUSE_USERNAME: undefined,
    CLICKHOUSE_PASSWORD: undefined,
    IS_BUILD: true,
    LOGGING: [],
  },
}));
vi.mock('~/env/other', () => ({ isProd: false, isDev: true }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => null),
}));

import { Tracker } from '../client';
import { UNRESOLVED_CLIENT_IP, resolveClientIp } from '~/server/utils/client-ip';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

function reqWith(
  headers: Record<string, string | string[]>,
  remoteAddress?: string
): NextApiRequest {
  return { headers, socket: { remoteAddress } } as unknown as NextApiRequest;
}

const RES = {} as NextApiResponse;

function lastBody(fetchMock: ReturnType<typeof vi.fn>) {
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  const [, init] = call as [string, { body: string }];
  return JSON.parse(init.body);
}

describe('Tracker: the address stamped into the ip column', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  /** Drive the real Tracker and read the address off the wire. */
  async function stampedIp(req: NextApiRequest): Promise<string> {
    const tracker = new Tracker(req, RES);
    await tracker.modelVersionEvent({
      type: 'Download',
      modelId: 1,
      modelVersionId: 2,
      nsfw: false,
      earlyAccess: false,
    } as never);
    return lastBody(fetchMock).ip;
  }

  describe('harness self-checks', () => {
    it('POSITIVE CONTROL: the harness observes a request actually being sent', () => {
      // A reassuring assertion about `body.ip` is indistinguishable from a
      // harness whose fetch was never called — `lastBody` would throw, but a
      // test that only asserted a property of a value could never notice a
      // ZERO-call run. Assert the count moves.
      expect(fetchMock.mock.calls.length).toBe(0);
      return stampedIp(reqWith({ 'cf-connecting-ip': '203.0.113.7' })).then(() => {
        expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
      });
    });

    it('POSITIVE CONTROL: the harness can observe two DIFFERENT addresses', async () => {
      // Proves the oracle can resolve a difference at all. Without it, every
      // agreement assertion below would pass against a Tracker that stamped one
      // constant for every request.
      const a = await stampedIp(reqWith({ 'cf-connecting-ip': '203.0.113.7' }));
      const b = await stampedIp(reqWith({ 'cf-connecting-ip': '198.51.100.4' }));
      expect(a).toBe('203.0.113.7');
      expect(b).toBe('198.51.100.4');
      expect(a).not.toBe(b);
    });
  });

  describe('the stamped address is the shared derivation, on every fixture', () => {
    /**
     * The fixtures span the cases where a derivation can differ from another:
     * an edge-stamped request, one carrying a competing address, one carrying
     * nothing usable at the edge, and one carrying nothing at all. The expected
     * literal in the third column is written down independently.
     */
    const FIXTURES: ReadonlyArray<
      readonly [string, Record<string, string | string[]>, string | undefined, string]
    > = [
      ['an edge-stamped request', { 'cf-connecting-ip': '203.0.113.7' }, undefined, '203.0.113.7'],
      [
        'an edge-stamped request that also carries a competing address',
        { 'cf-connecting-ip': '203.0.113.7', 'x-client-ip': '198.51.100.4' },
        undefined,
        '203.0.113.7',
      ],
      [
        'a request whose edge value is not an address, falling through',
        { 'cf-connecting-ip': 'notanip', 'x-client-ip': '198.51.100.4' },
        undefined,
        '198.51.100.4',
      ],
      [
        'a request with a zone-scoped edge value, falling through to the peer',
        { 'cf-connecting-ip': 'fe80::1%eth0' },
        '10.42.0.9',
        '10.42.0.9',
      ],
      ['a request with only a transport peer', {}, '10.42.0.9', '10.42.0.9'],
    ];

    it.each(FIXTURES)('%s', async (_label, headers, peer, expected) => {
      const req = reqWith(headers, peer);
      const onWire = await stampedIp(req);

      // (a) the value is the one written down in the table
      expect(onWire).toBe(expected);
      // (b) and it is the shared derivation's own answer for this request —
      //     the property, which holds whatever the derivation is called.
      expect(onWire).toBe(resolveClientIp(req));
    });
  });

  describe('the unresolvable case keeps the column value it always had', () => {
    it('stamps the shared label when nothing resolves', async () => {
      // The Tracker's `actor.ip` initialiser has always been this literal, and
      // the shared derivation answers with the same one, so the consolidation
      // left this case byte-identical. Pinned because it is the case a sentinel
      // change would have silently moved — and this column is grouped on
      // downstream by the abuse-prevention job.
      const req = reqWith({});
      expect(await stampedIp(req)).toBe(UNRESOLVED_CLIENT_IP);
      expect(resolveClientIp(req)).toBe(UNRESOLVED_CLIENT_IP);
    });

    it('stamps the label when the Tracker was built with no request at all', async () => {
      const tracker = new Tracker(undefined, undefined, null as never);
      await tracker.modelVersionEvent({
        type: 'Download',
        modelId: 1,
        modelVersionId: 2,
        nsfw: false,
        earlyAccess: false,
      } as never);
      expect(lastBody(fetchMock).ip).toBe(UNRESOLVED_CLIENT_IP);
    });
  });
});
