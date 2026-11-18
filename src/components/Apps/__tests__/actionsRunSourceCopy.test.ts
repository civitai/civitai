import { describe, expect, it } from 'vitest';

import { buildListingDetailRows } from '~/components/Apps/appListingDetailRows';
import { reviewProvenanceLines } from '~/components/Apps/reviewSourceProvenance';
import type { ActionsRunSource } from '~/server/schema/blocks/actions-run-source.schema';
import type { ListingDetail } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * The words shown for a submit's GitHub Actions run, pinned as WHOLE strings: they are the claim
 * the platform makes in public, so a reword is a product decision, not a refactor.
 *
 * The public row says "submitted by a GitHub Actions run of …", never "verified", "secure" or
 * "built by"; the moderator lines keep the client's claim and the checked run apart.
 */

const SHA = 'b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5';

type Input = Parameters<typeof buildListingDetailRows>[0];
function detail(over: Partial<ListingDetail> = {}): Input {
  return {
    kindData: { kind: 'onsite', appBlockId: 'ab_1', hasPage: true, liveUrl: 'https://a.civit.ai' },
    category: 'utility',
    contentRating: 'pg',
    recommend: { recommendedCount: 3, notRecommendedCount: 1, recommendPct: 0.75 },
    reviewCount: 4,
    installCount: 11,
    openCount: 13,
    updatedAt: '2026-03-04T05:06:07.000Z',
    ...over,
  } as Input;
}
const fmt = (iso: string) => iso;

describe('the public Submitted-by row', () => {
  it('renders the run with the exact copy, linked to the commit, after Support', () => {
    const rows = buildListingDetailRows(
      detail({
        sourceRepoUrl: 'https://github.com/harbor-tools/knot-tier',
        issueTrackerUrl: 'https://github.com/harbor-tools/knot-tier/issues',
        actionsRunSource: { repository: 'harbor-tools/knot-tier', tag: 'v0.9.1', sha: SHA },
      }),
      { formatDate: fmt }
    );
    const row = rows.find((r) => r.key === 'actions-run');
    expect(row).toEqual({
      key: 'actions-run',
      label: 'Submitted by',
      value: 'GitHub Actions run of harbor-tools/knot-tier @ v0.9.1 (b4c3d2e)',
      href: `https://github.com/harbor-tools/knot-tier/commit/${SHA}`,
    });
    const keys = rows.map((r) => r.key);
    expect(keys.indexOf('actions-run')).toBe(keys.indexOf('support') + 1);
  });

  it('is absent when the listing has no public run', () => {
    for (const actionsRunSource of [null, undefined]) {
      const rows = buildListingDetailRows(detail({ actionsRunSource }), { formatDate: fmt });
      expect(rows.map((r) => r.key)).not.toContain('actions-run');
    }
  });
});

const RUN: ActionsRunSource = {
  repository: 'harbor-tools/knot-tier',
  repositoryId: '730021455',
  repositoryOwnerId: '5590213',
  sha: SHA,
  ref: 'refs/tags/v0.9.1',
  workflowRef: 'harbor-tools/knot-tier/.github/workflows/release.yml@refs/tags/v0.9.1',
  repositoryVisibility: 'public',
  runId: '6620019871',
};

describe('the moderator provenance lines', () => {
  it('shows the claim and the verified run on separate, labelled lines', () => {
    expect(
      reviewProvenanceLines({ claimedCommit: SHA, claimedDirty: false, actionsRun: RUN })
    ).toEqual([
      {
        key: 'claimed',
        heading: 'Claimed commit (sent by the client, not checked)',
        value: 'b4c3d2e · clean tree',
        links: [],
      },
      {
        key: 'actions-run',
        heading: 'GitHub-signed Actions run',
        value: 'harbor-tools/knot-tier @ v0.9.1 (b4c3d2e)',
        links: [
          { label: 'commit', href: `https://github.com/harbor-tools/knot-tier/commit/${SHA}` },
          {
            label: 'run',
            href: 'https://github.com/harbor-tools/knot-tier/actions/runs/6620019871',
          },
        ],
        note: "GitHub signed this run's repository, tag and commit. The run uploaded the bundle itself, so this does not show the bundle was built from that commit.",
      },
    ]);
  });

  it('a claim with no verified run says "none" on the run line — the claim never fills it', () => {
    const lines = reviewProvenanceLines({
      claimedCommit: SHA,
      claimedDirty: null,
      actionsRun: null,
    });
    expect(lines.map((l) => [l.key, l.value])).toEqual([
      ['claimed', 'b4c3d2e · tree state not sent'],
      ['actions-run', 'none'],
    ]);
  });

  it('names a private repository as private to the moderator', () => {
    const lines = reviewProvenanceLines({
      claimedCommit: null,
      claimedDirty: null,
      actionsRun: { ...RUN, repositoryVisibility: 'private' },
    });
    expect(lines.map((l) => l.value)).toEqual([
      'none sent',
      'harbor-tools/knot-tier @ v0.9.1 (b4c3d2e) · private repository',
    ]);
  });
});
