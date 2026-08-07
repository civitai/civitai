import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { removeEmpty } from '~/utils/object-helpers';

/**
 * `ImagesInfinite` merges the localStorage-backed filter store under the caller's
 * overrides and then drops nil values (`removeEmpty({ ...storeFilters, ...overrides })`).
 * An override key set to `undefined` therefore DELETES the stored value; a key the
 * override never mentions SURVIVES into the query.
 *
 * Both halves of the audience selector — `followed` and `newCreators` — are written to
 * the store by FollowedFilter, so a profile tab that neutralizes only `followed` still
 * inherits `newCreators: true` from the main feed. The server then ANDs the profile's
 * userId with the new-creators leaderboard and the tab renders empty.
 */
const mergeFilters = (store: Record<string, unknown>, overrides: Record<string, unknown>) =>
  removeEmpty({ ...store, ...overrides });

const AUDIENCE_STORE = { followed: false, newCreators: true, period: 'Week' };

describe('profile media filter overrides', () => {
  it('drops both audience keys when the override neutralizes both', () => {
    const merged = mergeFilters(AUDIENCE_STORE, {
      followed: undefined,
      newCreators: undefined,
      userId: 42,
    });

    expect(merged).not.toHaveProperty('followed');
    expect(merged).not.toHaveProperty('newCreators');
    expect(merged).toMatchObject({ userId: 42, period: 'Week' });
  });

  it('leaks newCreators when the override omits it (the regression)', () => {
    const merged = mergeFilters(AUDIENCE_STORE, { followed: undefined, userId: 42 });

    expect(merged).toHaveProperty('newCreators', true);
  });
});

const readSource = (relative: string) => readFileSync(path.resolve(__dirname, relative), 'utf8');

/**
 * Drift guard. FollowedFilter's `setFilters({ ... })` call is the only writer of audience
 * state into the filter store, so its key list — not a copy of it — is the set a feed with
 * its own scope has to neutralize. A third audience key added there without a matching
 * override would reproduce this bug, and an expectation hardcoded here would stay green
 * through it.
 */
const audienceStoreKeys = (() => {
  const source = readSource('../../../Filters/FollowedFilter.tsx');
  const call = /setFilters\(\{([^}]*)\}\)/.exec(source);
  if (!call) throw new Error('FollowedFilter no longer writes audience state via setFilters');
  return call[1]
    .split(',')
    .map((entry) => entry.split(':')[0].trim())
    .filter(Boolean);
})();

// Feeds that carry their own scope and so must neutralize the stored audience, whether
// they pass the key through from the URL (`newCreators,`) or pin it (`newCreators: false`).
const SCOPED_FEEDS = [
  { name: 'UserMediaInfinite', file: '../UserMediaInfinite.tsx' },
  { name: 'home feed', file: '../../../../pages/home/index.tsx' },
];

describe('audience filter neutralization', () => {
  it('reads a non-empty audience key set from FollowedFilter', () => {
    expect(audienceStoreKeys).toEqual(expect.arrayContaining(['followed', 'newCreators']));
  });

  it.each(SCOPED_FEEDS)('$name passes every audience key into its override', ({ file }) => {
    const source = readSource(file);
    const overrides = source.slice(source.indexOf('<ImagesInfinite'));

    for (const key of audienceStoreKeys) {
      expect(overrides).toMatch(new RegExp(`\\b${key}\\s*[,:]`));
    }
  });
});
