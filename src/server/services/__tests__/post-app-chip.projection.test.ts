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
 * Both are asserted STRUCTURALLY — against the literal select tree and the
 * literal emitted key set — because a behavioural test over the projector cannot
 * see a widened `select`, and a type declaration is not a runtime guard.
 */
import { describe, expect, it } from 'vitest';
import { postSelect } from '~/server/selectors/post.selector';
import {
  POST_APP_CHIP_KEYS,
  postAppChipQuery,
  postAppMarkerQuery,
  projectPostAppChip,
  readBlockPublishedAppId,
} from '~/server/services/blocks/post-app-chip';

/**
 * The keys measured on the live `Post.metadata` column, worst-disclosure first.
 * `unpublishedBy` / `unpublishedAt` are moderator-action fields and `reviewId` is
 * a moderation-review id; the rest are merely not ours to publish.
 */
const LIVE_METADATA_KEYS = [
  'unpublishedBy',
  'unpublishedAt',
  'reviewId',
  'prevPublishedAt',
  'imageNsfwLevel',
  'imageNsfw',
  'modelVersionId',
  'modelId',
] as const;

/** A realistic metadata blob: the marker riding alongside everything else. */
const liveShapedMetadata = {
  blockPublishedAppId: 'appblk-custom-generators',
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

const viewableRow = () => ({
  name: 'Custom Generators Client',
  appBlocks: [
    {
      status: 'approved',
      appListing: {
        slug: 'custom-generators',
        name: 'Custom Generators',
        status: 'approved',
        revisionOfId: null,
        icon: { url: '9809af55-f734-4bf2-b176-de1f9c461cc3' },
      },
    },
  ],
});

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

  it('turns a live-shaped metadata blob into a bare id string and nothing else', () => {
    // 🔴 Criterion 5's behavioural half: the ONLY thing that escapes
    // `readBlockPublishedAppId` is the marker. Return the blob instead of the
    // subkey and this fails — a string cannot carry `unpublishedBy`.
    const appId = readBlockPublishedAppId(liveShapedMetadata);
    expect(appId).toBe('appblk-custom-generators');
    expect(typeof appId).toBe('string');
    for (const key of LIVE_METADATA_KEYS) {
      expect(JSON.stringify(appId)).not.toContain(key);
    }
  });

  it('reads no marker from metadata that has none, or that is not an object', () => {
    const { blockPublishedAppId: _dropped, ...withoutMarker } = liveShapedMetadata;
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
    expect(Object.keys(q.select.appBlocks.select).sort()).toEqual(['appListing', 'status']);
    expect(Object.keys(q.select.appBlocks.select.appListing.select).sort()).toEqual(
      ['icon', 'name', 'revisionOfId', 'slug', 'status'].sort()
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
    const chip = projectPostAppChip(viewableRow());
    // 🔴 THE MUTATION TARGET for criterion 6. Add any field to the returned
    // object literal in `projectPostAppChip` and this line fails with its own
    // error, naming the added key.
    expect(Object.keys(chip ?? {}).sort()).toEqual([...POST_APP_CHIP_KEYS]);
  });

  it('copies no forbidden OauthClient field even when the row carries one', () => {
    // The row is built the way a WIDENED select would deliver it. The projector
    // is an allowlist, so the extra columns must be dropped on the floor rather
    // than passed through.
    const row = {
      ...viewableRow(),
      secret: 'oauth-client-secret-do-not-publish',
      redirectUris: ['https://example.invalid/cb'],
      allowedOrigins: ['https://example.invalid'],
      description: 'internal description',
      logoUrl: 'https://example.invalid/logo.png',
    };
    const serialized = JSON.stringify(projectPostAppChip(row));
    for (const field of FORBIDDEN_OAUTH_CLIENT_FIELDS) {
      expect(serialized).not.toContain(field);
    }
    expect(serialized).not.toContain('oauth-client-secret-do-not-publish');
    expect(serialized).not.toContain('example.invalid');
  });

  it('links a viewable app and carries its listing name and icon', () => {
    expect(projectPostAppChip(viewableRow())).toEqual({
      slug: 'custom-generators',
      name: 'Custom Generators',
      // The shared `listingIconUrl` projection, so the chip's icon is the same
      // asset the store renders for this app.
      iconUrl: expect.stringContaining('9809af55-f734-4bf2-b176-de1f9c461cc3'),
    });
  });

  it('renders an icon-less app gracefully', () => {
    // The live not-viewable instance has no icon at all, so null is ordinary.
    const row = viewableRow();
    row.appBlocks[0].appListing.icon = null as never;
    expect(projectPostAppChip(row)).toEqual({
      slug: 'custom-generators',
      name: 'Custom Generators',
      iconUrl: null,
    });
  });

  describe('viewability is BOTH statuses, and a miss means UNLINKED not unlabelled', () => {
    it('withholds the slug when the LISTING is not approved', () => {
      // The live instance of this branch: block `suspended`, listing `removed`.
      const row = viewableRow();
      row.appBlocks[0].appListing.status = 'removed';
      const chip = projectPostAppChip(row);
      expect(chip).toEqual({ slug: null, name: 'Custom Generators', iconUrl: null });
    });

    it('withholds the slug when the BLOCK is not approved', () => {
      // 🔴 The half a one-sided predicate would miss. Drop the `app_blocks.status`
      // term and only this case changes.
      const row = viewableRow();
      row.appBlocks[0].status = 'suspended';
      expect(projectPostAppChip(row)?.slug).toBeNull();
    });

    it('withholds the slug for a shadow revision', () => {
      const row = viewableRow();
      row.appBlocks[0].appListing.revisionOfId = 'apl_parent' as never;
      // The revision is not the app's store row at all, so it contributes no
      // candidate — the client name carries the chip.
      expect(projectPostAppChip(row)).toEqual({
        slug: null,
        name: 'Custom Generators Client',
        iconUrl: null,
      });
    });
  });

  describe('name precedence and the unnameable case', () => {
    it('prefers the listing name over the OauthClient name', () => {
      expect(projectPostAppChip(viewableRow())?.name).toBe('Custom Generators');
    });

    it('falls back to the OauthClient name when there is no listing row', () => {
      expect(
        projectPostAppChip({ name: 'Ab Img Poster', appBlocks: [{ status: 'approved' }] })
      ).toEqual({ slug: null, name: 'Ab Img Poster', iconUrl: null });
    });

    it('falls back when the app has no blocks at all', () => {
      expect(projectPostAppChip({ name: 'Ab Img Poster', appBlocks: [] })?.name).toBe(
        'Ab Img Poster'
      );
    });

    it('returns null when nothing legible survives sanitization', () => {
      // A chip reading "Published with" and then nothing is worse than no chip.
      // `‮` is a bidi override; `​` a zero-width space — both stripped.
      expect(projectPostAppChip({ name: '‮​', appBlocks: [] })).toBeNull();
      expect(projectPostAppChip({ name: '   ', appBlocks: [] })).toBeNull();
      expect(projectPostAppChip({ name: undefined, appBlocks: [] })).toBeNull();
    });
  });

  it('sanitizes the publisher-controlled name', () => {
    // 🔴 Both names are publisher-controlled and this is the only place they are
    // cleaned. A bidi override here would reorder the rendered sentence inside
    // someone else's post header.
    const row = viewableRow();
    row.appBlocks[0].appListing.name = 'Gen‮Matrix​';
    const name = projectPostAppChip(row)?.name;
    expect(name).toBe('GenMatrix');
    expect(name).not.toContain('‮');
    expect(name).not.toContain('​');
  });

  it('is deterministic when an app owns several listed blocks', () => {
    // An `appblk-<slug>` client owns one block in practice, so this decides a
    // case that should not arise — but a chip that named a different app on two
    // identical reads would be worse than either answer. Viewable wins; ties
    // break on slug.
    const listing = (slug: string, status: string) => ({
      status: 'approved',
      appListing: { slug, name: slug, status, revisionOfId: null, icon: null },
    });
    const forward = {
      name: 'Client',
      appBlocks: [listing('zeta', 'removed'), listing('alpha', 'approved')],
    };
    const reversed = { name: 'Client', appBlocks: [...forward.appBlocks].reverse() };
    expect(projectPostAppChip(forward)).toEqual(projectPostAppChip(reversed));
    expect(projectPostAppChip(forward)?.slug).toBe('alpha');
  });

  it('returns null for an unresolvable marker', () => {
    // Branch (a): the dev-mint path writes a deliberately synthetic appId that
    // matches no OauthClient, so `findUnique` returns null by design.
    expect(projectPostAppChip(null)).toBeNull();
    expect(projectPostAppChip(undefined)).toBeNull();
  });
});
