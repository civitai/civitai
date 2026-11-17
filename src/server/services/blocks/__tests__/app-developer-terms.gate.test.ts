import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { TRPCError } from '@trpc/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { APP_DEVELOPER_TERMS_VERSION } from '~/shared/constants/app-developer-terms.constants';

const accepted = new Set<string>();
const termsFindUnique = async ({
  where,
}: {
  where: { userId_version: { userId: number; version: string } };
}) => {
  const { userId, version } = where.userId_version;
  return accepted.has(`${userId}:${version}`) ? { userId, acceptedAt: new Date() } : null;
};
const db = {
  pubReqFindFirst: dbMock.dbWrite.appBlockPublishRequest.findFirst,
  pubReqUpdateMany: dbMock.dbWrite.appBlockPublishRequest.updateMany,
  pubReqUpdate: dbMock.dbWrite.appBlockPublishRequest.update,
  pubReqCreate: dbMock.dbWrite.appBlockPublishRequest.create,
  appBlockFindUnique: dbMock.dbRead.appBlock.findUnique,
};

vi.mock('~/env/server', () => ({ env: { NEXTAUTH_URL: 'https://civitai.com' } }));
const listingOwner = vi.hoisted(() => ({ id: 0 }));
vi.mock('~/server/services/blocks/app-access.service', () => ({
  resolveListingAccess: vi.fn(async () => ({ ownerUserId: listingOwner.id })),
}));
// A recorded push starts its new-submission alert and its diff enrichment without awaiting them.
// Left running, they log after the file ends, and a log in flight as the worker closes fails the
// run with EnvironmentTeardownError. Neither is under test: both are stubbed to settle at once, and
// each test that records a push waits for them (settlePushBackgroundWork).
const background = vi.hoisted(() => ({ onNewPendingSubmission: vi.fn(async () => undefined) }));
vi.mock('~/server/services/blocks/review-autodeploy.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  onNewPendingSubmission: background.onNewPendingSubmission,
}));
vi.mock('~/server/services/blocks/forgejo.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listRepoTreeAtRef: vi.fn(async () => {
    throw new Error('no Forgejo in this test');
  }),
}));
const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
// Loaded up front, so the wait below covers only the stubs settling, not a cold module import.
beforeAll(async () => {
  await import('~/server/services/blocks/review-autodeploy.service');
  await import('~/server/services/blocks/forgejo.service');
});

async function settlePushBackgroundWork() {
  await vi.waitFor(() => {
    expect(background.onNewPendingSubmission).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('[push-enrich] failed'),
      expect.stringContaining('no Forgejo in this test')
    );
  });
}

const DEV = 42;
const OWNER = 7;

beforeEach(() => {
  accepted.clear();
  vi.clearAllMocks();
  dbMock.dbRead.appDeveloperTermsAcceptance.findUnique.mockImplementation(termsFindUnique as never);
  dbMock.dbWrite.appDeveloperTermsAcceptance.findUnique.mockImplementation(
    termsFindUnique as never
  );
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
    await settlePushBackgroundWork();
  });

  it('a push by a collaborator who has not accepted is refused although the owner has, changing no pending request', async () => {
    accepted.add(`${OWNER}:${APP_DEVELOPER_TERMS_VERSION}`);
    const { recordPendingFromPush } = await import('../publish-request.service');
    const run = recordPendingFromPush({
      slug: 'my-app',
      sha: 'abc1234',
      appBlockId: 'ab_1',
      manifest: {},
      version: '1.0.1',
      pusherUserId: DEV,
    });
    await expect(run).rejects.toThrow('Accept the App Developer Terms');
    expect(db.pubReqUpdateMany).toHaveBeenCalledTimes(0);
    expect(db.pubReqCreate).toHaveBeenCalledTimes(0);
  });

  it('CONTROL: the same collaborator push is recorded once the collaborator accepts', async () => {
    accepted.add(`${OWNER}:${APP_DEVELOPER_TERMS_VERSION}`);
    accepted.add(`${DEV}:${APP_DEVELOPER_TERMS_VERSION}`);
    const { recordPendingFromPush } = await import('../publish-request.service');
    await recordPendingFromPush({
      slug: 'my-app',
      sha: 'abc1234',
      appBlockId: 'ab_1',
      manifest: {},
      version: '1.0.1',
      pusherUserId: DEV,
    }).catch(() => undefined);
    expect(db.pubReqCreate).toHaveBeenCalledTimes(1);
    await settlePushBackgroundWork();
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
  '1': '83c7c7149c91c29a9d7b437b00d8ade09c64d7d7dffe7318843f1c67dbc4f1b1',
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

  it('is skipped when the owner is the acting user, whose own acceptance the caller checks', async () => {
    listingOwner.id = DEV;
    const { assertListingOwnerAcceptedAppDeveloperTerms } = await import(
      '../app-developer-terms.service'
    );
    await expect(
      assertListingOwnerAcceptedAppDeveloperTerms('apl_1', DEV)
    ).resolves.toBeUndefined();
    await expect(assertListingOwnerAcceptedAppDeveloperTerms('apl_1')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
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
