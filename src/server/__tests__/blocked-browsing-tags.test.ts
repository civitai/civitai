import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isBlockedTagName, stripBlockedTagIds } from '~/server/utils/blocked-browsing-tags';
import type { BrowsingSettingsAddon } from '~/shared/constants/browsing-settings-addons';
import {
  DEFAULT_BROWSING_SETTINGS_ADDONS,
  resolveBrowsingSettingsAddons,
} from '~/shared/constants/browsing-settings-addons';
import { getBrowsingSettingAddons } from '~/server/services/system-cache';
import { NsfwLevel } from '~/server/common/enums';
import {
  allBrowsingLevelsFlag,
  publicBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import {
  enforceBlockedBrowsingTags,
  enforceBlockedBrowsingTagsForModels,
} from '~/server/services/blocked-browsing-tags.service';

vi.mock('~/server/services/system-cache', async () => {
  const { DEFAULT_BROWSING_SETTINGS_ADDONS } = await import(
    '~/shared/constants/browsing-settings-addons'
  );
  return {
    getBlockedBrowsingTags: vi.fn(async () => [
      { id: 5188, name: 'celebrity' },
      { id: 5351, name: 'child' },
    ]),
    getBrowsingSettingAddons: vi.fn(async () => DEFAULT_BROWSING_SETTINGS_ADDONS),
  };
});

describe('scoped addon entries', () => {
  const SCOPED_TAG = 987654;
  const GLOBAL_TAG = 123456;
  const addons: BrowsingSettingsAddon[] = [
    {
      type: 'some',
      nsfwLevels: [NsfwLevel.PG, NsfwLevel.PG13, NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX],
      excludedTagIds: [GLOBAL_TAG],
    },
    {
      type: 'some',
      nsfwLevels: [NsfwLevel.PG, NsfwLevel.PG13, NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX],
      excludedTagIds: [SCOPED_TAG],
      scope: 'newCreators',
    },
  ];

  it('skips a scoped entry when no scope is active', () => {
    const resolved = resolveBrowsingSettingsAddons(addons, publicBrowsingLevelsFlag);
    expect(resolved.excludedTagIds).toContain(GLOBAL_TAG);
    expect(resolved.excludedTagIds).not.toContain(SCOPED_TAG);
  });

  it('applies a scoped entry when its scope is active', () => {
    const resolved = resolveBrowsingSettingsAddons(addons, publicBrowsingLevelsFlag, {
      scope: 'newCreators',
    });
    expect(resolved.excludedTagIds).toContain(SCOPED_TAG);
    expect(resolved.excludedTagIds).toContain(GLOBAL_TAG);
  });

  describe('enforceBlockedBrowsingTags derives the scope from the input', () => {
    beforeEach(() => {
      vi.mocked(getBrowsingSettingAddons).mockResolvedValue(addons);
    });
    afterEach(() => {
      vi.mocked(getBrowsingSettingAddons).mockResolvedValue(DEFAULT_BROWSING_SETTINGS_ADDONS);
    });

    it('excludes the scoped tag on a new-creators feed', async () => {
      const input: { browsingLevel: number; newCreators?: boolean; excludedTagIds?: number[] } = {
        browsingLevel: publicBrowsingLevelsFlag,
        newCreators: true,
      };
      await enforceBlockedBrowsingTags(input, { id: 1 });
      expect(input.excludedTagIds).toContain(SCOPED_TAG);
    });

    // The bug this scoping exists to prevent: a global entry filtered the tag out of
    // the board's own collection block, which fetches a fixed page and drops filtered
    // items without backfilling.
    it('leaves the scoped tag alone on an ordinary feed', async () => {
      const input: { browsingLevel: number; newCreators?: boolean; excludedTagIds?: number[] } = {
        browsingLevel: publicBrowsingLevelsFlag,
      };
      await enforceBlockedBrowsingTags(input, { id: 1 });
      expect(input.excludedTagIds ?? []).not.toContain(SCOPED_TAG);
      expect(input.excludedTagIds).toContain(GLOBAL_TAG);
    });

    it('excludes the scoped tag on a new-creators MODEL feed', async () => {
      const input: { browsingLevel: number; newCreators?: boolean; excludedTagIds?: number[] } = {
        browsingLevel: publicBrowsingLevelsFlag,
        newCreators: true,
      };
      await enforceBlockedBrowsingTagsForModels(input, { id: 1 });
      expect(input.excludedTagIds).toContain(SCOPED_TAG);
    });

    it('leaves the scoped tag alone on an ordinary model feed', async () => {
      const input: { browsingLevel: number; newCreators?: boolean; excludedTagIds?: number[] } = {
        browsingLevel: publicBrowsingLevelsFlag,
      };
      await enforceBlockedBrowsingTagsForModels(input, { id: 1 });
      expect(input.excludedTagIds ?? []).not.toContain(SCOPED_TAG);
    });
  });

  it('drops an entry whose scope is not a known surface, and says so', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const typo = [
      { ...addons[1], scope: 'newCreator' as BrowsingSettingsAddon['scope'] },
    ] as BrowsingSettingsAddon[];

    const resolved = resolveBrowsingSettingsAddons(typo, publicBrowsingLevelsFlag, {
      scope: 'newCreators',
    });

    expect(resolved.excludedTagIds).not.toContain(SCOPED_TAG);
    expect(consoleError).toHaveBeenCalledWith(
      'Unrecognized browsing settings addon scope:',
      'newCreator'
    );
    consoleError.mockRestore();
  });
});

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

describe('enforceBlockedBrowsingTags', () => {
  it('treats browsingLevel:0 as public — exclusions still applied', async () => {
    const input = { browsingLevel: 0, tags: undefined } as {
      browsingLevel: number;
      tags?: number[];
      excludedTagIds?: number[];
      disablePoi?: boolean;
    };
    const result = await enforceBlockedBrowsingTags(input, { id: undefined });
    expect(result.emptyResult).toBe(false);
    expect(input.disablePoi).toBe(true);
    expect(input.excludedTagIds).toContain(5188);
  });

  it('short-circuits to empty when the tag filter is entirely blocked', async () => {
    const input = { tags: [5188, 5351], browsingLevel: NsfwLevel.PG };
    const result = await enforceBlockedBrowsingTags(input, { id: 1 });
    expect(result.emptyResult).toBe(true);
  });

  it('strips blocked ids from a mixed tag filter, including for moderators', async () => {
    const input = { tags: [5188, 999], browsingLevel: NsfwLevel.PG } as {
      tags?: number[];
      browsingLevel: number;
      excludedTagIds?: number[];
    };
    const result = await enforceBlockedBrowsingTags(input, { id: 1, isModerator: true });
    expect(result.emptyResult).toBe(false);
    expect(input.tags).toEqual([999]);
    expect(input.excludedTagIds).toBeUndefined();
  });

  it('skips the excludedTagIds union for own-scoped feeds but keeps disablePoi', async () => {
    const input = { userId: 7, browsingLevel: NsfwLevel.PG } as {
      userId: number;
      browsingLevel: number;
      excludedTagIds?: number[];
      disablePoi?: boolean;
    };
    await enforceBlockedBrowsingTags(input, { id: 7 });
    expect(input.excludedTagIds).toBeUndefined();
    expect(input.disablePoi).toBe(true);
  });

  it('unions addon exclusions into a non-own feed and preserves client-sent ids', async () => {
    const input = { excludedTagIds: [42], browsingLevel: NsfwLevel.PG } as {
      excludedTagIds?: number[];
      browsingLevel: number;
    };
    await enforceBlockedBrowsingTags(input, { id: 1 });
    expect(input.excludedTagIds).toContain(42);
    expect(input.excludedTagIds).toContain(5188);
  });
});

describe('enforceBlockedBrowsingTagsForModels', () => {
  it('short-circuits on a blocked tag name regardless of casing', async () => {
    const result = await enforceBlockedBrowsingTagsForModels(
      { tagname: 'Celebrity', browsingLevel: NsfwLevel.PG },
      { id: 1, isModerator: true }
    );
    expect(result.emptyResult).toBe(true);
  });

  it('passes non-blocked tag names through with exclusions applied', async () => {
    const input = { tag: 'cat', browsingLevel: NsfwLevel.PG } as {
      tag?: string;
      browsingLevel: number;
      excludedTagIds?: number[];
    };
    const result = await enforceBlockedBrowsingTagsForModels(input, { id: 1 });
    expect(result.emptyResult).toBe(false);
    expect(input.excludedTagIds).toContain(5188);
  });

  // The exact two levels /api/v1/models derives from `?nsfw` (models/index.ts).
  // /api/v1/models no longer passes disableMinor itself, so THIS is what decides
  // whether the list hides minor models — assert the end state, not just that the
  // endpoint forwards no opinion.
  it('derives disableMinor from the browsing level the list endpoint passes', async () => {
    const sfw = { browsingLevel: publicBrowsingLevelsFlag } as {
      browsingLevel: number;
      disableMinor?: boolean;
    };
    await enforceBlockedBrowsingTagsForModels(sfw, { id: 1 });
    expect(sfw.disableMinor).toBe(false);

    const nsfw = { browsingLevel: allBrowsingLevelsFlag } as {
      browsingLevel: number;
      disableMinor?: boolean;
    };
    await enforceBlockedBrowsingTagsForModels(nsfw, { id: 1 });
    expect(nsfw.disableMinor).toBe(true);
  });

  it('ignoreBrowsingAddons drops the minor gate AND the tag union, but keeps disablePoi', async () => {
    // Uniformity with /models/{id}: the site serves minor + child-tagged models
    // at a direct id and 404s POI ones, so the by-id API must do the same.
    const input = { browsingLevel: NsfwLevel.R } as {
      browsingLevel: number;
      disableMinor?: boolean;
      disablePoi?: boolean;
      excludedTagIds?: number[];
    };
    await enforceBlockedBrowsingTagsForModels(input, { id: 1 }, { ignoreBrowsingAddons: true });
    expect(input.disableMinor).toBeUndefined();
    expect(input.excludedTagIds).toBeUndefined();
    expect(input.disablePoi).toBe(true);
  });

  it('ignoreBrowsingAddons never overrides caller-set values', async () => {
    const input = { browsingLevel: NsfwLevel.PG, disableMinor: true, excludedTagIds: [42] };
    await enforceBlockedBrowsingTagsForModels(input, { id: 1 }, { ignoreBrowsingAddons: true });
    expect(input.disableMinor).toBe(true);
    expect(input.excludedTagIds).toEqual([42]);
  });
});
