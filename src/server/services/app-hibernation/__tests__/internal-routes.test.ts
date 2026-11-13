import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';
import {
  HIBERNATION_HEADERS,
  signHibernationRequest,
} from '~/server/services/app-hibernation/internal-auth';
import {
  createHibernationRoutes,
  HIBERNATION_PATHS,
  type HibernationRouteDeps,
} from '~/server/services/app-hibernation/internal-routes';
import { sha, world, type World } from './hibernation.fakes';

/**
 * The signed routes the sandbox service calls, driven through the REAL handler: raw-body HMAC,
 * the timestamp window, the flag, and the begin -> upload -> commit flow.
 */

// TEST-ONLY placeholder secrets.
const SECRET = 'test-only-hibernation-hmac-secret-0001';
const WRONG_SECRET = 'test-only-hibernation-hmac-secret-9999';
const PREVIOUS_SECRET = 'test-only-hibernation-hmac-secret-0000';
const NOW = 1_800_000_000;
const USER = 7301;
const APP = 'habit-tracker';
const A1 = '33333333-3333-4333-8333-333333333333';

let w: World;
let routes: ReturnType<typeof createHibernationRoutes>;

beforeEach(() => {
  setEnv({ APP_HIBERNATION_HMAC_SECRET: SECRET, APP_HIBERNATION_HMAC_SECRET_PREVIOUS: undefined });
  w = world();
  const deps: HibernationRouteDeps = {
    hibernation: async () => w.deps,
    nowSeconds: () => NOW,
    report: () => undefined,
  };
  routes = createHibernationRoutes(async () => deps);
});

function signed(path: string, body: unknown, opts: { secret?: string; timestamp?: number } = {}) {
  const raw = Buffer.from(JSON.stringify(body));
  const timestamp = String(opts.timestamp ?? NOW);
  const signature = signHibernationRequest(opts.secret ?? SECRET, {
    method: 'POST',
    path,
    timestamp,
    body: raw,
  });
  return {
    raw,
    headers: {
      [HIBERNATION_HEADERS.timestamp]: timestamp,
      [HIBERNATION_HEADERS.signature]: signature,
    },
  };
}

async function call(
  route: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>,
  req: { raw: Buffer; headers: Record<string, string> },
  method = 'POST'
) {
  let status = 200;
  let json: Record<string, unknown> | undefined;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(value: Record<string, unknown>) {
      json = value;
      return res;
    },
    setHeader() {
      return res;
    },
  } as unknown as NextApiResponse;
  const request = {
    method,
    headers: req.headers,
    async *[Symbol.asyncIterator]() {
      yield req.raw;
    },
  } as unknown as NextApiRequest;
  await route(request, res);
  return { status, json };
}

const beginBody = { userId: USER, app: APP, attemptId: A1 };

describe('HMAC request signing', () => {
  it('a correctly signed begin is answered with presigned PUTs under keys civitai built', async () => {
    const res = await call(routes.begin, signed(HIBERNATION_PATHS.begin, beginBody));
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      archive: { key: `archives/${USER}/${APP}/${A1}.zip` },
      secrets: { key: `archives/${USER}/${APP}/${A1}.secrets` },
    });
  });

  it('a request signed with the wrong secret is refused 401 and does nothing', async () => {
    const res = await call(
      routes.begin,
      signed(HIBERNATION_PATHS.begin, beginBody, { secret: WRONG_SECRET })
    );
    expect(res).toEqual({ status: 401, json: { error: 'Unauthorized', code: 'unauthorized' } });
    expect(w.attemptsMap.size).toBe(0);
  });

  it('a timestamp outside the 300 s window is refused as stale, either side of now', async () => {
    for (const timestamp of [NOW - 301, NOW + 301]) {
      const res = await call(
        routes.begin,
        signed(HIBERNATION_PATHS.begin, beginBody, { timestamp })
      );
      expect(res).toEqual({ status: 401, json: { error: 'Unauthorized', code: 'stale' } });
    }
    // The window's edge is still inside.
    expect(
      (
        await call(
          routes.begin,
          signed(HIBERNATION_PATHS.begin, beginBody, { timestamp: NOW - 300 })
        )
      ).status
    ).toBe(200);
    expect(w.attemptsMap.size).toBe(1);
  });

  it('a signature for one route is refused by another, and a changed body by its own', async () => {
    const forBegin = signed(HIBERNATION_PATHS.begin, beginBody);
    expect((await call(routes.commit, forBegin)).json).toMatchObject({ code: 'unauthorized' });
    const tampered = { ...forBegin, raw: Buffer.from(JSON.stringify({ ...beginBody, userId: 1 })) };
    expect((await call(routes.begin, tampered)).json).toMatchObject({ code: 'unauthorized' });
  });

  it('a body over 256 KiB is refused 413 before any signature work or service call', async () => {
    const big = { ...beginBody, pad: 'x'.repeat(256 * 1024) };
    expect(await call(routes.begin, signed(HIBERNATION_PATHS.begin, big))).toEqual({
      status: 413,
      json: { error: 'Payload too large', code: 'too_large' },
    });
    expect(w.attemptsMap.size).toBe(0);
  });

  it('during a rotation the previous secret is accepted too, and nothing else is', async () => {
    setEnv({
      APP_HIBERNATION_HMAC_SECRET: SECRET,
      APP_HIBERNATION_HMAC_SECRET_PREVIOUS: PREVIOUS_SECRET,
    });
    const asPrevious = signed(HIBERNATION_PATHS.begin, beginBody, { secret: PREVIOUS_SECRET });
    expect((await call(routes.begin, asPrevious)).status).toBe(200);
    expect((await call(routes.begin, signed(HIBERNATION_PATHS.begin, beginBody))).status).toBe(200);
    expect(
      (
        await call(
          routes.begin,
          signed(HIBERNATION_PATHS.begin, beginBody, { secret: WRONG_SECRET })
        )
      ).json
    ).toMatchObject({ code: 'unauthorized' });
  });

  it('the previous secret is refused once the rotation is over (unset)', async () => {
    const asPrevious = signed(HIBERNATION_PATHS.begin, beginBody, { secret: PREVIOUS_SECRET });
    expect((await call(routes.begin, asPrevious)).json).toMatchObject({ code: 'unauthorized' });
  });

  it('the previous secret alone, with no current one, opens nothing', async () => {
    setEnv({
      APP_HIBERNATION_HMAC_SECRET: '',
      APP_HIBERNATION_HMAC_SECRET_PREVIOUS: PREVIOUS_SECRET,
    });
    const asPrevious = signed(HIBERNATION_PATHS.begin, beginBody, { secret: PREVIOUS_SECRET });
    expect((await call(routes.begin, asPrevious)).status).toBe(503);
  });

  it('the secrets route answers 403 ticket without a valid wake ticket', async () => {
    expect(
      await call(
        routes.secrets,
        signed(HIBERNATION_PATHS.secrets, {
          userId: USER,
          app: APP,
          sha256: 'a'.repeat(64),
          ticket: 'never-minted-ticket-value-000000000000000',
        })
      )
    ).toEqual({
      status: 403,
      json: { error: 'No valid wake ticket for this restore', code: 'ticket' },
    });
  });

  it('no configured secret answers 503 to everyone', async () => {
    setEnv({ APP_HIBERNATION_HMAC_SECRET: '  ' });
    expect((await call(routes.begin, signed(HIBERNATION_PATHS.begin, beginBody))).status).toBe(503);
  });
});

describe('the flag off refuses every route', () => {
  it('begin, commit and secrets each answer 403 disabled', async () => {
    const ok = await call(routes.begin, signed(HIBERNATION_PATHS.begin, beginBody));
    expect(ok.status).toBe(200);
    w.state.enabled = false;
    const disabled = {
      status: 403,
      json: { error: 'App hibernation is not enabled', code: 'disabled' },
    };

    expect(
      await call(
        routes.begin,
        signed(HIBERNATION_PATHS.begin, {
          ...beginBody,
          attemptId: '44444444-4444-4444-8444-444444444444',
        })
      )
    ).toEqual(disabled);
    expect(
      await call(
        routes.commit,
        signed(HIBERNATION_PATHS.commit, { attemptId: A1, sha256: 'a'.repeat(64), bytes: 10 })
      )
    ).toEqual(disabled);
    expect(
      await call(
        routes.secrets,
        signed(HIBERNATION_PATHS.secrets, {
          userId: USER,
          app: APP,
          sha256: 'a'.repeat(64),
          ticket: 'x'.repeat(43),
        })
      )
    ).toEqual(disabled);
  });
});

describe('begin -> upload -> commit through the routes', () => {
  it('commits a verified upload and answers the receipt; a tampered upload gets 409 and no row', async () => {
    const begun = await call(routes.begin, signed(HIBERNATION_PATHS.begin, beginBody));
    const key = (begun.json as { archive: { key: string } }).archive.key;
    const archive = Buffer.from('PK\x03\x04 the habit tracker');
    w.objects.set(key, Buffer.from('PK\x03\x04 the habit TRACKER'));
    const body = { attemptId: A1, sha256: sha(archive), bytes: archive.length };

    expect(await call(routes.commit, signed(HIBERNATION_PATHS.commit, body))).toEqual({
      status: 409,
      json: {
        error: 'Stored object does not match',
        code: 'mismatch',
        reason: 'archive sha256 mismatch',
      },
    });
    expect(w.rows.size).toBe(0);

    w.objects.set(key, archive);
    expect(await call(routes.commit, signed(HIBERNATION_PATHS.commit, body))).toEqual({
      status: 200,
      json: { committed: true, sha256: sha(archive) },
    });
    expect(w.rows.size).toBe(1);
  });

  it('at the plan limit begin answers the typed SLEEPING_LIMIT refusal', async () => {
    w.deps.limits = async () => ({ apps: 0, bytes: 1_000 });
    expect(await call(routes.begin, signed(HIBERNATION_PATHS.begin, beginBody))).toEqual({
      status: 409,
      json: {
        error: 'Sleeping app limit reached',
        code: 'SLEEPING_LIMIT',
        limit: { kind: 'apps', limit: 0, used: 0 },
        oldest: null,
      },
    });
  });
});
