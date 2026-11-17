import JSZip from 'jszip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ManifestSubmitValidation from '~/server/services/blocks/manifest-submit-validation';
import type * as GithubActionsOidc from '~/server/services/blocks/github-actions-oidc.service';
import type * as ActionsRunSourceService from '~/server/services/blocks/actions-run-source.service';
import type * as AppDeveloperTermsService from '~/server/services/blocks/app-developer-terms.service';
import type { ActionsRunSource } from '~/server/schema/blocks/actions-run-source.schema';

/**
 * The seam between `submitVersion` and GitHub Actions OIDC verification, through the real submit
 * pipeline (zip parse, manifest checks, request create) over the canonical db mock. Verification
 * itself is pinned in `github-actions-oidc.service.test.ts`; here it is a stub, so the assertions
 * are about WHEN submit calls it, WITH WHAT, and what a refusal or a failed write does to the
 * submit.
 */

const m = vi.hoisted(() => ({
  verify: vi.fn(),
  write: vi.fn(),
  pin: vi.fn(),
  putObject: vi.fn(),
}));

vi.mock('~/server/services/blocks/manifest-submit-validation', async (importOriginal) => ({
  ...(await importOriginal<typeof ManifestSubmitValidation>()),
  assertManifestValidAtSubmit: vi.fn(async () => undefined),
}));
vi.mock('~/utils/bundle-s3', () => ({
  bundleKey: (sha: string) => `bundles/${sha}.zip`,
  getBundleBucket: () => 'bundle-bucket-test',
  getBundleS3Client: () => ({ send: m.putObject }),
}));
vi.mock('~/server/services/blocks/forgejo.service', () => ({
  ensureReviewRepo: vi.fn().mockResolvedValue(undefined),
  commitFiles: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/services/blocks/github-actions-oidc.service', async (importOriginal) => ({
  ...(await importOriginal<typeof GithubActionsOidc>()),
  verifyGithubActionsOidcToken: m.verify,
}));
vi.mock('~/server/services/blocks/actions-run-source.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ActionsRunSourceService>()),
  writeActionsRunSource: m.write,
  assertActionsRunRepositoryPinned: m.pin,
}));
vi.mock('~/server/services/blocks/app-developer-terms.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppDeveloperTermsService>()),
  hasAcceptedAppDeveloperTerms: vi.fn(async () => true),
  assertAcceptedAppDeveloperTerms: vi.fn(async () => undefined),
  assertAcceptedAppDeveloperTermsTrpc: vi.fn(async () => undefined),
  assertOwnerAcceptedAppDeveloperTerms: vi.fn(async () => undefined),
  assertListingOwnerAcceptedAppDeveloperTerms: vi.fn(async () => undefined),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';

const { submitVersion } = await import('~/server/services/blocks/publish-request.service');
const { GithubActionsOidcRefusal } = await import(
  '~/server/services/blocks/github-actions-oidc.service'
);

const SLUG = 'tide-chart-oidc-7e21';
const VERSION = '2.3.4';
const SUBMITTER_ID = 9311;
const CLAIMED_SHA = '9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b';
const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl';

const SOURCE: ActionsRunSource = {
  repository: 'tidal-labs/tide-chart',
  repositoryId: '845120931',
  repositoryOwnerId: '6610023',
  sha: CLAIMED_SHA,
  ref: `refs/tags/v${VERSION}`,
  workflowRef: `tidal-labs/tide-chart/.github/workflows/release.yml@refs/tags/v${VERSION}`,
  repositoryVisibility: 'public',
  runId: '7012398765',
};

async function bundle(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    'block.manifest.json',
    JSON.stringify({ blockId: SLUG, version: VERSION, name: 'Tide Chart' })
  );
  zip.file('index.html', '<!doctype html><html><body>tides</body></html>');
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  m.putObject.mockResolvedValue({});
  m.verify.mockResolvedValue(SOURCE);
  m.write.mockResolvedValue(true);
  m.pin.mockResolvedValue(undefined);
  dbMock.dbRead.appBlock.findFirst.mockResolvedValue(null);
  dbMock.dbRead.appBlockPublishRequest.findFirst.mockResolvedValue(null);
  dbMock.dbRead.appListing.findFirst.mockResolvedValue(null);
  dbMock.dbRead.appListingPublishRequest.findFirst.mockResolvedValue(null);
});

describe('submitVersion — GitHub Actions OIDC token', () => {
  it('verifies against the MANIFEST version and the claimed sha, then stores the run on the new request', async () => {
    const result = await submitVersion({
      bundleBuffer: await bundle(),
      submittedByUserId: SUBMITTER_ID,
      submitterIsModerator: false,
      sourceCommit: CLAIMED_SHA,
      githubOidcToken: TOKEN,
    });
    expect(m.verify).toHaveBeenCalledTimes(1);
    expect(m.verify).toHaveBeenCalledWith(TOKEN, {
      manifestVersion: VERSION,
      sourceCommit: CLAIMED_SHA,
    });
    expect(m.write).toHaveBeenCalledTimes(1);
    expect(m.write).toHaveBeenCalledWith(expect.anything(), result.publishRequestId, SOURCE);
    expect(result.actionsRunSourceRecorded).toBe(true);
    // The claim is stored as the claim; the run never overwrites or fills it.
    expect(dbMock.dbWrite.appBlockPublishRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sourceCommit: CLAIMED_SHA }),
      })
    );
  });

  it('a refused token refuses the submit before anything is uploaded or created', async () => {
    m.verify.mockRejectedValue(
      new GithubActionsOidcRefusal('tag-version-mismatch', 'tag v9.9.9 does not match')
    );
    await expect(
      submitVersion({
        bundleBuffer: await bundle(),
        submittedByUserId: SUBMITTER_ID,
        submitterIsModerator: false,
        githubOidcToken: TOKEN,
      })
    ).rejects.toBeInstanceOf(GithubActionsOidcRefusal);
    expect(m.putObject).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.appBlockPublishRequest.create).not.toHaveBeenCalled();
    expect(m.write).not.toHaveBeenCalled();
  });

  it("checks the verified run against THIS app's repository pin", async () => {
    await submitVersion({
      bundleBuffer: await bundle(),
      submittedByUserId: SUBMITTER_ID,
      submitterIsModerator: false,
      githubOidcToken: TOKEN,
    });
    expect(m.pin).toHaveBeenCalledTimes(1);
    expect(m.pin).toHaveBeenCalledWith(expect.anything(), SLUG, SOURCE);
  });

  it('a token from another repository than the pinned one refuses the submit before any upload', async () => {
    m.pin.mockRejectedValue(
      new GithubActionsOidcRefusal('repository-mismatch', 'expected tidal-labs/tide-chart', 409)
    );
    await expect(
      submitVersion({
        bundleBuffer: await bundle(),
        submittedByUserId: SUBMITTER_ID,
        submitterIsModerator: false,
        githubOidcToken: TOKEN,
      })
    ).rejects.toMatchObject({ reason: 'repository-mismatch', status: 409 });
    expect(m.putObject).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.appBlockPublishRequest.create).not.toHaveBeenCalled();
    expect(m.write).not.toHaveBeenCalled();
  });

  it('no token: nothing is verified or stored, and the response says nothing about it', async () => {
    const result = await submitVersion({
      bundleBuffer: await bundle(),
      submittedByUserId: SUBMITTER_ID,
      submitterIsModerator: false,
    });
    expect(m.verify).not.toHaveBeenCalled();
    expect(m.pin).not.toHaveBeenCalled();
    expect(m.write).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('actionsRunSourceRecorded');
  });

  it('columns absent: the verified run is not recorded, and the submit still succeeds', async () => {
    m.write.mockResolvedValue(false);
    const result = await submitVersion({
      bundleBuffer: await bundle(),
      submittedByUserId: SUBMITTER_ID,
      submitterIsModerator: false,
      githubOidcToken: TOKEN,
    });
    expect(result.publishRequestId).toMatch(/^pubreq_/);
    expect(result.actionsRunSourceRecorded).toBe(false);
  });
});
