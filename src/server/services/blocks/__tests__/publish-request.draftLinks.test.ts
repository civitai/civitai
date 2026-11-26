import { beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import type * as AppDeveloperTermsService from '~/server/services/blocks/app-developer-terms.service';
import type * as ManifestSubmitValidation from '~/server/services/blocks/manifest-submit-validation';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { envMock } from '~/__tests__/mocks/env.mock';

/**
 * Draft-at-submit carries the manifest's `repository` / `bugs` links.
 *
 * An on-site listing's links are manifest-governed exactly like its name / tagline /
 * description: approve re-syncs them from the manifest. Before this, the draft minted at a
 * FIRST-version submit carried the copy scalars but not the links, so a new app's draft showed
 * both links empty until approve although its manifest declared them.
 *
 * Both columns are manual-apply: `source_repo_url` rides the Prisma create (key omitted when
 * the column is absent); `issue_tracker_url` is a no-type column written by raw SQL after it.
 */

vi.mock('~/server/services/blocks/app-developer-terms.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppDeveloperTermsService>()),
  hasAcceptedAppDeveloperTerms: vi.fn(async () => true),
  assertAcceptedAppDeveloperTerms: vi.fn(async () => undefined),
  assertAcceptedAppDeveloperTermsTrpc: vi.fn(async () => undefined),
  assertOwnerAcceptedAppDeveloperTerms: vi.fn(async () => undefined),
  assertListingOwnerAcceptedAppDeveloperTerms: vi.fn(async () => undefined),
}));
// Deep manifest validation is pinned in publish-request.submitValidation.test.ts.
vi.mock('~/server/services/blocks/manifest-submit-validation', async (importOriginal) => ({
  ...(await importOriginal<typeof ManifestSubmitValidation>()),
  assertManifestValidAtSubmit: vi.fn(async () => undefined),
}));
vi.mock('~/utils/bundle-s3', () => ({
  bundleKey: (sha: string) => `bundles/${sha}.zip`,
  getBundleBucket: () => 'test-bucket',
  getBundleS3Client: () => ({ send: vi.fn().mockResolvedValue({}) }),
}));
vi.mock('~/server/services/blocks/forgejo.service', () => ({
  ensureReviewRepo: vi.fn().mockResolvedValue(undefined),
  commitFiles: vi.fn().mockResolvedValue(undefined),
}));

const { submitVersion } = await import('~/server/services/blocks/publish-request.service');

const read = dbMock.dbRead;
const write = dbMock.dbWrite;

// Pairwise-distinct, and the raw spellings differ from the stored (normalised) ones, so a
// mutant that copies the raw manifest string is visible.
const RAW_REPO = 'https://GITHUB.com/civitai/my-app.git/';
const STORED_REPO = 'https://github.com/civitai/my-app';
const BUGS = 'https://tracker.example.com/my-app/issues';

const BASE = { blockId: 'my-app', version: '0.1.0', name: 'My App', scopes: [] };

async function bundle(manifest: Record<string, unknown>): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('block.manifest.json', JSON.stringify(manifest));
  zip.file('index.html', '<!doctype html><html><body>hi</body></html>');
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}

const missingColumn = (code: string) => Object.assign(new Error('column does not exist'), { code });

/** The SQL text of a tagged-template raw call. */
const sqlOf = (call: unknown[]) => (call[0] as readonly string[]).join('?');

/** Is this `findUnique` the source-repo column read (select is exactly `{ sourceRepoUrl }`)? */
function isSourceRepoRead(args: { select?: Record<string, unknown> }): boolean {
  const select = args?.select ?? {};
  return select.sourceRepoUrl === true && Object.keys(select).length === 1;
}

type Columns = {
  sourceRepo: 'present' | 'missing' | 'broken';
  issueTracker: 'present' | 'missing' | 'broken';
};

function armColumns({ sourceRepo, issueTracker }: Columns) {
  write.appListing.findUnique.mockImplementation(
    async (args: { select?: Record<string, unknown> }) => {
      if (isSourceRepoRead(args)) {
        if (sourceRepo === 'missing') throw missingColumn('P2022');
        if (sourceRepo === 'broken') throw new Error('connection reset');
      }
      return null;
    }
  );
  write.$queryRaw.mockImplementation(async (...call: unknown[]) => {
    if (sqlOf(call).includes('issue_tracker_url')) {
      if (issueTracker === 'missing') throw missingColumn('42703');
      if (issueTracker === 'broken') throw new Error('connection reset');
    }
    return [];
  });
}

function createdDraft(): Record<string, unknown> {
  expect(write.appListing.create).toHaveBeenCalledTimes(1);
  return (write.appListing.create.mock.calls[0][0] as { data: Record<string, unknown> }).data;
}

/** The raw `UPDATE … issue_tracker_url` writes, as [value, listingId]. */
function issueTrackerWrites(): unknown[][] {
  return write.$executeRaw.mock.calls
    .filter((c: unknown[]) => sqlOf(c).includes('issue_tracker_url'))
    .map((c: unknown[]) => c.slice(1));
}

beforeEach(() => {
  vi.clearAllMocks();
  envMock.set({ APPS_DOMAIN: 'civit.ai' });
  read.appBlockPublishRequest.findFirst.mockResolvedValue(null);
  read.appBlock.findFirst.mockResolvedValue(null);
  read.appListing.findFirst.mockResolvedValue(null);
  write.appBlockPublishRequest.create.mockResolvedValue({});
  write.appListing.create.mockImplementation(async (a: { data: unknown }) => a.data);
  write.$executeRaw.mockResolvedValue(1);
});

describe('submitVersion — a NEW draft carries the manifest links', () => {
  it('🔴 copies `repository` (normalised) and `bugs` onto the draft it mints', async () => {
    armColumns({ sourceRepo: 'present', issueTracker: 'present' });
    await submitVersion({
      bundleBuffer: await bundle({ ...BASE, repository: RAW_REPO, bugs: BUGS }),
      submittedByUserId: 1,
    });

    const draft = createdDraft();
    expect(draft).toMatchObject({ kind: 'onsite', status: 'draft', slug: 'my-app' });
    expect(draft.sourceRepoUrl).toBe(STORED_REPO);
    // The issue tracker is written onto THE DRAFT JUST CREATED, not some other row.
    expect(issueTrackerWrites()).toEqual([[BUGS, draft.id]]);
  });

  it('a manifest with neither key: the source link is stored as null and no tracker write runs', async () => {
    armColumns({ sourceRepo: 'present', issueTracker: 'present' });
    await submitVersion({ bundleBuffer: await bundle(BASE), submittedByUserId: 1 });

    const draft = createdDraft();
    expect('sourceRepoUrl' in draft).toBe(true);
    expect(draft.sourceRepoUrl).toBeNull();
    expect(issueTrackerWrites()).toEqual([]);
  });

  it('columns MISSING (migration not applied): the draft is still minted, naming neither column', async () => {
    armColumns({ sourceRepo: 'missing', issueTracker: 'missing' });
    await submitVersion({
      bundleBuffer: await bundle({ ...BASE, repository: RAW_REPO, bugs: BUGS }),
      submittedByUserId: 1,
    });

    const draft = createdDraft();
    expect('sourceRepoUrl' in draft).toBe(false);
    expect(issueTrackerWrites()).toEqual([]);
  });

  it('a probe that THROWS (not a missing column) costs only that link, never the draft', async () => {
    armColumns({ sourceRepo: 'broken', issueTracker: 'present' });
    await submitVersion({
      bundleBuffer: await bundle({ ...BASE, repository: RAW_REPO, bugs: BUGS }),
      submittedByUserId: 1,
    });

    const draft = createdDraft();
    expect('sourceRepoUrl' in draft).toBe(false);
    // The independent column still gets its link.
    expect(issueTrackerWrites()).toEqual([[BUGS, draft.id]]);
  });

  it('a failed tracker WRITE does not fail the submit', async () => {
    armColumns({ sourceRepo: 'present', issueTracker: 'present' });
    write.$executeRaw.mockRejectedValue(new Error('db blip'));
    const res = await submitVersion({
      bundleBuffer: await bundle({ ...BASE, repository: RAW_REPO, bugs: BUGS }),
      submittedByUserId: 1,
    });
    expect(res.slug).toBe('my-app');
    expect(createdDraft().sourceRepoUrl).toBe(STORED_REPO);
  });
});
