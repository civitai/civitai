import JSZip from 'jszip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AppForkService from '~/server/services/blocks/app-fork.service';

/**
 * FORKABLE APPS, PR 3 — a fork's provenance reaches its FIRST publish request only from the
 * server-side fork session, through the real `submitVersion`.
 *
 * 🔴 THE FORGERY CASE IS THE ONE THIS FILE EXISTS FOR. The manifest is author-controlled, and so is
 * everything else a submit carries. A bundle that declares a parent — in every spelling an author
 * might try — with no fork session must record NOTHING; and with a session, the session's parent is
 * what is recorded, whatever the manifest says.
 *
 * Runs the real submit pipeline (zip parse, manifest checks, request create) over the canonical
 * db / redis mocks; MinIO and Forgejo are stubbed, and the provenance writer is a spy so the
 * assertion is on exactly what reached it.
 */

const m = vi.hoisted(() => ({
  setProvenance: vi.fn<(...args: unknown[]) => Promise<boolean>>().mockResolvedValue(true),
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
vi.mock('~/server/services/blocks/app-fork.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppForkService>()),
  setPublishRequestForkProvenance: m.setProvenance,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { REDIS_SYS_KEYS } from '~/server/redis/client';

const { submitVersion } = await import('~/server/services/blocks/publish-request.service');

const FORK_SLUG = 'pixel-garden-fork-3c4d';
const SUBMITTER_ID = 8201;
const STRANGER_ID = 8202;
/** The parent the SESSION names. */
const SESSION_PARENT_BLOCK = 'ab_session_parent_5401';
const SESSION_PARENT_SHA = 'a1b2c3d4'.repeat(5);
/** The parent the MANIFEST claims — a different, real-looking app. */
const FORGED_PARENT_BLOCK = 'ab_forged_parent_5402';
const FORGED_PARENT_SHA = 'f9e8d7c6'.repeat(5);
const FORGED_PARENT_LISTING = 'apl_forged_parent_5403';

/** Every spelling an author might use to declare a parent. */
const FORGED_CLAIMS = {
  forkOf: FORGED_PARENT_BLOCK,
  forkOfAppBlockId: FORGED_PARENT_BLOCK,
  fork_of_app_block_id: FORGED_PARENT_BLOCK,
  forkOfCommitSha: FORGED_PARENT_SHA,
  fork_of_commit_sha: FORGED_PARENT_SHA,
  forkOfListingId: FORGED_PARENT_LISTING,
};

async function bundle(manifest: Record<string, unknown>): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    'block.manifest.json',
    JSON.stringify({ blockId: FORK_SLUG, version: '0.1.0', name: 'Pixel Garden Fork', ...manifest })
  );
  zip.file('index.html', '<!doctype html><html><body>fork</body></html>');
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}

const sessions = new Map<string, string>();

function recordSession(userId: number) {
  sessions.set(
    `${REDIS_SYS_KEYS.BLOCKS.FORK_SESSION}:${FORK_SLUG}`,
    JSON.stringify({
      forkSlug: FORK_SLUG,
      userId,
      parentAppBlockId: SESSION_PARENT_BLOCK,
      parentCommitSha: SESSION_PARENT_SHA,
      parentListingId: 'apl_session_parent_5404',
      parentName: 'Pixel Garden',
      seed: null,
      seedExpiresAt: null,
      createdAt: '2026-10-23T00:00:00.000Z',
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sessions.clear();
  redisMock.sysRedis.get.mockImplementation(async (key: string) => sessions.get(key) ?? null);
  // A first version: no app holds the slug, no pending request, no store listing.
  dbMock.dbRead.appBlock.findFirst.mockResolvedValue(null);
  dbMock.dbRead.appBlockPublishRequest.findFirst.mockResolvedValue(null);
  dbMock.dbRead.appListing.findFirst.mockResolvedValue(null);
  dbMock.dbRead.appListingPublishRequest.findFirst.mockResolvedValue(null);
});

describe('submitVersion — fork provenance comes only from the fork session', () => {
  it('🔴 FORGERY: a manifest that declares a parent, with no fork session, records nothing', async () => {
    const result = await submitVersion({
      bundleBuffer: await bundle(FORGED_CLAIMS),
      submittedByUserId: SUBMITTER_ID,
    });
    expect(result.slug).toBe(FORK_SLUG);
    expect(m.setProvenance).not.toHaveBeenCalled();
  });

  it('the submitter’s own fork session is recorded — the session’s parent, not the manifest’s', async () => {
    recordSession(SUBMITTER_ID);
    const result = await submitVersion({
      bundleBuffer: await bundle(FORGED_CLAIMS),
      submittedByUserId: SUBMITTER_ID,
    });
    expect(m.setProvenance).toHaveBeenCalledTimes(1);
    expect(m.setProvenance).toHaveBeenCalledWith(expect.anything(), {
      publishRequestId: result.publishRequestId,
      forkOfAppBlockId: SESSION_PARENT_BLOCK,
      forkOfCommitSha: SESSION_PARENT_SHA,
    });
  });

  it('another user’s fork session for the slug records nothing', async () => {
    recordSession(STRANGER_ID);
    await submitVersion({
      bundleBuffer: await bundle({}),
      submittedByUserId: SUBMITTER_ID,
    });
    expect(m.setProvenance).not.toHaveBeenCalled();
  });

  it('a later version of an EXISTING app never reads the session (its block carries provenance)', async () => {
    recordSession(SUBMITTER_ID);
    dbMock.dbRead.appBlock.findFirst.mockResolvedValue({
      id: 'ab_fork_existing_5405',
      appId: 'app_5406',
    });
    await submitVersion({
      bundleBuffer: await bundle({ version: '0.2.0' }),
      submittedByUserId: SUBMITTER_ID,
      // A moderator: the owner gate on an existing app is pinned in publish-request.orchestration.test.ts.
      submitterIsModerator: true,
    });
    expect(m.setProvenance).not.toHaveBeenCalled();
  });
});
