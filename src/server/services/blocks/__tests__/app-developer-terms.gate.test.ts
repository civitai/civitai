import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_DEVELOPER_TERMS_VERSION } from '~/shared/constants/app-developer-terms.constants';

const accepted = vi.hoisted(() => new Set<string>());
const db = vi.hoisted(() => ({
  pubReqFindFirst: vi.fn(),
  pubReqUpdateMany: vi.fn(),
  pubReqUpdate: vi.fn(),
  pubReqCreate: vi.fn(),
  appBlockFindUnique: vi.fn(),
}));

vi.mock('~/server/db/client', () => {
  const termsFindUnique = async ({
    where,
  }: {
    where: { userId_version: { userId: number; version: string } };
  }) => {
    const { userId, version } = where.userId_version;
    return accepted.has(`${userId}:${version}`) ? { userId, acceptedAt: new Date() } : null;
  };
  const appDeveloperTermsAcceptance = { findUnique: termsFindUnique };
  return {
    dbRead: { appDeveloperTermsAcceptance, appBlock: { findUnique: db.appBlockFindUnique } },
    dbWrite: {
      appDeveloperTermsAcceptance,
      appBlockPublishRequest: {
        findFirst: db.pubReqFindFirst,
        updateMany: db.pubReqUpdateMany,
        update: db.pubReqUpdate,
        create: db.pubReqCreate,
      },
    },
  };
});
vi.mock('~/env/server', () => ({ env: { NEXTAUTH_URL: 'https://civitai.com' } }));
const listingOwner = vi.hoisted(() => ({ id: 0 }));
// Hand-listed: the real module needs a database at load, and this is its only export reached here.
vi.mock('~/server/services/blocks/app-access.service', () => ({
  resolveListingAccess: vi.fn(async () => ({ ownerUserId: listingOwner.id })),
}));

const DEV = 42;
const OWNER = 7;

beforeEach(() => {
  accepted.clear();
  vi.clearAllMocks();
  db.pubReqFindFirst.mockResolvedValue(null);
  db.appBlockFindUnique.mockResolvedValue({ app: { userId: OWNER } });
});

describe('App Developer Terms: publishing is refused server-side until accepted', () => {
  it('submitVersion (web and CLI upload) refuses a developer who has not accepted, naming the terms and where to accept', async () => {
    const { submitVersion } = await import('../publish-request.service');
    const run = submitVersion({
      bundleBuffer: Buffer.alloc(0),
      submittedByUserId: DEV,
      submitterIsModerator: false,
    });
    await expect(run).rejects.toThrow(
      'Accept the App Developer Terms (https://civitai.com/content/app-developer-terms) on the web at https://civitai.com/apps/submit'
    );
  });

  it('CONTROL: once the current version is accepted, submitVersion gets past the gate (to the bundle check)', async () => {
    accepted.add(`${DEV}:${APP_DEVELOPER_TERMS_VERSION}`);
    const { submitVersion } = await import('../publish-request.service');
    const run = submitVersion({
      bundleBuffer: Buffer.alloc(0),
      submittedByUserId: DEV,
      submitterIsModerator: false,
    });
    await expect(run).rejects.toThrow('bundle is empty');
  });

  it('a version bump asks again: acceptance of an older version does not count', async () => {
    accepted.add(`${DEV}:0`);
    const { submitVersion } = await import('../publish-request.service');
    const run = submitVersion({
      bundleBuffer: Buffer.alloc(0),
      submittedByUserId: DEV,
      submitterIsModerator: false,
    });
    await expect(run).rejects.toThrow('Accept the App Developer Terms');
  });

  it('a git push by an owner who has not accepted records nothing and withdraws none of their pending requests', async () => {
    const { recordPendingFromPush } = await import('../publish-request.service');
    const run = recordPendingFromPush({
      slug: 'my-app',
      sha: 'abc1234',
      appBlockId: 'ab_1',
      manifest: {},
      version: '1.0.1',
    });
    await expect(run).rejects.toThrow('Accept the App Developer Terms');
    expect(db.pubReqUpdateMany).toHaveBeenCalledTimes(0);
    expect(db.pubReqCreate).toHaveBeenCalledTimes(0);
  });

  it('a redelivered push of an already-pending sha is refused too, leaving that pending row untouched', async () => {
    db.pubReqFindFirst.mockResolvedValue({ id: 'pubreq_existing' });
    const { recordPendingFromPush } = await import('../publish-request.service');
    const run = recordPendingFromPush({
      slug: 'my-app',
      sha: 'abc1234',
      appBlockId: 'ab_1',
      manifest: {},
      version: '1.0.1',
    });
    await expect(run).rejects.toThrow('Accept the App Developer Terms');
    expect(db.pubReqUpdate).toHaveBeenCalledTimes(0);
  });

  it('CONTROL: the same push from an owner who accepted is recorded', async () => {
    accepted.add(`${OWNER}:${APP_DEVELOPER_TERMS_VERSION}`);
    const { recordPendingFromPush } = await import('../publish-request.service');
    await recordPendingFromPush({
      slug: 'my-app',
      sha: 'abc1234',
      appBlockId: 'ab_1',
      manifest: {},
      version: '1.0.1',
    }).catch(() => undefined);
    expect(db.pubReqUpdateMany).toHaveBeenCalledTimes(1);
    expect(db.pubReqCreate).toHaveBeenCalledTimes(1);
  });

  it('tRPC publish paths get a FORBIDDEN the client can show, not a masked 500', async () => {
    const { assertAcceptedAppDeveloperTermsTrpc } = await import('../app-developer-terms.service');
    const err = await assertAcceptedAppDeveloperTermsTrpc(DEV).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe('FORBIDDEN');
    expect((err as TRPCError).message).toContain('/content/app-developer-terms');
  });
});

// Developers who accepted version N are never asked again until the version changes, so an edit to
// the terms text that does not bump APP_DEVELOPER_TERMS_VERSION binds them to words they never saw.
// Changed the text? Bump the version (a material change) and add its hash here. Filling in the
// "Last updated" date does not count: that line is outside the hash.
const TERMS_BODY_SHA256_BY_VERSION: Record<string, string> = {
  '1': '9819c3f35b73c474d837fc0ed465d594bf78bfe9b9c30777e082a79f6210654a',
};

describe('App Developer Terms: the listing owner, for an editor or a moderator acting on it', () => {
  it('refuses while the canonical owner has not accepted, with the terms URL', async () => {
    listingOwner.id = OWNER;
    const { assertListingOwnerAcceptedAppDeveloperTerms } = await import(
      '../app-developer-terms.service'
    );
    const err = await assertListingOwnerAcceptedAppDeveloperTerms('apl_1', DEV).catch(
      (e: unknown) => e
    );
    expect((err as TRPCError).code).toBe('FORBIDDEN');
    expect((err as TRPCError).message).toContain('/content/app-developer-terms');
  });

  it('CONTROL: passes once that owner accepts', async () => {
    listingOwner.id = OWNER;
    accepted.add(`${OWNER}:${APP_DEVELOPER_TERMS_VERSION}`);
    const { assertListingOwnerAcceptedAppDeveloperTerms } = await import(
      '../app-developer-terms.service'
    );
    await expect(
      assertListingOwnerAcceptedAppDeveloperTerms('apl_1', DEV)
    ).resolves.toBeUndefined();
  });
});

describe('App Developer Terms text is pinned to its version', () => {
  it('the published terms body is the text of the current version', () => {
    // A Windows checkout may carry CRLF; the text is the same.
    const md = readFileSync(
      join(process.cwd(), 'src/static-content/app-developer-terms.md'),
      'utf8'
    ).replace(/\r\n/g, '\n');
    const body = md.slice(md.indexOf('\n', md.indexOf('Last updated:')) + 1);
    const sha = createHash('sha256').update(body).digest('hex');
    expect(sha).toBe(TERMS_BODY_SHA256_BY_VERSION[APP_DEVELOPER_TERMS_VERSION]);
  });
});
