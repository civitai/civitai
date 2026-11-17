import { beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import type * as AppDeveloperTermsService from '~/server/services/blocks/app-developer-terms.service';
import type * as ReviewAutodeployService from '~/server/services/blocks/review-autodeploy.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { envMock } from '~/__tests__/mocks/env.mock';

/**
 * `submitVersion`, through the real pipeline and the REAL BlockManifestValidator:
 *   - the deep manifest validation approve runs now refuses at submit, with every error, before
 *     anything is stored, against the same OAuth context approve uses;
 *   - a successful submit hands the new pending request to the follow-ups (moderator alert +
 *     automatic review preview) exactly once, and a throw there cannot fail the submit.
 */

vi.mock('~/server/services/blocks/app-developer-terms.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppDeveloperTermsService>()),
  hasAcceptedAppDeveloperTerms: vi.fn(async () => true),
  assertAcceptedAppDeveloperTerms: vi.fn(async () => undefined),
  assertAcceptedAppDeveloperTermsTrpc: vi.fn(async () => undefined),
  assertOwnerAcceptedAppDeveloperTerms: vi.fn(async () => undefined),
  assertListingOwnerAcceptedAppDeveloperTerms: vi.fn(async () => undefined),
}));

// The canonical db mock (src/__tests__/mocks/db.mock.ts): unset reads answer null / [].
const db = {
  createPublishRequest: dbMock.dbWrite.appBlockPublishRequest.create,
  pubReqFindFirst: dbMock.dbRead.appBlockPublishRequest.findFirst,
  appBlockFindFirst: dbMock.dbRead.appBlock.findFirst,
  appListingFindFirst: dbMock.dbRead.appListing.findFirst,
  appListingCreate: dbMock.dbWrite.appListing.create,
};

const storage = vi.hoisted(() => ({ commitFiles: vi.fn(async () => undefined) }));
vi.mock('~/utils/bundle-s3', () => ({
  bundleKey: (sha: string) => `bundles/${sha}.zip`,
  getBundleBucket: () => 'test-bucket',
  getBundleS3Client: () => ({ send: vi.fn().mockResolvedValue({}) }),
}));
vi.mock('~/server/services/blocks/forgejo.service', () => ({
  ensureReviewRepo: vi.fn().mockResolvedValue(undefined),
  commitFiles: storage.commitFiles,
}));

const followUps = vi.hoisted(() => ({
  onNewPendingSubmission: vi.fn(async (..._a: unknown[]): Promise<void> => undefined),
}));
vi.mock('~/server/services/blocks/review-autodeploy.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ReviewAutodeployService>()),
  onNewPendingSubmission: (...a: unknown[]) => followUps.onNewPendingSubmission(...a),
}));

const { submitVersion } = await import('~/server/services/blocks/publish-request.service');
const { ManifestValidationRefusal } = await import(
  '~/server/services/blocks/manifest-submit-validation'
);

const VALID = {
  blockId: 'my-app',
  version: '0.1.0',
  name: 'My App',
  contentRating: 'g',
  scopes: [],
  iframe: { minHeight: 300, maxHeight: 800, resizable: true, sandbox: 'allow-scripts' },
  page: { path: '/', title: 'My App' },
};

/** The submit refusal for a manifest with no surface, spelled as a literal. */
const NO_SURFACE =
  'manifest must declare at least one surface: add a "page" object for a full-page app ' +
  '(e.g. "page": { "path": "/", "title": "My App" }), or a non-empty "targets" array for a ' +
  'model-page slot app (e.g. "targets": [{ "slotId": "model.sidebar_top" }])';

async function bundle(manifest: Record<string, unknown>): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('block.manifest.json', JSON.stringify(manifest));
  zip.file('index.html', '<!doctype html><html><body>hi</body></html>');
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}

const flush = () => new Promise((r) => setTimeout(r, 0));
/** A resolved submit's follow-up lands later, behind a dynamic import: let it land inside the
 *  test that caused it, so it cannot be counted by the next one. */
const settleFollowUps = () =>
  vi.waitFor(() => expect(followUps.onNewPendingSubmission).toHaveBeenCalled(), {
    timeout: 15_000,
  });

beforeEach(() => {
  vi.clearAllMocks();
  envMock.set({ APPS_DOMAIN: 'civit.ai' });
  db.pubReqFindFirst.mockResolvedValue(null);
  db.appBlockFindFirst.mockResolvedValue(null);
  db.appListingFindFirst.mockResolvedValue(null);
  db.createPublishRequest.mockResolvedValue({});
  db.appListingCreate.mockResolvedValue({ id: 'apl_draft' });
  followUps.onNewPendingSubmission.mockReset();
  followUps.onNewPendingSubmission.mockResolvedValue(undefined);
});

describe('submitVersion — deep manifest validation at submit', () => {
  it('CONTROL: a manifest approve would accept is queued', async () => {
    const result = await submitVersion({
      bundleBuffer: await bundle(VALID),
      submittedByUserId: 1,
      submitterIsModerator: false,
    });
    expect(result.slug).toBe('my-app');
    expect(db.createPublishRequest).toHaveBeenCalledTimes(1);
    await settleFollowUps();
  });

  it('refuses a manifest approve would refuse, with EVERY validator error, before anything is stored', async () => {
    const { iframe: _drop, contentRating: _rating, ...noIframe } = VALID;
    const run = submitVersion({
      bundleBuffer: await bundle(noIframe),
      submittedByUserId: 1,
      submitterIsModerator: false,
    });

    const err = await run.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ManifestValidationRefusal);
    const errors = (err as InstanceType<typeof ManifestValidationRefusal>).errors;
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^contentRating must be one of /),
        'iframe.minHeight must be a number in [40, 4000]',
        'iframe.resizable must be a boolean',
        'iframe.sandbox must be a non-empty string',
      ])
    );
    // Refused before the review-repo push and the row insert.
    expect(storage.commitFiles).not.toHaveBeenCalled();
    expect(db.createPublishRequest).not.toHaveBeenCalled();
    expect(followUps.onNewPendingSubmission).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, unknown>]>([
    ['neither key', {}],
    ['an empty targets array', { targets: [] }],
    ['a null page', { page: null }],
    ['an empty targets array and an array page', { targets: [], page: [] }],
  ])('refuses a manifest with no surface (%s), naming the keys to add', async (_case, extra) => {
    const { page: _page, ...noSurface } = VALID;
    const err = await submitVersion({
      bundleBuffer: await bundle({ ...noSurface, ...extra }),
      submittedByUserId: 1,
      submitterIsModerator: false,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ManifestValidationRefusal);
    expect((err as InstanceType<typeof ManifestValidationRefusal>).errors).toContain(NO_SURFACE);
    expect(storage.commitFiles).not.toHaveBeenCalled();
    expect(db.createPublishRequest).not.toHaveBeenCalled();
  });

  it('CONTROL: a slot-only manifest (non-empty targets, no page) is queued', async () => {
    const { page: _page, ...noPage } = VALID;
    await expect(
      submitVersion({
        bundleBuffer: await bundle({ ...noPage, targets: [{ slotId: 'model.sidebar_top' }] }),
        submittedByUserId: 1,
        submitterIsModerator: false,
      })
    ).resolves.toMatchObject({ slug: 'my-app' });
    await settleFollowUps();
  });

  it('a subsequent version is validated against the LIVE client’s origins, as at approve', async () => {
    // The app's client only registers some other origin, so the canonical iframe.src (stamped
    // onto every submit) is not bound to it: approve would refuse this, so submit does too.
    db.appBlockFindFirst.mockResolvedValue({
      id: 'apb_1',
      appId: 'app_1',
      trustTier: 'unverified',
      app: { userId: 1, allowedOrigins: ['https://elsewhere.civit.ai'] },
    });
    const err = await submitVersion({
      bundleBuffer: await bundle({ ...VALID, version: '0.2.0' }),
      submittedByUserId: 1,
      submitterIsModerator: true,
    }).catch((e: unknown) => e);
    expect((err as InstanceType<typeof ManifestValidationRefusal>).errors).toContain(
      'iframe.src rejected: origin https://my-app.civit.ai not in OauthClient.allowedOrigins'
    );
    expect(db.createPublishRequest).not.toHaveBeenCalled();
  });

  it('CONTROL: the same subsequent version passes when the live client registers its origin', async () => {
    db.appBlockFindFirst.mockResolvedValue({
      id: 'apb_1',
      appId: 'app_1',
      trustTier: 'unverified',
      app: { userId: 1, allowedOrigins: ['https://MY-APP.civit.ai'] },
    });
    await expect(
      submitVersion({
        bundleBuffer: await bundle({ ...VALID, version: '0.2.0' }),
        submittedByUserId: 1,
        submitterIsModerator: true,
      })
    ).resolves.toMatchObject({ slug: 'my-app' });
    await settleFollowUps();
  });

  it('validates against the SERVER-owned trust tier, not one the manifest declares', async () => {
    // allow-popups is refused for an unverified app and allowed for an internal one: declaring
    // `internal` in the manifest must not lift it for a new (unverified) app.
    const err = await submitVersion({
      bundleBuffer: await bundle({
        ...VALID,
        trustTier: 'internal',
        iframe: { ...VALID.iframe, sandbox: 'allow-scripts allow-popups' },
      }),
      submittedByUserId: 1,
      submitterIsModerator: false,
    }).catch((e: unknown) => e);
    expect((err as InstanceType<typeof ManifestValidationRefusal>).errors).toContain(
      'sandbox token "allow-popups" is not allowed for trustTier=unverified'
    );
    expect(db.createPublishRequest).not.toHaveBeenCalled();
  });
});

describe('submitVersion — follow-ups of a new pending request', () => {
  it('hands the new request to the follow-ups exactly once', async () => {
    const result = await submitVersion({
      bundleBuffer: await bundle(VALID),
      submittedByUserId: 1,
      submitterIsModerator: false,
    });
    // Fire-and-forget behind a dynamic import: wait for it rather than for one tick.
    await vi.waitFor(() => expect(followUps.onNewPendingSubmission).toHaveBeenCalled(), {
      timeout: 15_000,
    });
    await flush();
    expect(followUps.onNewPendingSubmission).toHaveBeenCalledTimes(1);
    expect(followUps.onNewPendingSubmission).toHaveBeenCalledWith({
      publishRequestId: result.publishRequestId,
      slug: 'my-app',
      version: '0.1.0',
      appName: 'My App',
      submittedByUserId: 1,
      origin: 'upload',
    });
  });

  it.each([
    [
      'throws',
      () => {
        throw new Error('trigger exploded');
      },
    ],
    [
      'rejects',
      async () => {
        throw new Error('trigger exploded');
      },
    ],
  ])('a follow-up that %s cannot fail the submit', async (_how, impl) => {
    followUps.onNewPendingSubmission.mockImplementation(impl as () => Promise<void>);
    await expect(
      submitVersion({
        bundleBuffer: await bundle(VALID),
        submittedByUserId: 1,
        submitterIsModerator: false,
      })
    ).resolves.toMatchObject({ slug: 'my-app' });
    // Fire-and-forget behind a dynamic import: wait for it rather than for one tick.
    await vi.waitFor(() => expect(followUps.onNewPendingSubmission).toHaveBeenCalled(), {
      timeout: 15_000,
    });
    await flush();
    expect(followUps.onNewPendingSubmission).toHaveBeenCalledTimes(1);
  });
});
