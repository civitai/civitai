import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { NsfwLevel } from '~/server/common/enums';

/**
 * Shared fixtures for the `/images/[imageId]` server-data tests: the page's own
 * `getServerSideProps` and `GET /api/page-data/images/[imageId]` must hand the client the same
 * `trpcState` for the same viewer.
 *
 * The router below stands in for `~/server/routers` (same seam as
 * `moderator-pages.credential-requirements.test.ts`): the four procedures the page prefetches,
 * built from the REAL `publicProcedure`, each answering from the viewer it is handed. What the
 * tests can therefore see is every way the two callers could build a different tRPC context —
 * the user (including how its dates were serialised), moderator status, the feature flags,
 * the domain and the credential — or prefetch a different set of queries. They cannot see the
 * real controllers' rules; those are pinned by their own suites
 * (`get-image-viewer-media.test.ts`).
 */

export const OWNER_ID = 7;

// `createdAt` is a real Date, as a warm session-cache hit returns it. A server render sees it
// as the ISO string `_app`'s JSON round trip turns it into (`resolveSettingsBootstrapForRender`).
const sessionUser = (id: number, username: string, isModerator = false) => ({
  id,
  username,
  isModerator,
  tier: 'free',
  createdAt: new Date('2024-01-02T03:04:05.000Z'),
});

export const USERS = {
  owner: sessionUser(OWNER_ID, 'owner'),
  moderator: sessionUser(5, 'moderator', true),
  blockedByOwner: sessionUser(66, 'blocked'),
  viewer: sessionUser(99, 'viewer'),
};

export type FixtureUser = (typeof USERS)[keyof typeof USERS];

type FixtureImage = {
  id: number;
  nsfwLevel: number;
  userId: number;
  poi: boolean;
  type?: 'image' | 'video';
  name?: string | null;
  /** A contest collection the image is in forces this rating (`getContestCollectionDetails`). */
  forcedBrowsingLevel?: number;
};

export const IMAGES: Record<number, FixtureImage> = {
  101: { id: 101, nsfwLevel: NsfwLevel.R, userId: OWNER_ID, poi: false },
  102: { id: 102, nsfwLevel: NsfwLevel.PG13, userId: OWNER_ID, poi: true },
  103: { id: 103, nsfwLevel: NsfwLevel.PG, userId: OWNER_ID, poi: false },
  // Its `image.get` writes a shared-cache header onto the response, as a procedure may.
  104: { id: 104, nsfwLevel: NsfwLevel.PG, userId: OWNER_ID, poi: false },
  // The main-image preload: a named PG image, a PG video, a PG image a contest forces to R, and a
  // PG13 one.
  106: {
    id: 106,
    nsfwLevel: NsfwLevel.PG,
    userId: OWNER_ID,
    poi: false,
    name: 'Sunset Over Hills.png',
  },
  107: { id: 107, nsfwLevel: NsfwLevel.PG, userId: OWNER_ID, poi: false, type: 'video' },
  108: {
    id: 108,
    nsfwLevel: NsfwLevel.PG,
    userId: OWNER_ID,
    poi: false,
    forcedBrowsingLevel: NsfwLevel.R,
  },
  109: { id: 109, nsfwLevel: NsfwLevel.PG13, userId: OWNER_ID, poi: false },
};

/** Viewers each image's owner has blocked. */
const BLOCKED_BY: Record<number, number[]> = { [OWNER_ID]: [USERS.blockedByOwner.id] };

export const CDN_HEADER_IMAGE_ID = 104;

export type Fixture = {
  user: FixtureUser | null;
  imageId: number;
  host: string;
};

export const FIXTURES: [string, Fixture][] = [
  ['the owner', { user: USERS.owner, imageId: 101, host: 'civitai.com' }],
  ['a moderator', { user: USERS.moderator, imageId: 101, host: 'civitai.com' }],
  ['a viewer the owner blocked', { user: USERS.blockedByOwner, imageId: 103, host: 'civitai.com' }],
  ['an R-rated image on .com', { user: USERS.viewer, imageId: 101, host: 'civitai.com' }],
  ['a POI image', { user: USERS.viewer, imageId: 102, host: 'civitai.com' }],
  ['a signed-out viewer', { user: null, imageId: 101, host: 'civitai.com' }],
];

/** Every procedure call the fake router answered, in order. */
export const procedureCalls: string[] = [];

type FixtureCtx = {
  user?: { id: number; isModerator?: boolean; createdAt?: unknown };
  features?: { canViewNsfw?: boolean };
  domain?: string;
  tokenScope?: number;
  res?: { setHeader?: (name: string, value: string) => unknown };
};

function viewerOf(ctx: FixtureCtx) {
  const createdAt = ctx.user?.createdAt;
  return {
    userId: ctx.user?.id ?? null,
    isModerator: !!ctx.user?.isModerator,
    canViewNsfw: !!ctx.features?.canViewNsfw,
    domain: ctx.domain ?? null,
    tokenScope: ctx.tokenScope ?? null,
    createdAt: createdAt instanceof Date ? 'a Date object' : createdAt ?? null,
  };
}

function privileged(ctx: FixtureCtx, image: FixtureImage) {
  return ctx.user?.id === image.userId || !!ctx.user?.isModerator;
}

function imageFor(id: number) {
  const image = IMAGES[id];
  if (!image) throw new TRPCError({ code: 'NOT_FOUND' });
  return image;
}

export async function buildFixtureRouter() {
  const { router, publicProcedure } = await import('~/server/trpc');
  const byId = z.object({ id: z.number() });

  return router({
    image: router({
      get: publicProcedure.input(byId).query(({ input, ctx: rawCtx }) => {
        const ctx = rawCtx as unknown as FixtureCtx;
        procedureCalls.push('image.get');
        const image = imageFor(input.id);
        if (ctx.user && BLOCKED_BY[image.userId]?.includes(ctx.user.id)) {
          throw new TRPCError({ code: 'NOT_FOUND' });
        }
        if (image.id === CDN_HEADER_IMAGE_ID) {
          ctx.res?.setHeader?.('Cache-Control', 'public, s-maxage=300');
        }
        const canSee =
          privileged(ctx, image) ||
          image.nsfwLevel <= NsfwLevel.PG13 ||
          !!ctx.features?.canViewNsfw;
        return {
          id: image.id,
          nsfwLevel: image.nsfwLevel,
          poi: image.poi,
          user: { id: image.userId },
          url: canSee ? `media-${image.id}` : null,
          name: image.name ?? null,
          type: image.type ?? 'image',
          viewer: viewerOf(ctx),
        };
      }),
      getGenerationData: publicProcedure.input(byId).query(({ input, ctx: rawCtx }) => {
        const ctx = rawCtx as unknown as FixtureCtx;
        procedureCalls.push('image.getGenerationData');
        const image = imageFor(input.id);
        return {
          id: image.id,
          meta: image.poi && !privileged(ctx, image) ? null : { prompt: `prompt-${image.id}` },
          viewer: viewerOf(ctx),
        };
      }),
      getContestCollectionDetails: publicProcedure.input(byId).query(({ input, ctx: rawCtx }) => {
        const ctx = rawCtx as unknown as FixtureCtx;
        procedureCalls.push('image.getContestCollectionDetails');
        const forcedBrowsingLevel = IMAGES[input.id]?.forcedBrowsingLevel;
        return {
          id: input.id,
          viewer: viewerOf(ctx),
          ...(forcedBrowsingLevel
            ? { collectionItems: [{ collection: { metadata: { forcedBrowsingLevel } } }] }
            : {}),
        };
      }),
    }),
    hiddenPreferences: router({
      getHidden: publicProcedure.query(({ ctx: rawCtx }) => {
        const ctx = rawCtx as unknown as FixtureCtx;
        procedureCalls.push('hiddenPreferences.getHidden');
        return { hiddenImages: ctx.user ? [900 + ctx.user.id] : [] };
      }),
    }),
  });
}

/** What `_app` puts on `req.session`: the bootstrap's session after its JSON round trip. */
export const renderSeedFor = (user: FixtureUser | null) =>
  user ? (JSON.parse(JSON.stringify({ user })) as { user: Record<string, unknown> }) : undefined;

export const jsonRoundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** A response double that behaves like Node's: headers are case-insensitive and frozen once sent. */
export function fakeResponse() {
  const headers = new Map<string, unknown>();
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headersSent: false,
    /** Every header write, in order, including ones later overwritten. */
    headerWrites: [] as [string, unknown][],
    setHeader(name: string, value: unknown) {
      if (res.headersSent) throw new Error('ERR_HTTP_HEADERS_SENT');
      res.headerWrites.push([name.toLowerCase(), value]);
      headers.set(name.toLowerCase(), value);
      return res;
    },
    getHeader: (name: string) => headers.get(name.toLowerCase()),
    getHeaders: () => Object.fromEntries(headers),
    removeHeader: (name: string) => headers.delete(name.toLowerCase()),
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      res.headersSent = true;
      return res;
    },
    end() {
      res.headersSent = true;
      return res;
    },
  };
  return res;
}
