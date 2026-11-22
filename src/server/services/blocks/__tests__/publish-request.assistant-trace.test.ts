import JSZip from 'jszip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ManifestSubmitValidation from '~/server/services/blocks/manifest-submit-validation';
vi.mock('~/server/services/blocks/manifest-submit-validation', async (importOriginal) => ({
  ...(await importOriginal<typeof ManifestSubmitValidation>()),
  assertManifestValidAtSubmit: vi.fn(async () => undefined),
}));
import type * as AppDeveloperTermsService from '~/server/services/blocks/app-developer-terms.service';

/**
 * App Assistant session tracing at submit: `submitVersion` fires `recordSubmissionTrace` once the
 * request exists, and NOTHING the trace does can fail or hold up the submit. Runs the real submit
 * pipeline over the canonical db / redis mocks; MinIO and Forgejo are stubbed, and the trace hook is
 * a spy whose behaviour each case sets.
 */

const m = vi.hoisted(() => ({
  trace: vi.fn<(input: Record<string, unknown>) => Promise<void>>(),
}));

vi.mock('~/utils/bundle-s3', () => ({
  bundleKey: (sha: string) => `bundles/${sha}.zip`,
  getBundleBucket: () => 'bundle-bucket-test',
  getBundleS3Client: () => ({ send: vi.fn().mockResolvedValue({}) }),
}));
vi.mock('~/server/services/blocks/forgejo.service', () => ({
  ensureReviewRepo: vi.fn().mockResolvedValue(undefined),
  commitFiles: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/services/app-assistant/submission-trace.service', () => ({
  recordSubmissionTrace: m.trace,
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

const SLUG = 'traced-theme-app';
const SUBMITTER_ID = 7713;

async function bundle(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    'block.manifest.json',
    JSON.stringify({ blockId: SLUG, version: '0.2.0', name: 'Traced Theme App' })
  );
  zip.file('index.html', '<!doctype html><html><body>traced</body></html>');
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}

/** Lets the fired-and-forgotten import + hook run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.appBlock.findFirst.mockResolvedValue(null);
  dbMock.dbRead.appBlockPublishRequest.findFirst.mockResolvedValue(null);
  dbMock.dbRead.appListing.findFirst.mockResolvedValue(null);
  dbMock.dbRead.appListingPublishRequest.findFirst.mockResolvedValue(null);
});

describe('submitVersion — App Assistant session trace', () => {
  it('fires the trace once with the new request, the slug, the submitter and the bundle', async () => {
    m.trace.mockResolvedValue(undefined);
    const buffer = await bundle();
    const result = await submitVersion({ bundleBuffer: buffer, submittedByUserId: SUBMITTER_ID });
    await settle();
    expect(m.trace).toHaveBeenCalledTimes(1);
    expect(m.trace).toHaveBeenCalledWith({
      publishRequestId: result.publishRequestId,
      slug: SLUG,
      submittedByUserId: SUBMITTER_ID,
      bundleBuffer: buffer,
    });
  });

  it('a trace that rejects never fails the submit', async () => {
    m.trace.mockRejectedValue(new Error('snapshot store down'));
    const result = await submitVersion({
      bundleBuffer: await bundle(),
      submittedByUserId: SUBMITTER_ID,
    });
    await settle();
    expect(result).toMatchObject({ slug: SLUG });
    expect(m.trace).toHaveBeenCalledTimes(1);
  });

  it('a trace that throws at once never fails the submit', async () => {
    m.trace.mockImplementation(() => {
      throw new Error('boom');
    });
    await expect(
      submitVersion({ bundleBuffer: await bundle(), submittedByUserId: SUBMITTER_ID })
    ).resolves.toMatchObject({ slug: SLUG });
  });

  it('a trace that never settles never holds the submit up', async () => {
    m.trace.mockImplementation(() => new Promise<void>(() => undefined));
    const outcome = await Promise.race([
      submitVersion({ bundleBuffer: await bundle(), submittedByUserId: SUBMITTER_ID }).then(
        () => 'submitted'
      ),
      new Promise((resolve) => setTimeout(() => resolve('held up'), 5_000)),
    ]);
    expect(outcome).toBe('submitted');
  });
});
