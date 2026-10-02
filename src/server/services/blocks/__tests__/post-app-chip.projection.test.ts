/**
 * The DISCLOSURE guards for the post-detail "Published with <app>" chip.
 *
 * Two things stand between this feature and a credential / moderator-id leak on
 * a public, anon-capable post read, and this file pins both:
 *
 *  1. `postSelect` must never gain `metadata`. `getPostDetail` spreads its
 *     selection wholesale to the client and Prisma cannot select a JSON subkey,
 *     so that one word would ship every `Post.metadata` key — including
 *     `unpublishedBy` (a moderator id, which `getPostDetail` deliberately forces
 *     to `null` for a published post) and `reviewId`.
 *  2. The app read must project EXACTLY the chip's fields. `OauthClient` carries
 *     `secret`, `redirectUris` and `allowedOrigins` beside `name`.
 *
 * Both are asserted STRUCTURALLY — against the literal select tree and a literal
 * key list — because a behavioural test over the projector cannot see a widened
 * `select`, and a type declaration is not a runtime guard.
 *
 * 🔴 THE EXPECTED KEY LIST IS WRITTEN OUT HERE, NOT IMPORTED FROM THE MODULE
 * UNDER TEST. It used to be imported, which made the assertion self-referencing:
 * a widening that edited the projector AND the exported constant together passed.
 * The whole point is to be a second, independent statement of the shape.
 *
 * 🔴 AND THE NOT-VIEWABLE FIXTURES DO NOT USE `removed`/`suspended`. Those are
 * the values a plausible DENYLIST would name, so a fixture built from them cannot
 * tell `status === 'approved'` from `status !== 'removed'` — three such rewrites
 * survived a fully green suite. Both status domains default to a NON-approved
 * value (`draft`, `pending`), so a denylist publishes the default state of both
 * tables. The domain is iterated instead of sampled.
 */
import { describe, expect, it, vi } from 'vitest';

/**
 * 🔴 `vi.hoisted`, NOT a top-level `vi.stubEnv`, and the difference decides
 * whether the maturity tests below mean anything.
 *
 * `server-domain.ts` builds `serverDomainMap` from `process.env` AT IMPORT. Static
 * `import` statements are evaluated before any module-body statement, so a
 * top-level `vi.stubEnv` runs too late: the map is already built from an EMPTY
 * env, `red` is `undefined`, and `isHostForColor(any, 'red')` is permanently
 * false. Every "mature app is withheld" assertion would then pass for the wrong
 * reason — the host would be non-red whatever it was called — and its red-host
 * CONTROL is the only thing that catches that. (The sibling
 * `server-domain.nsfw-rating.test.ts` solves the same problem the other way, with
 * a dynamic `await import` per test.)
 *
 * The shape mirrors production, including the part that makes it subtle:
 * `civitai.red` is configured as BOTH a blue alias and the red primary, so the
 * colour walk returns `blue` for it while `isHostForColor(…, 'red')` is true.
 * The gate must key off RED CAPABILITY, not the colour walk.
 */
vi.hoisted(() => {
  process.env.SERVER_DOMAIN_BLUE = 'civitai.com';
  process.env.SERVER_DOMAIN_BLUE_ALIASES = 'civitai.red';
  process.env.SERVER_DOMAIN_RED = 'civitai.red';
});

import { postSelect } from '~/server/selectors/post.selector';
import { APP_LISTING_STATUSES } from '~/server/services/blocks/app-listing-status.constants';
import { BLOCK_POST_APP_ID_META_KEY } from '~/server/services/blocks/block-post.logic';
import { listingIconUrl } from '~/server/services/blocks/listing-media-url';
import {
  postAppChipQuery,
  postAppMarkerQuery,
  projectPostAppChip,
  readBlockPublishedAppId,
} from '~/server/services/blocks/post-app-chip.logic';

/** Written out, deliberately — see the header. */
const EXPECTED_CHIP_KEYS = ['iconUrl', 'name', 'slug'];

/** A red-capable host, so the maturity term is satisfied unless a test says otherwise. */
const RED_HOST = 'civitai.red';
/** The ordinary SFW host. A mature app is NOT viewable here. */
const SFW_HOST = 'civitai.com';

const ICON_UUID = '9809af55-f734-4bf2-b176-de1f9c461cc3';

/**
 * A realistic metadata blob: the marker riding alongside the keys measured on the
 * live `Post.metadata` column. `unpublishedBy` / `unpublishedAt` are
 * moderator-action fields and `reviewId` is a moderation-review id; the rest are
 * merely not ours to publish. The assertion that none of them reach the client is
 * one rung up, on the assembled DTO, in `post.controller.app-chip.test.ts` — this
 * blob exists so the marker reader has something realistic to pick out of.
 */
const liveShapedMetadata = {
  [BLOCK_POST_APP_ID_META_KEY]: 'appblk-custom-generators',
  unpublishedBy: 318,
  unpublishedAt: '2026-04-02T00:00:00.000Z',
  reviewId: 8812,
  prevPublishedAt: '2026-03-01T00:00:00.000Z',
  imageNsfwLevel: 1,
  imageNsfw: false,
  modelVersionId: 55,
  modelId: 7,
};

/** Every `OauthClient` column the chip must never copy. */
const FORBIDDEN_OAUTH_CLIENT_FIELDS = [
  'secret',
  'redirectUris',
  'allowedOrigins',
  'description',
  'grants',
  'allowedScopes',
  'isConfidential',
  'accessMode',
  'userId',
  'isVerified',
  'logoUrl',
] as const;

type Listing = {
  slug: string;
  name: string;
  status: string;
  kind: string;
  contentRating: string | null;
  revisionOfId: string | null;
  icon: { url: string | null } | null;
};
type Block = { status: string; currentVersionDeployedAt: Date | null; appListing?: Listing | null };

const listing = (over: Partial<Listing> = {}): Listing => ({
  slug: 'custom-generators',
  name: 'Custom Generators',
  status: 'approved',
  kind: 'onsite',
  contentRating: 'pg',
  revisionOfId: null,
  icon: { url: ICON_UUID },
  ...over,
});

const block = (over: Partial<Block> = {}): Block => ({
  status: 'approved',
  currentVersionDeployedAt: new Date('2026-09-01T00:00:00.000Z'),
  appListing: listing(),
  ...over,
});

const row = (over: { name?: string; appBlocks?: Block[] } = {}) => ({
  name: 'Custom Generators Client',
  appBlocks: [block()],
  ...over,
});

/** The projector, at the red-capable host unless a test needs otherwise. */
const project = (r: unknown, host = RED_HOST) =>
  projectPostAppChip(r as Parameters<typeof projectPostAppChip>[0], { host });

describe('postSelect must not carry Post.metadata', () => {
  it('has no `metadata` key', () => {
    // 🔴 The single highest-consequence assertion in this change. `metadata: true`
    // here is a one-word edit with no visible symptom and it publishes moderator
    // ids to anonymous readers.
    expect(Object.keys(postSelect)).not.toContain('metadata');
  });

  it('still projects exactly the fields it did before this change', () => {
    // A ledger, not a spot check: it fails if `metadata` is added under ANY
    // spelling, and equally if something else is quietly widened in here. The
    // post DTO is a public read, so the set growing is the event worth seeing.
    expect(Object.keys(postSelect).sort()).toEqual(
      [
        'id',
        'nsfw',
        'nsfwLevel',
        'title',
        'detail',
        'modelVersionId',
        'modelVersion',
        'user',
        'publishedAt',
        'availability',
        'tags',
        'collectionId',
      ].sort()
    );
  });
});

describe('the marker read is narrow, and its blob never leaves the module', () => {
  it('selects only `metadata`, for only that post', () => {
    const q = postAppMarkerQuery(31107522);
    expect(q.where).toEqual({ id: 31107522 });
    expect(Object.keys(q.select)).toEqual(['metadata']);
  });

  it('reads the marker, and ONLY the marker, out of a live-shaped blob', () => {
    // 🔴 Criterion 5's behavioural half. The `toBe` is the whole assertion: if
    // the blob were returned instead of the subkey this fails, because a string
    // cannot carry `unpublishedBy`. (An earlier version also looped
    // `JSON.stringify(appId)).not.toContain(key)` over every metadata key — dead
    // weight, since once `toBe` has passed `appId` IS that literal and the loop
    // is logically implied. The leak it was reaching for is covered one rung up,
    // on the assembled DTO, in `post-app-chip.controller.test.ts`.)
    expect(readBlockPublishedAppId(liveShapedMetadata)).toBe('appblk-custom-generators');
  });

  it('reads the key the WRITER writes, not a re-spelled literal', () => {
    // The constant is shared with `block-post.service.ts`'s write path, so a
    // rename there is a compile error here rather than a silently dead chip.
    // One literal assertion remains so a change to the constant's VALUE — which
    // would orphan every existing row — still fails something.
    expect(BLOCK_POST_APP_ID_META_KEY).toBe('blockPublishedAppId');
    expect(readBlockPublishedAppId({ blockPublishedAppId: 'appblk-x' })).toBe('appblk-x');
  });

  it('reads no marker from metadata that has none, or that is not an object', () => {
    const { [BLOCK_POST_APP_ID_META_KEY]: _dropped, ...withoutMarker } = liveShapedMetadata;
    expect(readBlockPublishedAppId(withoutMarker)).toBeNull();
    expect(readBlockPublishedAppId(null)).toBeNull();
    expect(readBlockPublishedAppId(undefined)).toBeNull();
    // A Json column can legitimately hold a scalar or an array.
    expect(readBlockPublishedAppId('appblk-custom-generators')).toBeNull();
    expect(readBlockPublishedAppId([{ blockPublishedAppId: 'appblk-x' }])).toBeNull();
    // Non-string and blank markers are not addressable, so they must not trigger
    // a lookup either.
    expect(readBlockPublishedAppId({ blockPublishedAppId: 12345 })).toBeNull();
    expect(readBlockPublishedAppId({ blockPublishedAppId: '   ' })).toBeNull();
  });

  it('trims a padded marker rather than looking up the padded form', () => {
    expect(readBlockPublishedAppId({ blockPublishedAppId: '  appblk-x  ' })).toBe('appblk-x');
  });
});

describe('the app read is an allowlist', () => {
  it('selects only the chip fields from OauthClient and its joins', () => {
    const q = postAppChipQuery('appblk-custom-generators');
    expect(q.where).toEqual({ id: 'appblk-custom-generators' });
    // 🔴 The structural half of criterion 6. A behavioural test over the
    // projector cannot see a widened SELECT — the extra column simply arrives
    // and is dropped — so the select tree is pinned here, level by level.
    expect(Object.keys(q.select).sort()).toEqual(['appBlocks', 'name']);
    expect(Object.keys(q.select.appBlocks.select).sort()).toEqual(
      ['appListing', 'currentVersionDeployedAt', 'status'].sort()
    );
    expect(Object.keys(q.select.appBlocks.select.appListing.select).sort()).toEqual(
      // `id` is W14: the per-listing VISIBILITY LEVEL is the FOURTH term of the
      // destination's predicate, and resolving it needs the listing's id for a batched
      // read. The column itself is NOT selected here and cannot be — it is `// @no-type`
      // and absent from the generated client, which is what keeps every unguarded
      // `appListing` write immune to the manual-apply window.
      ['contentRating', 'icon', 'id', 'kind', 'name', 'revisionOfId', 'slug', 'status'].sort()
    );
    expect(Object.keys(q.select.appBlocks.select.appListing.select.icon.select)).toEqual(['url']);
  });

  it('names no forbidden OauthClient column anywhere in the select tree', () => {
    const serialized = JSON.stringify(postAppChipQuery('appblk-x'));
    for (const field of FORBIDDEN_OAUTH_CLIENT_FIELDS) {
      expect(serialized).not.toContain(field);
    }
  });
});

describe('projectPostAppChip emits exactly the chip', () => {
  it('shapes exactly {iconUrl, name, slug}', () => {
    // 🔴 THE MUTATION TARGET for criterion 6. Add any field to the returned
    // object literal in `projectPostAppChip` and this line fails with its own
    // error, naming the added key. The expected list is written out here rather
    // than imported, so editing the module cannot also edit the expectation.
    expect(Object.keys(project(row()) ?? {}).sort()).toEqual(EXPECTED_CHIP_KEYS);
  });

  it('copies no forbidden OauthClient field even when the row carries one', () => {
    // The row is built the way a WIDENED select would deliver it. The projector
    // is an allowlist, so the extra columns must be dropped on the floor rather
    // than passed through.
    const widened = {
      ...row(),
      secret: 'oauth-client-secret-do-not-publish',
      redirectUris: ['https://example.invalid/cb'],
      allowedOrigins: ['https://example.invalid'],
      description: 'internal description',
      logoUrl: 'https://example.invalid/logo.png',
    };
    const serialized = JSON.stringify(project(widened));
    for (const field of FORBIDDEN_OAUTH_CLIENT_FIELDS) {
      expect(serialized).not.toContain(field);
    }
    expect(serialized).not.toContain('oauth-client-secret-do-not-publish');
    expect(serialized).not.toContain('example.invalid');
  });

  it('links a viewable app and carries its listing name and icon', () => {
    expect(project(row())).toEqual({
      slug: 'custom-generators',
      name: 'Custom Generators',
      // 🔴 Asserted against the SHARED projection, not a substring of the raw
      // column. `Image.url` IS the bare UUID, so `stringContaining(uuid)` matched
      // whether or not `listingIconUrl`/`getEdgeUrl` ran — both "return the raw
      // url" and "change the width" survived it. This pins the relationship the
      // module's own header claims: the chip's icon is byte-identical to the one
      // the store renders for the same app.
      iconUrl: listingIconUrl({ url: ICON_UUID }),
    });
  });

  it('renders an icon-less app gracefully', () => {
    // The live not-viewable instance has no icon at all, so null is ordinary.
    expect(project(row({ appBlocks: [block({ appListing: listing({ icon: null }) })] }))).toEqual({
      slug: 'custom-generators',
      name: 'Custom Generators',
      iconUrl: null,
    });
  });

  describe('viewability is an ALLOWLIST over the whole status domain', () => {
    // 🔴 Iterated, not sampled — see the header. `removed`/`suspended` are the
    // values a denylist would name; `draft`/`pending` are the DEFAULTS, and a
    // denylist publishes them.
    for (const status of APP_LISTING_STATUSES.filter((s) => s !== 'approved')) {
      it(`withholds the slug when the LISTING is "${status}"`, () => {
        const chip = project(row({ appBlocks: [block({ appListing: listing({ status }) })] }));
        expect(chip).toEqual({ slug: null, name: 'Custom Generators', iconUrl: null });
      });
    }

    // `app_blocks.status` is free-text in the schema, so the domain is the set the
    // pipeline actually writes plus its default.
    for (const status of ['pending', 'rejected', 'suspended', 'building'] as const) {
      it(`withholds the slug when the BLOCK is "${status}"`, () => {
        expect(project(row({ appBlocks: [block({ status })] }))?.slug).toBeNull();
      });
    }

    it('withholds the slug for a shadow revision', () => {
      const chip = project(
        row({ appBlocks: [block({ appListing: listing({ revisionOfId: 'apl_parent' }) })] })
      );
      // The revision is not the app's store row at all, so it contributes no
      // candidate — the client name carries the chip.
      expect(chip).toEqual({ slug: null, name: 'Custom Generators Client', iconUrl: null });
    });
  });

  describe('viewability also carries the DESTINATION’s own two gates', () => {
    // Without these the chip links a store-detail page that `getListingDetail`
    // refuses — a 404 dressed as a working link, which is exactly what the
    // unlinked branch exists to avoid.
    it('withholds the slug for an onsite app that has never deployed', () => {
      expect(
        project(row({ appBlocks: [block({ currentVersionDeployedAt: null })] }))?.slug
      ).toBeNull();
    });

    it('still links an OFFSITE listing with no deploy timestamp', () => {
      // The control for the gate above: `kind` is the discriminator, because an
      // offsite row has no deploy concept at all. Drop the `kind` term and this
      // fails while the test above still passes.
      expect(
        project(
          row({
            appBlocks: [
              block({ currentVersionDeployedAt: null, appListing: listing({ kind: 'offsite' }) }),
            ],
          })
        )?.slug
      ).toBe('custom-generators');
    });

    it('links an SFW app on any host, including an empty one', () => {
      expect(project(row(), '')?.slug).toBe('custom-generators');
    });
  });

  describe('a MATURITY refusal suppresses the whole chip, not just the link', () => {
    /**
     * 🔴 THIS IS NOT THE LIFECYCLE NON-VIEWABLE BRANCH, AND THE DIFFERENCE IS THE
     * POINT. A draft / rejected / delisted / suspended / never-deployed app keeps
     * its name UNLINKED: it exists, the store just will not give it a page. A
     * MATURE app on a non-red host is different in kind — `listingMatureFilter`
     * hides the card and `getListingDetail` returns null, so on that host the
     * store behaves as though the listing does not exist at all. The faithful
     * mirror of "does not exist" is silence, not an unlinked title.
     *
     * 🔴 EVERY ASSERTION HERE IS ON THE WHOLE RETURNED OBJECT. The previous
     * revision of these tests asserted only `?.slug`, and nothing anywhere
     * asserted `name` on this branch — which is exactly why the leak shipped: the
     * slug and the icon were withheld while the app's store TITLE rendered. A
     * single-field assertion cannot see that.
     */
    const matureRow = (rating = 'r') =>
      row({ appBlocks: [block({ appListing: listing({ contentRating: rating }) })] });

    for (const rating of ['r', 'x'] as const) {
      it(`renders NOTHING for a mature ("${rating}") app on a non-red host`, () => {
        expect(project(matureRow(rating), SFW_HOST)).toBeNull();
      });
    }

    it('fails closed on an empty host', () => {
      expect(project(matureRow(), '')).toBeNull();
    });

    it('suppresses the OauthClient-name fallback too, not only the listing name', () => {
      // 🔴 THE MUTANT-TRAP. Nulling the candidate's own `name` is a NO-OP here,
      // because it falls through to `clientName` — and for an `appblk-` client
      // that is the same string the listing carries. So this fixture gives the
      // client a DISTINCT name: if the fix only gagged the listing name, the chip
      // would come back carrying this one and the assertion would name it.
      expect(
        project(
          {
            name: 'A Distinct Client Name',
            appBlocks: [block({ appListing: listing({ contentRating: 'x' }) })],
          },
          SFW_HOST
        )
      ).toBeNull();
    });

    it('still renders the full linked chip for the same app on a red-capable host', () => {
      // The control: maturity is a property of the HOST, so the identical row must
      // come back whole on red. A hardcoded `false` for the maturity term passes
      // every assertion above and fails this one.
      expect(project(matureRow(), RED_HOST)).toEqual({
        slug: 'custom-generators',
        name: 'Custom Generators',
        iconUrl: listingIconUrl({ url: ICON_UUID }),
      });
    });

    it('is PER-CANDIDATE: a maturity-refused sibling does not suppress a fine one', () => {
      // Only suppress when every candidate is gone. One mature block plus one SFW
      // block must still render the SFW one, linked.
      const mature = block({ appListing: listing({ slug: 'aaa-mature', contentRating: 'x' }) });
      const sfw = block({ appListing: listing({ slug: 'zzz-sfw', contentRating: 'pg' }) });
      // Both orders, because the maturity-refused one sorts FIRST by slug here —
      // so a fix that reads `candidates[0]` rather than filtering would fail one.
      expect(project(row({ appBlocks: [mature, sfw] }), SFW_HOST)?.slug).toBe('zzz-sfw');
      expect(project(row({ appBlocks: [sfw, mature] }), SFW_HOST)?.slug).toBe('zzz-sfw');
    });

    it('prefers a LIFECYCLE-refused sibling (unlinked name) over suppressing', () => {
      // A mature candidate and a draft candidate. The draft one is not lost to
      // maturity, so the chip survives as the documented unlinked-name branch
      // rather than disappearing.
      const mature = block({ appListing: listing({ slug: 'aaa-mature', contentRating: 'x' }) });
      const draft = block({
        appListing: listing({ slug: 'zzz-draft', name: 'Draft App', status: 'draft' }),
      });
      expect(project(row({ appBlocks: [mature, draft] }), SFW_HOST)).toEqual({
        slug: null,
        name: 'Draft App',
        iconUrl: null,
      });
    });

    it('does NOT catch the no-listing-at-all case', () => {
      // 🔴 Branch (b) is unchanged: a block with no `AppListing` row still falls
      // back to `OauthClient.name`. There is no `contentRating` to gate on, so
      // nothing was lost to maturity and the suppression must not reach it. A fix
      // that suppressed whenever no candidate survived would break this.
      expect(
        project(
          { name: 'Ab Img Poster', appBlocks: [{ status: 'approved', appListing: null }] },
          SFW_HOST
        )
      ).toEqual({ slug: null, name: 'Ab Img Poster', iconUrl: null });
      expect(project({ name: 'Ab Img Poster', appBlocks: [] }, SFW_HOST)).toEqual({
        slug: null,
        name: 'Ab Img Poster',
        iconUrl: null,
      });
    });

    it('does NOT catch a shadow revision, which contributes no candidate', () => {
      // Same reasoning: a revision is filtered out before any gate runs, so it is
      // not "lost to maturity" and the client-name fallback still applies.
      expect(
        project(
          row({
            appBlocks: [
              block({ appListing: listing({ revisionOfId: 'apl_parent', contentRating: 'x' }) }),
            ],
          }),
          SFW_HOST
        )
      ).toEqual({ slug: null, name: 'Custom Generators Client', iconUrl: null });
    });
  });

  describe('name precedence and the unnameable case', () => {
    it('prefers the listing name over the OauthClient name', () => {
      expect(project(row())?.name).toBe('Custom Generators');
    });

    it('falls back to the OauthClient name when there is no listing row', () => {
      expect(
        project({ name: 'Ab Img Poster', appBlocks: [{ status: 'approved', appListing: null }] })
      ).toEqual({ slug: null, name: 'Ab Img Poster', iconUrl: null });
    });

    it('falls back when the app has no blocks at all', () => {
      expect(project({ name: 'Ab Img Poster', appBlocks: [] })?.name).toBe('Ab Img Poster');
    });

    it('returns null when nothing legible survives sanitization', () => {
      // A chip reading "Published with" and then nothing is worse than no chip.
      // `‮` is a bidi override; `​` a zero-width space — both stripped.
      expect(project({ name: '‮​', appBlocks: [] })).toBeNull();
      expect(project({ name: '   ', appBlocks: [] })).toBeNull();
      expect(project({ name: undefined, appBlocks: [] })).toBeNull();
    });
  });

  it('sanitizes the publisher-controlled name', () => {
    // 🔴 Both names are publisher-controlled and this is the only place they are
    // cleaned. A bidi override here would reorder the rendered sentence inside
    // someone else's post header.
    const name = project(
      row({ appBlocks: [block({ appListing: listing({ name: 'Gen‮Matrix​' }) })] })
    )?.name;
    expect(name).toBe('GenMatrix');
    expect(name).not.toContain('‮');
    expect(name).not.toContain('​');
  });

  describe('deterministic candidate choice', () => {
    // An `appblk-<slug>` client owns one block in practice, so these decide a case
    // that should not arise — but a chip that named a different app on two
    // identical reads would be worse than either answer.
    const named = (slug: string, status: string) =>
      block({ appListing: listing({ slug, name: slug, status, icon: null }) });

    it('prefers a VIEWABLE candidate over a non-viewable one, in either order', () => {
      const forward = row({ appBlocks: [named('zeta', 'removed'), named('alpha', 'approved')] });
      const reversed = row({ appBlocks: [named('alpha', 'approved'), named('zeta', 'removed')] });
      expect(project(forward)).toEqual(project(reversed));
      expect(project(forward)?.slug).toBe('alpha');
    });

    it('breaks a tie between two VIEWABLE candidates on slug, in either order', () => {
      // 🔴 The case the previous test cannot see. With only ONE viewable
      // candidate, `find(viewable)` decides the answer and the sort never runs —
      // so deleting the comparator, reversing it, or sorting by `name` all
      // survived. Two viewable candidates is what makes the sort load-bearing.
      const forward = row({ appBlocks: [named('zeta', 'approved'), named('alpha', 'approved')] });
      const reversed = row({ appBlocks: [named('alpha', 'approved'), named('zeta', 'approved')] });
      expect(project(forward)?.slug).toBe('alpha');
      expect(project(reversed)?.slug).toBe('alpha');
    });
  });

  it('returns null for an unresolvable marker', () => {
    // Branch (a): the dev-mint path writes a deliberately synthetic appId that
    // matches no OauthClient, so `findUnique` returns null by design.
    expect(project(null)).toBeNull();
    expect(project(undefined)).toBeNull();
  });
});
