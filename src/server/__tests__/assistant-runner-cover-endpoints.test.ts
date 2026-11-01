import { generateKeyPairSync } from 'node:crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';
import type * as AppAssistantService from '~/server/services/app-assistant/app-assistant.service';

/**
 * App Assistant's server runner reads the user's listing for an app before it offers a cover, as
 * the user its run grant names: `/api/internal/app-assistant/cover/listing`. (The cover itself is
 * made only by the page, on the user's press; the runner has no write here.)
 *
 * The route runs for real down to the database: `runnerCoverListingRead`, the listing service
 * behind `appListings.getMyListingForApp`, and its ownership gate (`resolveListingRole` →
 * `resolveListingAccess`, the canonical owner, then an accepted seat). Only the rows are fake (a
 * mocked `dbRead`/`dbWrite`), so "whose listing is this" is decided by the real check, not by the
 * fixture. Also mocked: the App Assistant user gates (`getRunnerDevTunnelUser`, covered in
 * app-assistant.service.test.ts).
 */

type Row = { id: string; slug: string; status: string; ownerUserId: number };

const { runnerUserMock, db, rows, seats } = vi.hoisted(() => {
  const rows = new Map<string, Row>();
  /** `${listingId}:${userId}`: an accepted editor seat. */
  const seats = new Set<string>();
  const byId = (id: string) => [...rows.values()].find((r) => r.id === id) ?? null;
  const client = {
    appListing: {
      // The entry read: by slug, top-level listings only.
      findFirst: vi.fn(async (args: { where?: { slug?: string; revisionOfId?: unknown } }) => {
        const row = args.where?.slug ? rows.get(args.where.slug) : undefined;
        if (!row || args.where?.revisionOfId !== null) return null;
        return {
          id: row.id,
          kind: 'onsite',
          status: row.status,
          contentRating: 'g',
          revisionOfId: null,
          appBlock: { contentRating: 'g' },
        };
      }),
      // By id: the edit view (it selects `icon`), or the access read the ownership gate makes.
      findUnique: vi.fn(
        async (args: { where?: { id?: string }; select?: Record<string, unknown> }) => {
          const row = byId(args.where?.id ?? '');
          if (!row) return null;
          if ('icon' in (args.select ?? {}))
            return { iconId: null, coverId: null, icon: null, cover: null, screenshots: [] };
          return {
            id: row.id,
            slug: row.slug,
            kind: 'onsite',
            appBlockId: `blk_${row.id}`,
            revisionOfId: null,
            // The listing's own column names nobody: the canonical owner is the block's.
            userId: -1,
            appBlock: { app: { userId: row.ownerUserId } },
          };
        }
      ),
    },
    appCollaborator: {
      findFirst: vi.fn(async (args: { where?: { appListingId?: string; userId?: number } }) =>
        seats.has(`${args.where?.appListingId}:${args.where?.userId}`)
          ? { userId: args.where?.userId }
          : null
      ),
    },
    appListingPublishRequest: { findFirst: vi.fn(async () => null) },
    appListingScreenshot: { findMany: vi.fn(async () => []) },
    appListingModerationEvent: { findFirst: vi.fn(async () => null) },
    image: { findMany: vi.fn(async () => []) },
  };
  return { runnerUserMock: vi.fn(), db: client, rows, seats };
});

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/db/client', () => ({ dbRead: db, dbWrite: db }));
vi.mock('~/client-utils/edge-url', () => ({ getEdgeUrl: (url: string) => `edge:${url}` }));
vi.mock('~/server/services/app-assistant/app-assistant.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppAssistantService>()),
  getRunnerDevTunnelUser: runnerUserMock,
}));

const { signRunGrant } = await import('~/server/services/app-assistant/assistant-runner-tokens');
const listingRoute = (await import('~/pages/api/internal/app-assistant/cover/listing')).default;

// TEST-ONLY values: a key pair generated for this run and a placeholder secret.
const SECRET = 'test-only-runner-secret-for-covers';
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const SIGNING_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

// Pairwise-distinct fixtures: three users, two listings, no id or slug shared.
const OWNER = 5101;
const OTHER = 5202;
const MODERATOR = 5303;
const OWNED_APP = 'alpha-cover';
const OTHERS_APP = 'beta-cover';

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown> | unknown;
const asRunner = { authorization: `Bearer ${SECRET}` };

async function call(
  handler: Handler,
  body: unknown,
  headers: Record<string, string> = asRunner,
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
    setHeader: () => res,
  } as unknown as NextApiResponse;
  await handler({ method, headers, body, query: {} } as unknown as NextApiRequest, res);
  return { status, json };
}

const grantFor = async (userId: number, use?: 'preview') =>
  (
    await signRunGrant({
      userId,
      conversationId: `c-${userId}`,
      idempotencyKey: `k-${userId}`,
      ...(use ? { use } : {}),
    })
  ).token;

/** The access reads the ownership gate made, by listing id: proof the real check ran. */
const accessReads = () =>
  db.appListing.findUnique.mock.calls
    .map(([a]) => a as { where?: { id?: string }; select?: Record<string, unknown> })
    .filter((a) => 'appBlock' in (a.select ?? {}) && 'revisionOf' in (a.select ?? {}))
    .map((a) => a.where?.id);

beforeEach(() => {
  vi.clearAllMocks();
  setEnv({
    ASSISTANT_RUNNER_SECRET: SECRET,
    ASSISTANT_RUNNER_SIGNING_KEY: SIGNING_KEY,
    ASSISTANT_RUNNER_GRANT_TTL_SECONDS: 7800,
  });
  rows.clear();
  seats.clear();
  rows.set(OWNED_APP, { id: 'apl_owned', slug: OWNED_APP, status: 'approved', ownerUserId: OWNER });
  rows.set(OTHERS_APP, { id: 'apl_others', slug: OTHERS_APP, status: 'draft', ownerUserId: OTHER });
  runnerUserMock.mockImplementation(async (userId: number) => ({
    refusal: null,
    user: { id: userId, isModerator: false },
  }));
});

describe('cover/listing', () => {
  it('answers the grant’s user’s own listing for the app', async () => {
    const { status, json } = await call(listingRoute, {
      grant: await grantFor(OWNER),
      app: OWNED_APP,
    });
    expect(status).toBe(200);
    expect(json).toEqual({
      listing: { listingId: 'apl_owned', blockedReason: null, status: 'approved' },
    });
    expect(runnerUserMock).toHaveBeenCalledWith(OWNER);
    // The owner was decided by the access read (the block's owner), not the listing's column.
    expect(accessReads()).toContain('apl_owned');
  });

  it('answers none for someone else’s listing: the ownership check refuses it', async () => {
    const { status, json } = await call(listingRoute, {
      grant: await grantFor(OWNER),
      app: OTHERS_APP,
    });
    expect(status).toBe(200);
    expect(json).toEqual({ listing: null });
    // The listing exists: it was found, then refused by the access read and the seat check.
    expect(accessReads()).toContain('apl_others');
    expect(db.appCollaborator.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ appListingId: 'apl_others', userId: OWNER }),
      })
    );
  });

  it('answers none for an app with no listing at all', async () => {
    const { status, json } = await call(listingRoute, {
      grant: await grantFor(OWNER),
      app: 'gamma-cover',
    });
    expect(status).toBe(200);
    expect(json).toEqual({ listing: null });
    expect(accessReads()).toEqual([]);
  });

  it('answers none to a moderator who does not own the listing: no moderator override', async () => {
    runnerUserMock.mockImplementation(async (userId: number) => ({
      refusal: null,
      user: { id: userId, isModerator: true },
    }));
    const { status, json } = await call(listingRoute, {
      grant: await grantFor(MODERATOR),
      app: OWNED_APP,
    });
    expect(status).toBe(200);
    expect(json).toEqual({ listing: null });
    expect(accessReads()).toContain('apl_owned');
  });

  it('answers an accepted editor seat’s listing, as the listing editor’s read does', async () => {
    // The control for the refusals above: the same listing, the same non-owner, with a seat.
    seats.add(`apl_others:${OWNER}`);
    const { json } = await call(listingRoute, { grant: await grantFor(OWNER), app: OTHERS_APP });
    expect(json).toEqual({
      listing: { listingId: 'apl_others', blockedReason: null, status: 'draft' },
    });
  });

  it('answers unavailable when the listing cannot be read', async () => {
    db.appListing.findFirst.mockRejectedValueOnce(new Error('db detail'));
    const { status, json } = await call(listingRoute, {
      grant: await grantFor(OWNER),
      app: OWNED_APP,
    });
    expect(status).toBe(503);
    expect(json).toEqual({
      error: 'Your app’s store listing could not be read right now.',
      code: 'unavailable',
    });
  });

  it('refuses a preview grant, a refused user, and a caller without the runner’s secret', async () => {
    const preview = await call(listingRoute, {
      grant: await grantFor(OWNER, 'preview'),
      app: OWNED_APP,
    });
    expect(preview).toMatchObject({ status: 403, json: { code: 'refused' } });

    runnerUserMock.mockResolvedValueOnce({
      refusal: {
        status: 403,
        error: 'You do not have access to Apps authoring',
        code: 'FORBIDDEN',
      },
    });
    const refused = await call(listingRoute, { grant: await grantFor(OWNER), app: OWNED_APP });
    expect(refused).toMatchObject({ status: 403, json: { code: 'FORBIDDEN' } });

    const stranger = await call(
      listingRoute,
      { grant: await grantFor(OWNER), app: OWNED_APP },
      { authorization: 'Bearer not-the-secret' }
    );
    expect(stranger.status).toBe(401);
    expect(db.appListing.findFirst).not.toHaveBeenCalled();
  });

  it('refuses a grant civitai did not sign, or one that has expired, before reading anything', async () => {
    const forged = await call(listingRoute, { grant: 'test-only-not-a-grant', app: OWNED_APP });
    expect(forged).toEqual({
      status: 401,
      json: { error: 'Not a current run grant', code: 'invalid_grant' },
    });

    const grant = await grantFor(OWNER);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // Past the grant's 7800 s life by a day, whatever skew the verifier allows.
      vi.setSystemTime(Date.now() + (7800 + 86_400) * 1000);
      const expired = await call(listingRoute, { grant, app: OWNED_APP });
      expect(expired).toEqual({
        status: 401,
        json: { error: 'Not a current run grant', code: 'invalid_grant' },
      });
    } finally {
      vi.useRealTimers();
    }
    expect(runnerUserMock).not.toHaveBeenCalled();
    expect(db.appListing.findFirst).not.toHaveBeenCalled();
  });

  it('refuses a body with no app, or an app that is not a string', async () => {
    const grant = await grantFor(OWNER);
    for (const body of [{ grant }, { grant, app: 4242 }, { grant, app: '' }]) {
      const { status, json } = await call(listingRoute, body);
      expect(status).toBe(400);
      expect(json).toEqual({ error: 'Expected { grant, app }' });
    }
    expect(runnerUserMock).not.toHaveBeenCalled();
    expect(db.appListing.findFirst).not.toHaveBeenCalled();
  });

  it('refuses any method but POST', async () => {
    const grant = await grantFor(OWNER);
    for (const method of ['GET', 'PUT']) {
      const { status, json } = await call(
        listingRoute,
        { grant, app: OWNED_APP },
        asRunner,
        method
      );
      expect(status).toBe(405);
      expect(json).toEqual({ error: 'Method not allowed' });
    }
    expect(runnerUserMock).not.toHaveBeenCalled();
    expect(db.appListing.findFirst).not.toHaveBeenCalled();
  });
});
