import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/server/services/blocks/forgejo.service', () => ({
  reviewRepoUrl: (slug: string) => `https://forgejo.example/review/${slug}`,
  repoCommitUrl: (slug: string, ref: string) => `https://forgejo.example/${slug}/commit/${ref}`,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { resetHybridNodes } from '~/__tests__/mocks/hybrid';
import { impersonationFingerprint } from '~/server/services/blocks/app-impersonation.logic';
import { listPendingRequests } from '~/server/services/blocks/publish-request.service';

/**
 * The queue's STALENESS wiring: `listPendingRequests` reads the fingerprint the impersonation
 * check recorded, recomputes one from the app's store listing as it is NOW, and marks the AI
 * summary `impersonationStale` unless the two agree. A stale check never fast-lanes the row.
 */

const listing = {
  id: 'apl_1',
  status: 'draft',
  contentRating: 'g',
  slug: 'sketch',
  kind: 'onsite',
  appBlockId: null as string | null,
  userId: 7,
  name: 'Sketch Helper',
  tagline: 'Draw',
  description: 'Draws things',
  iconId: 11,
  coverId: 12,
  icon: null,
  cover: null,
  metric: null,
};
const fpOf = (l: typeof listing) =>
  impersonationFingerprint({
    name: l.name,
    slug: l.slug,
    tagline: l.tagline,
    description: l.description,
    iconId: l.iconId,
    coverId: l.coverId,
  });

function seed(opts: { live: typeof listing; recordedFingerprint: string; appBlockId?: string }) {
  dbMock.dbRead.appBlockPublishRequest.findMany.mockResolvedValue([
    {
      id: 'pubreq_1',
      appBlockId: opts.appBlockId ?? null,
      slug: 'sketch',
      version: '1.0.0',
      submittedAt: new Date('2026-03-01T00:00:00Z'),
      bundleSizeBytes: BigInt(10),
      bundleSha256: 'sha',
      manifest: {},
      fileSummary: {},
      manifestDiffSummary: {},
      forgejoCommitSha: null,
      deployState: 'preview-live',
      deployDetail: null,
      deployUpdatedAt: new Date(),
      submittedBy: { id: 7, username: 'author', deletedAt: null, image: null },
    },
  ] as never);
  dbMock.dbRead.appListing.findMany.mockResolvedValue([opts.live] as never);
  // The agent-review summary query (the only raw read that names the report table).
  dbMock.dbRead.$queryRaw.mockImplementation((async (strings: TemplateStringsArray) =>
    strings.join('?').includes('app_review_agent_reports')
      ? [
          {
            publishRequestId: 'pubreq_1',
            status: 'complete',
            severities: [],
            overBroad: 0,
            underDeclared: 0,
            inaccurate: 0,
            sectionsOk: true,
            impersonationCheck: 'complete',
            impersonationFingerprint: opts.recordedFingerprint,
          },
        ]
      : []) as never);
}

type Row = { agentReview?: { impersonationStale?: boolean } | null };
const staleness = async () =>
  ((await listPendingRequests({ limit: 10, includeAgentReview: true })).items[0] as Row).agentReview
    ?.impersonationStale;

beforeEach(() => resetHybridNodes());

describe('listPendingRequests — impersonation check staleness', () => {
  it('the listing is as the check saw it → fresh (impersonationStale: false)', async () => {
    seed({ live: listing, recordedFingerprint: fpOf(listing) });
    expect(await staleness()).toBe(false);
  });

  it('🔴 the listing was edited after the check → stale', async () => {
    const edited = { ...listing, iconId: 99 };
    seed({ live: edited, recordedFingerprint: fpOf(listing) });
    expect(await staleness()).toBe(true);
  });

  it('🔴 a listing keyed to ANOTHER app is not this app’s listing → stale', async () => {
    const otherApps = { ...listing, appBlockId: 'ab_other' };
    seed({ live: otherApps, recordedFingerprint: fpOf(listing), appBlockId: 'ab_mine' });
    expect(await staleness()).toBe(true);
  });

  it('without the agentic surface there is no summary at all', async () => {
    seed({ live: listing, recordedFingerprint: fpOf(listing) });
    const { items } = await listPendingRequests({ limit: 10 });
    expect('agentReview' in (items[0] as object)).toBe(false);
  });
});
