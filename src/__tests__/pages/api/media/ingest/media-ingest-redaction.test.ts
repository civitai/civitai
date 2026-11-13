import type { NextApiRequest } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Orchestrator from '~/server/services/orchestrator/orchestrator.service';

const { mockIngest, mockGetSession } = vi.hoisted(() => ({
  mockIngest: vi.fn(),
  mockGetSession: vi.fn(),
}));

vi.mock('~/server/auth/get-server-auth-session', () => ({ getServerAuthSession: mockGetSession }));
vi.mock('~/server/services/orchestrator/orchestrator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Orchestrator>()),
  createImageIngestionRequest: mockIngest,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { ImageIngestionUrlBlockedError } from '~/server/utils/image-scan-url';
import handler, { redactSecrets } from '~/pages/api/media/ingest/[mediaId]';

/**
 * Tests live outside the pages tree: every .ts/.tsx under src/pages/** is enumerated by
 * Next as a route, so a co-located suite breaks the production build
 * (see no-test-files-in-pages-tree.test.ts).
 *
 * Two behaviours, both in the failure echo path of the moderator re-ingest tool:
 *   1. the 502 body — the orchestrator echoes the submitted workflow, whose callback
 *      carries `?token=$WEBHOOK_TOKEN` — must not hand the token back verbatim;
 *   2. an off-allowlist media url is a 400 from the funnel guard, not a 500.
 */

const TOKEN = 'sekret-webhook-token-abc';
const CALLBACK = `https://civitai.example/api/webhooks/image-scan-result?token=${TOKEN}`;

const harness = (media: { id: number; url: string; type: string } | null, mediaId = '4242') => {
  let statusCode: number | undefined;
  let payload: unknown;
  const res = {
    status(c: number) {
      statusCode = c;
      return res;
    },
    json(b: unknown) {
      payload = b;
      return res;
    },
    setHeader: vi.fn(),
    end() {
      return res;
    },
    _status: () => statusCode,
    _json: () => payload,
  } as unknown as Parameters<typeof handler>[1] & { _status: () => number; _json: () => unknown };
  const req = {
    method: 'GET',
    query: { mediaId },
  } as unknown as NextApiRequest;
  dbMock.dbRead.image.findUnique.mockResolvedValue(media);
  return { req, res };
};

beforeEach(() => {
  setEnv({ WEBHOOK_TOKEN: TOKEN, IMAGE_SCANNING_CALLBACK: 'https://civitai.example/cb' });
  mockIngest.mockReset();
  mockGetSession.mockReset().mockResolvedValue({ user: { isModerator: true, bannedAt: null } });
  loggingMock.logToAxiom.mockClear();
});

afterEach(() => {
  resetEnv();
});

describe('redactSecrets', () => {
  it('strips the token everywhere in a nested body, preserving the rest', () => {
    const body = {
      callbacks: [{ url: CALLBACK, type: 'workflow:failed' }],
      nested: { deep: [`still ${TOKEN}`] },
    };
    const redacted = redactSecrets(body, [TOKEN]) as typeof body;
    expect(JSON.stringify(redacted)).not.toContain(TOKEN);
    expect(JSON.stringify(redacted)).toContain('<redacted>');
    expect(redacted.callbacks[0].type).toBe('workflow:failed');
  });

  it('is a passthrough when there is no secret to strip', () => {
    const body = { callbacks: [{ url: 'https://cb' }] };
    expect(redactSecrets(body, [undefined])).toEqual(body);
    expect(redactSecrets(body, [])).toEqual(body);
    expect(redactSecrets(null, [TOKEN])).toBeNull();
  });

  /**
   * The callback is `env.IMAGE_SCANNING_CALLBACK` whenever set (production takes that
   * branch), so a secret living in THAT url is not removed by splitting on WEBHOOK_TOKEN.
   */
  it('strips a secret carried by the override callback url, not just WEBHOOK_TOKEN', () => {
    const override = 'https://scan.example/cb?key=OVERRIDE_SECRET_VALUE';
    const body = { callbacks: [{ url: override }] };
    const redacted = redactSecrets(body, [override, TOKEN]);
    expect(JSON.stringify(redacted)).not.toContain('OVERRIDE_SECRET_VALUE');
  });

  /** A secret containing a JSON-escaped character never appears raw in the serialization. */
  it('strips a secret whose characters JSON escapes', () => {
    const secret = 'tok"en\\with';
    const redacted = redactSecrets({ deep: { s: `x ${secret} y` } }, [secret]);
    expect(JSON.stringify(redacted)).not.toContain('tok\\"en');
    expect(JSON.stringify(redacted)).toContain('<redacted>');
  });
});

describe('GET /api/media/ingest/[mediaId]', () => {
  it('redacts the webhook token out of the 502 echo', async () => {
    mockIngest.mockResolvedValue({
      data: undefined,
      error: 'Ingestion request failed',
      status: 502,
      body: { callbacks: [{ url: CALLBACK }], externalId: 'wf-xyz' },
    });

    const { req, res } = harness({
      id: 4242,
      url: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/x.png',
      type: 'image',
    });
    await handler(req, res);

    expect(res._status()).toBe(502);
    const echoed = JSON.stringify(res._json());
    expect(echoed).not.toContain(TOKEN);
    expect(echoed).toContain('<redacted>');
    expect(echoed).toContain('wf-xyz');
  });

  it('answers 400 when the media url is off the ingestion allowlist', async () => {
    mockIngest.mockRejectedValue(new ImageIngestionUrlBlockedError('https://evil.com/x.png'));

    const { req, res } = harness({ id: 4242, url: 'https://evil.com/x.png', type: 'image' });
    await handler(req, res);

    expect(res._status()).toBe(400);
    expect(JSON.stringify(res._json())).toContain('not on the ingestion allowlist');
  });

  /**
   * 🔴 These four pin the WIRING, not the helper. The helper was rewritten to take a needle
   * LIST specifically so the callback actually in use is redacted — production's callback is
   * `IMAGE_SCANNING_CALLBACK`, not the `WEBHOOK_TOKEN`-bearing default — and none of that was
   * observable while this suite's harness set a SECRET-FREE override. Verified by mutation:
   * before these rows, dropping `callbackUrl` from the needle list, reverting the 500 branch
   * to un-redacted, redacting only `body` instead of the whole response, and reversing the
   * longest-first sort ALL passed the suite.
   */
  it('redacts a secret carried by the OVERRIDE callback url, not just WEBHOOK_TOKEN', async () => {
    const override = 'https://scan.example/cb?key=OVERRIDE_SECRET_VALUE';
    setEnv({ WEBHOOK_TOKEN: TOKEN, IMAGE_SCANNING_CALLBACK: override });
    mockIngest.mockResolvedValue({
      data: undefined,
      error: 'Ingestion request failed',
      status: 502,
      body: { callbacks: [{ url: override }], externalId: 'wf-ovr' },
    });

    const { req, res } = harness({ id: 4242, url: 'a/b.png', type: 'image' });
    await handler(req, res);

    expect(res._status()).toBe(502);
    const echoed = JSON.stringify(res._json());
    expect(echoed).not.toContain('OVERRIDE_SECRET_VALUE');
    expect(echoed).toContain('wf-ovr');
  });

  it('redacts the ERROR field too, not only body', async () => {
    mockIngest.mockResolvedValue({
      data: undefined,
      // The orchestrator's own error payload can echo the submitted callback back at us.
      error: `validation failed for ${CALLBACK}`,
      status: 502,
      body: { externalId: 'wf-err' },
    });

    const { req, res } = harness({ id: 4242, url: 'a/b.png', type: 'image' });
    await handler(req, res);

    expect(JSON.stringify(res._json())).not.toContain(TOKEN);
  });

  it('redacts the 500 branch as well', async () => {
    mockIngest.mockRejectedValue(new Error(`boom while posting to ${CALLBACK}`));

    const { req, res } = harness({ id: 4242, url: 'a/b.png', type: 'image' });
    await handler(req, res);

    expect(res._status()).toBe(500);
    expect(JSON.stringify(res._json())).not.toContain(TOKEN);
  });

  it('sorts the needles itself, so a shortest-first caller is still safe', () => {
    // Pins that the sort EXISTS, not just its direction: both production call sites already
    // pass [callbackUrl, token] — longest first — so reversing the comparator is observable but
    // deleting it outright was not. A future caller passing them the other way must still be
    // safe, since stripping the inner token first would leave the surrounding URL structure.
    const out = JSON.stringify(redactSecrets({ u: CALLBACK }, [TOKEN, CALLBACK]));
    expect(out).toBe(JSON.stringify({ u: '<redacted>' }));
  });

  it('removes a token-bearing url as ONE redaction, longest needle first', () => {
    // Ascending order would strip the inner token first and leave a mangled URL still
    // carrying its surrounding structure; longest-first collapses the whole thing once.
    const out = JSON.stringify(redactSecrets({ u: CALLBACK }, [CALLBACK, TOKEN]));
    expect(out).not.toContain(TOKEN);
    expect(out).toBe(JSON.stringify({ u: '<redacted>' }));
  });

  it('answers 404 for an unknown media id without touching the orchestrator', async () => {
    const { req, res } = harness(null);
    await handler(req, res);

    expect(res._status()).toBe(404);
    expect(mockIngest).not.toHaveBeenCalled();
  });
});

describe('GET /api/media/ingest/[mediaId] shared token', () => {
  const call = async (secret: string | undefined, token: string | undefined) => {
    setEnv({ WEBHOOK_TOKEN: secret });
    mockGetSession.mockResolvedValue(null);
    const { req, res } = harness(null);
    if (token !== undefined) req.query.token = token;
    await handler(req, res);
    return res._status();
  };

  it('refuses whitespace against a whitespace secret without a moderator session', async () => {
    expect(await call('  ', '  ')).toBe(401);
  });

  it('POSITIVE CONTROL: the configured secret stands in for the moderator session', async () => {
    expect(await call(TOKEN, TOKEN)).toBe(404);
  });
});
