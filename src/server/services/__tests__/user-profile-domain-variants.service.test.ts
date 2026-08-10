import { describe, it, expect, vi, beforeEach } from 'vitest';

// A creator can store an SFW override for their cover image, announcement and bio.
// The override is shown ONLY on the green domain (civitai.com); every other host keeps
// the default profile. These tests pin the two halves that matter:
//
//   1. Resolution — which stored value ends up in `profile.bio`/`message`/`coverImage`
//      for a given domain, including the per-field fallback (an override set for the bio
//      alone must not drag the announcement along) and the deliberate-blank case
//      (an empty override means "show nothing here on .com", not "inherit").
//   2. Containment — a visitor on the green domain must never RECEIVE the mature copy it
//      is being shown instead of. Hiding it in the UI is not enough; it must not be in
//      the payload at all. Only the owner (and moderators), who need both sides to edit
//      them, get the `default*`/`sfw*` pair.

const { userFindUniqueOrThrow, userProfileUpsert } = vi.hoisted(() => ({
  userFindUniqueOrThrow: vi.fn(),
  userProfileUpsert: vi.fn(async () => ({ userId: 1 })),
}));

vi.mock('~/server/db/client', () => {
  const db = {
    user: { findUniqueOrThrow: userFindUniqueOrThrow, findUnique: vi.fn() },
    userStat: { findFirst: vi.fn(async () => null) },
    userProfile: { upsert: userProfileUpsert, update: vi.fn() },
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
  };
  return { dbRead: db, dbWrite: db };
});
// Redis-backed; unused on the read path under test.
vi.mock('~/server/redis/caches', () => ({
  getUserContentOverview: vi.fn(async () => ({})),
  getUserContentOverviewPublic: vi.fn(async () => ({})),
  getUserContentOverviewSfw: vi.fn(async () => ({})),
}));
vi.mock('~/server/search-index', () => ({
  usersSearchIndex: { queueUpdate: vi.fn(async () => undefined) },
}));
vi.mock('~/server/services/image.service', () => ({
  enqueueImageIngestion: vi.fn(async () => undefined),
}));

import { getUserWithProfile } from '~/server/services/user-profile.service';

const USER_ID = 77;

const image = (id: number) => ({
  id,
  url: `image-${id}`,
  name: null,
  type: 'image',
  needsReview: null,
  ingestion: 'Scanned',
  meta: null,
  metadata: {},
  tags: [],
});

const MATURE = {
  bio: 'mature bio',
  message: 'mature announcement',
  messageAddedAt: new Date('2026-01-01T00:00:00Z'),
  coverImageId: 1,
  coverImage: image(1),
};

const SFW = {
  sfwBio: 'sfw bio',
  sfwMessage: 'sfw announcement',
  sfwMessageAddedAt: new Date('2026-02-02T00:00:00Z'),
  sfwCoverImageId: 2,
  sfwCoverImage: image(2),
};

function setProfile(overrides: Record<string, unknown> = {}) {
  userFindUniqueOrThrow.mockResolvedValue({
    id: USER_ID,
    username: 'creator',
    meta: {},
    settings: {},
    publicSettings: {},
    profile: {
      userId: USER_ID,
      privacySettings: {},
      profileSectionsSettings: [],
      showcaseItems: [],
      location: null,
      nsfw: false,
      ...MATURE,
      ...SFW,
      ...overrides,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setProfile();
});

describe('getUserWithProfile — SFW (civitai.com) profile overrides', () => {
  it('serves the override on the green domain', async () => {
    const { profile } = await getUserWithProfile({ id: USER_ID, domain: 'green' });

    expect(profile.bio).toBe('sfw bio');
    expect(profile.message).toBe('sfw announcement');
    expect(profile.messageAddedAt).toEqual(SFW.sfwMessageAddedAt);
    expect(profile.coverImageId).toBe(2);
    expect(profile.coverImage?.id).toBe(2);
  });

  it.each(['blue', 'red'] as const)(
    'serves the default profile on the %s domain',
    async (color) => {
      const { profile } = await getUserWithProfile({ id: USER_ID, domain: color });

      expect(profile.bio).toBe('mature bio');
      expect(profile.message).toBe('mature announcement');
      expect(profile.messageAddedAt).toEqual(MATURE.messageAddedAt);
      expect(profile.coverImageId).toBe(1);
      expect(profile.coverImage?.id).toBe(1);
    }
  );

  it('serves the default profile when the domain is unknown', async () => {
    // Fail toward the creator's own profile rather than an override they may not have set.
    const { profile } = await getUserWithProfile({ id: USER_ID });

    expect(profile.bio).toBe('mature bio');
    expect(profile.coverImage?.id).toBe(1);
  });

  it('falls back per field — an override on one field leaves the others alone', async () => {
    setProfile({ sfwMessage: null, sfwMessageAddedAt: null, sfwCoverImageId: null });

    const { profile } = await getUserWithProfile({ id: USER_ID, domain: 'green' });

    expect(profile.bio).toBe('sfw bio');
    expect(profile.message).toBe('mature announcement');
    expect(profile.messageAddedAt).toEqual(MATURE.messageAddedAt);
    expect(profile.coverImage?.id).toBe(1);
  });

  it('treats an empty override as a deliberate blank, not as "inherit"', async () => {
    // The only way to say "no announcement/bio at all on .com" — `null` already means inherit.
    setProfile({ sfwMessage: '', sfwBio: '' });

    const { profile } = await getUserWithProfile({ id: USER_ID, domain: 'green' });

    expect(profile.message).toBe('');
    expect(profile.bio).toBe('');
  });

  it('never sends the mature copy to a visitor on the green domain', async () => {
    const { profile } = await getUserWithProfile({ id: USER_ID, domain: 'green' });

    // Not merely unrendered — absent. Anything else leaks the bio the creator split out.
    expect(JSON.stringify(profile)).not.toContain('mature');
    expect(profile.defaultBio).toBeNull();
    expect(profile.defaultMessage).toBeNull();
    expect(profile.defaultCoverImage).toBeNull();
  });

  it('never sends the override to a visitor on a non-green domain', async () => {
    const { profile } = await getUserWithProfile({ id: USER_ID, domain: 'red' });

    // Key names carry the `sfw` prefix; the VALUES are what must be absent.
    const serialized = JSON.stringify(profile);
    expect(serialized).not.toContain('sfw bio');
    expect(serialized).not.toContain('sfw announcement');
    expect(serialized).not.toContain('image-2');
    expect(profile.sfwBio).toBeNull();
    expect(profile.sfwMessage).toBeNull();
    expect(profile.sfwCoverImage).toBeNull();
  });

  it.each([
    ['the owner', { sessionUserId: USER_ID }],
    ['a moderator', { isModerator: true }],
  ])('gives %s both stored variants so the editor can write either one', async (_label, actor) => {
    const { profile } = await getUserWithProfile({ id: USER_ID, domain: 'green', ...actor });

    // Display still resolves to the override…
    expect(profile.bio).toBe('sfw bio');
    // …but both sides are addressable, and `default*` is the unresolved copy — the editor
    // binds to it, so saving on .com cannot write the override back over the default.
    expect(profile.defaultBio).toBe('mature bio');
    expect(profile.defaultMessage).toBe('mature announcement');
    expect(profile.defaultCoverImage?.id).toBe(1);
    expect(profile.sfwBio).toBe('sfw bio');
    expect(profile.sfwMessage).toBe('sfw announcement');
    expect(profile.sfwCoverImage?.id).toBe(2);
  });

  it('withholds an override cover image that is pending moderation from visitors', async () => {
    setProfile({ sfwCoverImage: { ...image(2), needsReview: 'minor' } });

    const visitor = await getUserWithProfile({ id: USER_ID, domain: 'green' });
    expect(visitor.profile.coverImage).toBeNull();

    // The owner still sees their own, exactly as with the default cover image.
    const owner = await getUserWithProfile({
      id: USER_ID,
      domain: 'green',
      sessionUserId: USER_ID,
    });
    expect(owner.profile.coverImage?.id).toBe(2);
  });
});
