import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { listingExtrasFromRow } from '~/server/registry-adapter/catalog-source.live';
import { streamForkOf } from '~/server/registry-adapter/catalog-source';
import { listingBody, type CatalogApp } from '~/server/registry-adapter/entities';
import type { ListingActionsRunSource } from '~/server/schema/blocks/app-listing-read.schema';
import { resolveForkAttribution } from '~/server/services/blocks/app-fork.service';
import {
  matureRatingAllowed,
  matureRatingsAllowed,
} from '~/server/services/blocks/app-listing-store-gate';
import {
  projectListingDetail,
  publicForkable,
  type HydratedListing,
} from '~/server/services/blocks/app-listing.service';
import { narrowStoreScope, scopeAdmitsListingKind } from '~/shared/utils/store-visibility-scope';

/**
 * The `details` half of the listing parity fixture (`media-parity.json`; the read model's side is
 * `parity_test.go`, `TestDetailParity`). Each `rows` entry is a listing's database state as
 * `getListingDetail` reads it, run through
 *
 *   - the store's own detail projection (`projectListingDetail`, `publicForkable`, and
 *     `resolveForkAttribution` with the store's gate as the parent lookup), which must give
 *     `expected` for every viewer: the detail an anonymous viewer is served;
 *   - the adapter (`listingExtrasFromRow`, `streamForkOf`, `listingBody`), which must publish
 *     exactly `stream`: what the read model is fed, and projects into the same `expected`.
 */

type Chip = { id: number; username: string | null; image: string | null };
type DetailRow = {
  appBlockId: string | null;
  serialId: number;
  approvedScopes: string[] | null;
  connectClientId: string | null;
  connectRequestedScopes: number | null;
  beta: { isBeta: boolean; betaMessage: string | null };
  collaborators: Chip[];
  sourceRepoUrl: string | null;
  issueTrackerUrl: string | null;
  actionsRunSource: ListingActionsRunSource | null;
  forkable: boolean;
  fork: { isFork: boolean; parent: string | null };
};
type Fixture = {
  viewers: { name: string; redCapable: boolean; browsingLevel: number; scope: string }[];
  listings: {
    slug: string;
    id: string;
    kind: 'onsite' | 'offsite';
    contentRating: string | null;
  }[];
  details: {
    rows: Record<string, DetailRow>;
    stream: Record<string, Record<string, unknown>>;
    expected: Record<string, Record<string, unknown> & { forkOf: Record<string, unknown> }>;
  };
};

const FIXTURE: Fixture = JSON.parse(
  readFileSync(
    join(process.cwd(), 'apps/app-index-go/internal/listingread/testdata/media-parity.json'),
    'utf8'
  )
);
const listingOf = (slug: string) => FIXTURE.listings.find((l) => l.slug === slug)!;
const DETAIL_SLUGS = Object.keys(FIXTURE.details.rows);

/** The hydrated row `projectListingDetail` reads, for a fixture listing and its detail state. */
function hydrated(slug: string, r: DetailRow): HydratedListing {
  const l = listingOf(slug);
  return {
    id: l.id,
    serialId: r.serialId,
    kind: l.kind,
    slug,
    name: slug,
    tagline: null,
    description: null,
    category: null,
    contentRating: l.contentRating,
    externalUrl: null,
    connectClientId: r.connectClientId,
    appBlockId: r.appBlockId,
    icon: null,
    cover: null,
    user: null,
    metric: null,
    updatedAt: new Date('2026-01-02T03:04:05.000Z'),
    appBlock:
      r.approvedScopes === null
        ? null
        : { manifest: {}, currentVersionDeployedAt: new Date(), approvedScopes: r.approvedScopes },
    screenshots: [],
  } as unknown as HydratedListing;
}

/** Whether the store shows fixture listing `slug` to `viewer` (its gate, as the media half). */
function storeShows(viewer: Fixture['viewers'][number], slug: string): boolean {
  const l = listingOf(slug);
  const scope = narrowStoreScope(viewer.scope);
  return (
    scope !== 'none' &&
    scopeAdmitsListingKind(scope, l.kind) &&
    matureRatingAllowed(
      l.contentRating,
      matureRatingsAllowed(viewer.redCapable, viewer.browsingLevel)
    )
  );
}

const DETAIL_FIELDS = [
  'serialId',
  'collaborators',
  'sourceRepoUrl',
  'issueTrackerUrl',
  'actionsRunSource',
  'scopes',
  'connectScopes',
  'betaMessage',
  'forkable',
] as const;

describe('listing detail parity (media-parity.json details): the site side', () => {
  it('the fixture covers both kinds, a fork with a gated parent, and a fork with none', () => {
    const kinds = new Set(DETAIL_SLUGS.map((s) => listingOf(s).kind));
    expect([...kinds].sort()).toEqual(['offsite', 'onsite']);
    const forks = DETAIL_SLUGS.map((s) => FIXTURE.details.rows[s].fork);
    expect(forks.some((f) => f.isFork && f.parent !== null)).toBe(true);
    expect(forks.some((f) => f.isFork && f.parent === null)).toBe(true);
  });

  it.each(DETAIL_SLUGS.map((s) => [s] as const))(
    'the store serves %s as expected, to every viewer',
    async (slug) => {
      const r = FIXTURE.details.rows[slug];
      const want = FIXTURE.details.expected[slug];
      const row = hydrated(slug, r);
      const detail = projectListingDetail(
        row,
        r.collaborators,
        r.sourceRepoUrl,
        { available: true, ...r.beta },
        r.connectRequestedScopes
      );
      // `getListingDetail`'s overrides of the projection.
      const served = {
        ...detail,
        issueTrackerUrl: r.issueTrackerUrl,
        actionsRunSource: row.kind === 'onsite' && row.appBlockId ? r.actionsRunSource : null,
        forkable: publicForkable(row.kind, r.forkable),
      };
      expect(served.id).toBe(want.id);
      for (const f of DETAIL_FIELDS) expect([f, served[f]]).toEqual([f, want[f]]);
      for (const v of FIXTURE.viewers) {
        const forkOf = await resolveForkAttribution(
          {
            forkable: r.forkable,
            isFork: r.fork.isFork,
            forkOfListingId: r.fork.parent ? listingOf(r.fork.parent).id : null,
          },
          async (parentId) => {
            const parent = FIXTURE.listings.find((l) => l.id === parentId)!;
            return storeShows(v, parent.slug) ? { slug: parent.slug, name: parent.slug } : null;
          }
        );
        expect([v.name, forkOf]).toEqual([v.name, want.forkOf[v.name]]);
      }
    }
  );

  it.each(DETAIL_SLUGS.map((s) => [s] as const))(
    'the adapter publishes %s as exactly the fixture stream',
    (slug) => {
      const r = FIXTURE.details.rows[slug];
      const l = listingOf(slug);
      const extras = listingExtrasFromRow(
        {
          id: l.id,
          serialId: r.serialId,
          kind: l.kind,
          appBlockId: r.appBlockId,
          connectClientId: r.connectClientId,
          connectRequestedScopes: r.connectRequestedScopes,
          description: null,
          createdAt: new Date('2026-01-02T03:04:05.000Z'),
          icon: null,
          cover: null,
          screenshots: [],
          appBlock: r.approvedScopes === null ? null : { approvedScopes: r.approvedScopes },
          metric: null,
        },
        {
          red: null,
          collaborators: r.collaborators,
          beta: r.beta,
          issueTrackerUrl: r.issueTrackerUrl,
          fork: {
            forkable: r.forkable,
            isFork: r.fork.isFork,
            forkOfListingId: r.fork.parent ? listingOf(r.fork.parent).id : null,
          },
          run: l.kind === 'onsite' && r.appBlockId ? r.actionsRunSource : null,
        }
      );
      const { fork, ...rest } = extras;
      // Every fixture listing is in the catalog, so a parent pointer names it.
      const slugById = new Map(FIXTURE.listings.map((x) => [x.id, x.slug] as const));
      const app: CatalogApp = {
        listing: {
          slug,
          kind: l.kind,
          name: slug,
          tagline: null,
          category: null,
          contentRating: l.contentRating,
          iconUrl: null,
          creatorUsername: null,
          externalUrl: null,
          sourceRepoUrl: r.sourceRepoUrl,
          forkOf: null,
        },
        block: null,
        approved: [],
      };
      const body = listingBody(app, `urn:apps.civitai.com:app/${slug}`, {
        id: l.id,
        appBlockId: r.appBlockId,
        creator: null,
        recommend: { recommendedCount: 0, notRecommendedCount: 0, recommendPct: null },
        reviewCount: 0,
        isBeta: r.beta.isBeta,
        isOfficial: false,
        openCount: null,
        updatedAt: null,
        hasPage: false,
        liveUrl: null,
        ...rest,
        forkOf: streamForkOf(l.id, fork, slugById),
      });
      const want = FIXTURE.details.stream[slug];
      const published = Object.fromEntries(Object.keys(want).map((k) => [k, body[k]]));
      expect(published).toEqual(want);
      expect(body.id).toBe(FIXTURE.details.expected[slug].id);
    }
  );
});
