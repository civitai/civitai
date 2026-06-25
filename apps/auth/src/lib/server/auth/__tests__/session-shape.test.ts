import { describe, it, expect } from 'vitest';
import {
  shapeSessionUser,
  type ProducerUserRow,
  type ProducerSubscriptionRow,
} from '../session-shape';

const baseRow = (over: Partial<ProducerUserRow> = {}): ProducerUserRow => ({
  id: 5,
  username: 'alice',
  name: 'Alice',
  email: 'alice@example.com',
  emailVerified: null,
  image: null,
  createdAt: new Date('2020-01-01T00:00:00Z'),
  isModerator: false,
  showNsfw: true,
  blurNsfw: false,
  browsingLevel: 7,
  onboarding: 3,
  muted: false,
  mutedAt: null,
  bannedAt: null,
  deletedAt: null,
  customerId: null,
  paddleCustomerId: null,
  autoplayGifs: null,
  leaderboardShowcase: null,
  filePreferences: {},
  settings: {},
  meta: {},
  profilePicture: null,
  referral: null,
  ...over,
});

const sub = (over: Partial<ProducerSubscriptionRow> = {}): ProducerSubscriptionRow => ({
  id: 'sub_1',
  status: 'active',
  buzzType: 'generation',
  product: { metadata: { tier: 'gold' } },
  ...over,
});

const shape = (
  row: Partial<ProducerUserRow> = {},
  subscriptionRows: ProducerSubscriptionRow[] = [],
  permissions: string[] = [],
  tierKey: string | undefined = 'tier'
) => shapeSessionUser({ row: baseRow(row), subscriptionRows, permissions, tierKey });

describe('shapeSessionUser — field mapping', () => {
  it('maps the base identity fields', () => {
    const u = shape({ id: 5, username: 'alice', email: 'alice@example.com', isModerator: true });
    expect(u).toMatchObject({
      id: 5,
      username: 'alice',
      email: 'alice@example.com',
      isModerator: true,
      showNsfw: true,
      blurNsfw: false,
      browsingLevel: 7,
      onboarding: 3,
    });
  });

  it('coerces date columns to Date', () => {
    const u = shape({ emailVerified: '2021-05-05T00:00:00Z', bannedAt: '2022-01-01T00:00:00Z' });
    expect(u.emailVerified).toBeInstanceOf(Date);
    expect(u.bannedAt).toBeInstanceOf(Date);
    expect(u.createdAt).toBeInstanceOf(Date);
  });

  it('leaves null date columns undefined', () => {
    const u = shape({ mutedAt: null, bannedAt: null, deletedAt: null, emailVerified: null });
    expect(u.mutedAt).toBeUndefined();
    expect(u.bannedAt).toBeUndefined();
    expect(u.deletedAt).toBeUndefined();
    expect(u.emailVerified).toBeUndefined();
  });

  it('prefers the profile-picture url over the user image, then falls back', () => {
    expect(shape({ image: 'img.png', profilePicture: { url: 'pfp.png' } }).image).toBe('pfp.png');
    expect(shape({ image: 'img.png', profilePicture: null }).image).toBe('img.png');
    expect(shape({ image: null, profilePicture: null }).image).toBeUndefined();
  });

  it('passes permissions straight through', () => {
    expect(shape({}, [], ['feature:a', 'feature:b']).permissions).toEqual(['feature:a', 'feature:b']);
  });

  it('coerces filePreferences to an object (never a primitive)', () => {
    expect(shape({ filePreferences: { size: 'full' } }).filePreferences).toEqual({ size: 'full' });
    expect(shape({ filePreferences: null }).filePreferences).toEqual({});
    expect(shape({ filePreferences: 'nope' }).filePreferences).toEqual({});
  });
});

describe('shapeSessionUser — tier / subscriptions', () => {
  it('resolves tier + subscription entry for a single active sub', () => {
    const u = shape({}, [sub({ id: 'sub_1', status: 'active', product: { metadata: { tier: 'gold' } } })]);
    expect(u.tier).toBe('gold');
    expect(u.subscriptionId).toBe('sub_1');
    expect(u.memberInBadState).toBe(false);
    expect(u.subscriptions).toEqual({
      generation: { tier: 'gold', isMember: true, subscriptionId: 'sub_1', status: 'active' },
    });
    expect(u.allowAds).toBe(false); // member → no ads
  });

  it('picks the highest active tier across subs', () => {
    const u = shape({}, [
      sub({ id: 'a', buzzType: 'blue', product: { metadata: { tier: 'bronze' } } }),
      sub({ id: 'b', buzzType: 'generation', product: { metadata: { tier: 'founder' } } }),
      sub({ id: 'c', buzzType: 'green', product: { metadata: { tier: 'silver' } } }),
    ]);
    expect(u.tier).toBe('founder');
    expect(u.subscriptionId).toBe('b');
  });

  it('excludes the "free" tier', () => {
    const u = shape({}, [sub({ product: { metadata: { tier: 'free' } } })]);
    expect(u.tier).toBeUndefined();
    expect(u.subscriptions).toEqual({});
    expect(u.allowAds).toBe(true); // no paid tier → ads
  });

  it('flags memberInBadState and keeps a primary sub id from a bad-state sub', () => {
    const u = shape({}, [sub({ id: 'bad', status: 'past_due', product: { metadata: { tier: 'gold' } } })]);
    expect(u.memberInBadState).toBe(true);
    expect(u.tier).toBeUndefined(); // bad-state isn't "active", so no highest tier
    expect(u.subscriptionId).toBe('bad'); // but the bad-state sub is tracked so the user can manage it
    expect(u.subscriptions).toMatchObject({ generation: { isMember: false, status: 'past_due' } });
  });

  it('resolves no tier when tierKey is unset', () => {
    // call directly — passing explicit `undefined` to the `shape` helper would hit its default tierKey
    const u = shapeSessionUser({
      row: baseRow(),
      subscriptionRows: [sub({ product: { metadata: { tier: 'gold' } } })],
      permissions: [],
      tierKey: undefined,
    });
    expect(u.tier).toBeUndefined();
    expect(u.subscriptions).toEqual({});
  });

  it('handles a missing product / metadata without throwing', () => {
    const u = shape({}, [sub({ product: null }), sub({ id: 's2', product: { metadata: null } })]);
    expect(u.tier).toBeUndefined();
    expect(u.subscriptions).toEqual({});
  });
});

describe('shapeSessionUser — client-only fields (D parity)', () => {
  it('maps name / autoplayGifs / leaderboardShowcase / referral from the row', () => {
    const u = shape({
      name: 'Alice',
      autoplayGifs: true,
      leaderboardShowcase: 'overall',
      referral: { id: 42 },
    });
    expect(u.name).toBe('Alice');
    expect(u.autoplayGifs).toBe(true);
    expect(u.leaderboardShowcase).toBe('overall');
    expect(u.referral).toEqual({ id: 42 });
  });

  it('leaves null client-only columns undefined', () => {
    const u = shape({ name: null, autoplayGifs: null, leaderboardShowcase: null, referral: null });
    expect(u.name).toBeUndefined();
    expect(u.autoplayGifs).toBeUndefined();
    expect(u.leaderboardShowcase).toBeUndefined();
    expect(u.referral).toBeUndefined();
  });
});

describe('shapeSessionUser — allowAds / redBrowsingLevel from settings (D)', () => {
  it('honors an explicit allowAds in settings over the tier default', () => {
    // free user defaults to allowAds=true, but an explicit false wins
    expect(shape({ settings: { allowAds: false } }).allowAds).toBe(false);
    // member defaults to allowAds=false, but an explicit true wins
    expect(shape({ settings: { allowAds: true } }, [sub()]).allowAds).toBe(true);
  });

  it('falls back to the tier default when settings has no allowAds', () => {
    expect(shape({ settings: {} }).allowAds).toBe(true); // free → ads
    expect(shape({ settings: {} }, [sub()]).allowAds).toBe(false); // member → no ads
  });

  it('honors redBrowsingLevel from settings, else undefined', () => {
    expect(shape({ settings: { redBrowsingLevel: 31 } }).redBrowsingLevel).toBe(31);
    expect(shape({ settings: {} }).redBrowsingLevel).toBeUndefined();
  });

  it('treats a null / garbage / mistyped settings blob as no settings (tier default)', () => {
    expect(shape({ settings: null }).allowAds).toBe(true);
    expect(shape({ settings: 'nope' }).allowAds).toBe(true);
    // a mistyped allowAds (wrong type) is ignored → tier default, not a throw
    expect(shape({ settings: { allowAds: 'yes' } }).allowAds).toBe(true);
    expect(shape({ settings: { redBrowsingLevel: 'high' } }).redBrowsingLevel).toBeUndefined();
  });
});

describe('shapeSessionUser — meta / banDetails (parity)', () => {
  it('strips banDetails out of the output meta and yields undefined banDetails', () => {
    const u = shape({
      meta: { banDetails: { reasonCode: 'Other', detailsExternal: 'x' }, scores: { total: 1 } },
    });
    // parity with the main app: banDetails is stripped before reading → effectively undefined
    expect(u.banDetails).toBeUndefined();
    expect(u.meta).toEqual({ scores: { total: 1 } });
    expect((u.meta as Record<string, unknown>).banDetails).toBeUndefined();
  });

  it('treats a null/garbage meta as an empty object', () => {
    expect(shape({ meta: null }).meta).toEqual({});
    expect(shape({ meta: 'nope' }).meta).toEqual({});
  });
});
