import { describe, expect, it } from 'vitest';

import {
  computeListingProblems,
  listingProblemInput,
  listingProblemLinksFrom,
  type ListingProblemInput,
} from '~/server/services/blocks/listing-problems';

/**
 * The TRUST-LINK nudges: `no-source-repo` and `no-issue-tracker`.
 *
 * Three claims:
 *   1. ADVISORY, NEVER BLOCKING — a listing publishes without either link.
 *   2. KNOWN-UNSET ONLY — `null` nudges, `undefined` (the column could not be read, e.g. the
 *      manual-apply migration is outstanding) never does.
 *   3. KIND-AWARE LABELS — on-site points at `block.manifest.json`, off-site at the form.
 * Labels are spelled out in full: a nudge that names the wrong remedy is the defect.
 */

const complete: ListingProblemInput = {
  kind: 'offsite',
  iconId: 10,
  coverId: 20,
  screenshotCount: 3,
  description: 'A useful app that does a thing.',
  tagline: 'Does the thing',
  category: 'utility',
  status: 'approved',
  contentRating: 'g',
  declaredContentRating: 'g',
};

const LINKS_SET = {
  sourceRepoUrl: 'https://github.com/o/r',
  issueTrackerUrl: 'https://example.com/issues',
};

const problemsOf = (input: ListingProblemInput) => computeListingProblems(input).problems;

describe('computeListingProblems — trust links', () => {
  it('POSITIVE CONTROL: a complete listing with both links set has no problems', () => {
    expect(problemsOf({ ...complete, ...LINKS_SET })).toEqual([]);
  });

  it('🔴 an UNKNOWN link (undefined) is never reported — the unapplied-migration state', () => {
    expect(problemsOf(complete)).toEqual([]);
    expect(
      problemsOf({ ...complete, sourceRepoUrl: undefined, issueTrackerUrl: undefined })
    ).toEqual([]);
  });

  it('off-site: both nudges, advisory, with the form-field remedy, source first', () => {
    expect(problemsOf({ ...complete, sourceRepoUrl: null, issueTrackerUrl: null })).toEqual([
      {
        code: 'no-source-repo',
        label:
          'No source repository link (recommended, optional) — add one under Source repository in your listing details',
        severity: 'advisory',
      },
      {
        code: 'no-issue-tracker',
        label:
          'No issue tracker link (recommended, optional) — add one under Issue tracker in your listing details',
        severity: 'advisory',
      },
    ]);
  });

  it('on-site: both nudges name the manifest keys', () => {
    expect(
      problemsOf({ ...complete, kind: 'onsite', sourceRepoUrl: null, issueTrackerUrl: null })
    ).toEqual([
      {
        code: 'no-source-repo',
        label:
          'No source repository link (recommended, optional) — set "repository" in block.manifest.json and resubmit',
        severity: 'advisory',
      },
      {
        code: 'no-issue-tracker',
        label:
          'No issue tracker link (recommended, optional) — set "bugs" in block.manifest.json and resubmit',
        severity: 'advisory',
      },
    ]);
  });

  it('each link is judged on its own', () => {
    expect(
      problemsOf({
        ...complete,
        sourceRepoUrl: LINKS_SET.sourceRepoUrl,
        issueTrackerUrl: null,
      }).map((p) => p.code)
    ).toEqual(['no-issue-tracker']);
    expect(
      problemsOf({ ...complete, sourceRepoUrl: null, issueTrackerUrl: undefined }).map(
        (p) => p.code
      )
    ).toEqual(['no-source-repo']);
  });

  it('🔴 NEVER blocking, on any kind or status', () => {
    for (const kind of ['onsite', 'offsite'] as const) {
      for (const status of ['draft', 'pending', 'approved', 'removed']) {
        const problems = problemsOf({
          ...complete,
          kind,
          status,
          sourceRepoUrl: null,
          issueTrackerUrl: null,
        });
        const linkProblems = problems.filter(
          (p) => p.code === 'no-source-repo' || p.code === 'no-issue-tracker'
        );
        expect(linkProblems).toHaveLength(2);
        for (const p of linkProblems) expect(p.severity, `${kind}/${status}`).toBe('advisory');
      }
    }
  });
});

describe('listingProblemInput / listingProblemLinksFrom — the guarded read reaches the input', () => {
  const row = {
    iconId: 10,
    coverId: 20,
    description: 'd',
    tagline: 't',
    category: 'utility',
    status: 'approved',
    contentRating: 'g',
    _count: { screenshots: 2 },
  };

  it('a listing ABSENT from a map is unknown (undefined), present-with-null is known unset', () => {
    const links = listingProblemLinksFrom('apl_a', {
      sourceRepoUrls: new Map([['apl_a', null]]),
      issueTrackerUrls: new Map(),
    });
    expect(links).toEqual({ sourceRepoUrl: null, issueTrackerUrl: undefined });
  });

  it('threads the links through, so a missing issue-tracker column emits NEITHER tracker code', () => {
    // Source column readable and empty; issue-tracker column missing (empty map).
    const input = listingProblemInput(row, {
      kind: 'offsite',
      appRating: null,
      assetScans: [],
      links: listingProblemLinksFrom('apl_a', {
        sourceRepoUrls: new Map([['apl_a', null]]),
        issueTrackerUrls: new Map(),
      }),
    });
    const codes = computeListingProblems(input).problems.map((p) => p.code);
    expect(codes).toContain('no-source-repo');
    expect(codes).not.toContain('no-issue-tracker');
  });

  it('a set link reaches the input and suppresses its nudge', () => {
    const input = listingProblemInput(row, {
      kind: 'onsite',
      appRating: 'g',
      assetScans: [],
      links: listingProblemLinksFrom('apl_a', {
        sourceRepoUrls: new Map([['apl_a', 'https://github.com/o/r']]),
        issueTrackerUrls: new Map([['apl_a', 'https://example.com/issues']]),
      }),
    });
    expect(input.sourceRepoUrl).toBe('https://github.com/o/r');
    expect(input.issueTrackerUrl).toBe('https://example.com/issues');
    const codes = computeListingProblems(input).problems.map((p) => p.code);
    expect(codes).not.toContain('no-source-repo');
    expect(codes).not.toContain('no-issue-tracker');
  });
});
