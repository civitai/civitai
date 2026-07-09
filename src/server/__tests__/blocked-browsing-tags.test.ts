import { describe, expect, it } from 'vitest';
import { isBlockedTagName, stripBlockedTagIds } from '~/server/utils/blocked-browsing-tags';
import {
  DEFAULT_BROWSING_SETTINGS_ADDONS,
  resolveBrowsingSettingsAddons,
} from '~/shared/constants/browsing-settings-addons';
import { NsfwLevel } from '~/server/common/enums';

describe('stripBlockedTagIds', () => {
  const blocked = [5188, 5249];

  it('passes through when no tag filter', () => {
    expect(stripBlockedTagIds(undefined, blocked)).toEqual({
      tagIds: undefined,
      emptyResult: false,
    });
    expect(stripBlockedTagIds([], blocked)).toEqual({ tagIds: [], emptyResult: false });
  });

  it('removes blocked ids but keeps allowed ones', () => {
    expect(stripBlockedTagIds([5188, 100], blocked)).toEqual({ tagIds: [100], emptyResult: false });
  });

  it('short-circuits to empty when every requested tag is blocked', () => {
    expect(stripBlockedTagIds([5188, 5249], blocked)).toEqual({ tagIds: [], emptyResult: true });
  });

  it('leaves a non-blocked filter untouched', () => {
    expect(stripBlockedTagIds([100, 200], blocked)).toEqual({
      tagIds: [100, 200],
      emptyResult: false,
    });
  });
});

describe('isBlockedTagName', () => {
  const blocked = ['celebrity', 'real person'];

  it('matches case-insensitively', () => {
    expect(isBlockedTagName('Celebrity', blocked)).toBe(true);
    expect(isBlockedTagName('REAL PERSON', blocked)).toBe(true);
  });

  it('returns false for allowed or missing names', () => {
    expect(isBlockedTagName('cat', blocked)).toBe(false);
    expect(isBlockedTagName(undefined, blocked)).toBe(false);
  });
});

describe('resolveBrowsingSettingsAddons (server derivation)', () => {
  it('excludes POI tags + disablePoi at PG for non-moderators', () => {
    const resolved = resolveBrowsingSettingsAddons(DEFAULT_BROWSING_SETTINGS_ADDONS, NsfwLevel.PG);
    expect(resolved.disablePoi).toBe(true);
    expect(resolved.excludedTagIds).toContain(5188); // celebrity
    // minor addon only applies at R+; not at PG
    expect(resolved.disableMinor).toBe(false);
    expect(resolved.excludedTagIds).not.toContain(5351); // child
  });

  it('applies the minor addon at R', () => {
    const resolved = resolveBrowsingSettingsAddons(DEFAULT_BROWSING_SETTINGS_ADDONS, NsfwLevel.R);
    expect(resolved.disableMinor).toBe(true);
    expect(resolved.excludedTagIds).toContain(5351); // child
  });

  it('bypasses all exclusions for moderators', () => {
    const resolved = resolveBrowsingSettingsAddons(DEFAULT_BROWSING_SETTINGS_ADDONS, NsfwLevel.R, {
      isModerator: true,
    });
    expect(resolved.disablePoi).toBe(false);
    expect(resolved.disableMinor).toBe(false);
    expect(resolved.excludedTagIds).toHaveLength(0);
  });
});
