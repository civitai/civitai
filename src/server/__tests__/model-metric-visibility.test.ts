import { describe, expect, it } from 'vitest';
import {
  getMetaMetricPrivacy,
  pickMetaMetricPrivacy,
  resolveModelHiddenMetrics,
  resolveVersionHiddenMetrics,
  type HiddenModelMetrics,
} from '~/server/utils/model-metric-privacy';

/**
 * Model and version metric settings are tri-state (inherit / hide / show) and the nearest explicit one
 * wins. Rows written before that are legacy `hideX` booleans; the rule must leave every one of them
 * showing what it showed under the old OR, which is copied below as the oracle.
 */

const KEYS = ['buzz', 'downloads', 'generations'] as const;
const LEGACY = { buzz: 'hideBuzz', downloads: 'hideDownloads', generations: 'hideGenerations' };
const ACCOUNT = {
  buzz: 'hideModelBuzz',
  downloads: 'hideModelDownloads',
  generations: 'hideModelGenerations',
};

// The resolution as it stood before tri-state settings: hidden if ANY level hides.
function legacyOr(levels: Record<string, unknown>[], account: Record<string, unknown>) {
  const hidden = {} as HiddenModelMetrics;
  for (const key of KEYS)
    hidden[key] = levels.some((meta) => !!meta[LEGACY[key]]) || !!account[ACCOUNT[key]];
  return hidden;
}

// absent / false / true for each metric, at one level.
function* legacyMetas(): Generator<Record<string, unknown>> {
  const states = [undefined, false, true];
  for (const buzz of states)
    for (const downloads of states)
      for (const generations of states) {
        const meta: Record<string, unknown> = {};
        if (buzz !== undefined) meta.hideBuzz = buzz;
        if (downloads !== undefined) meta.hideDownloads = downloads;
        if (generations !== undefined) meta.hideGenerations = generations;
        yield meta;
      }
}

function* accounts(): Generator<Record<string, unknown>> {
  for (let mask = 0; mask < 8; mask++)
    yield {
      hideModelBuzz: !!(mask & 1),
      hideModelDownloads: !!(mask & 2),
      hideModelGenerations: !!(mask & 4),
    };
}

const member = { isOwnerOrModerator: false, hasValidMembership: true };

describe('legacy flags under nearest-explicit-wins', () => {
  it('leave every model-level combination exactly as the OR rule showed it', () => {
    let checked = 0;
    for (const userSettings of accounts())
      for (const modelMeta of legacyMetas()) {
        expect(resolveModelHiddenMetrics({ modelMeta, userSettings, ...member })).toEqual(
          legacyOr([modelMeta], userSettings)
        );
        checked++;
      }
    expect(checked).toBe(8 * 27);
  });

  it('leave every version-level combination exactly as the OR rule showed it', () => {
    let checked = 0;
    const metas = [...legacyMetas()];
    for (const userSettings of accounts())
      for (const modelMeta of metas)
        for (const versionMeta of metas) {
          expect(
            resolveVersionHiddenMetrics({ versionMeta, modelMeta, userSettings, ...member })
          ).toEqual(legacyOr([versionMeta, modelMeta], userSettings));
          checked++;
        }
    expect(checked).toBe(8 * 27 * 27);
  });
});

describe('explicit settings', () => {
  const hiddenDownloadsAccount = { hideModelDownloads: true };

  it('a model set to show reveals a stat the account default hides', () => {
    expect(
      resolveModelHiddenMetrics({
        modelMeta: { metricVisibility: { downloads: 'show' } },
        userSettings: hiddenDownloadsAccount,
        ...member,
      }).downloads
    ).toBe(false);
  });

  it('a version set to show reveals its count under a model that hides it', () => {
    expect(
      resolveVersionHiddenMetrics({
        versionMeta: { metricVisibility: { buzz: 'show' } },
        modelMeta: { hideBuzz: true },
        ...member,
      }).buzz
    ).toBe(false);
  });

  it('a version set to hide wins over a model set to show', () => {
    expect(
      resolveVersionHiddenMetrics({
        versionMeta: { metricVisibility: { generations: 'hide' } },
        modelMeta: { metricVisibility: { generations: 'show' } },
        ...member,
      }).generations
    ).toBe(true);
  });

  it('an inheriting version takes the model setting over the account default', () => {
    expect(
      resolveVersionHiddenMetrics({
        versionMeta: {},
        modelMeta: { metricVisibility: { downloads: 'show' } },
        userSettings: hiddenDownloadsAccount,
        ...member,
      }).downloads
    ).toBe(false);
  });

  it('a version setting never changes the model page totals', () => {
    expect(
      resolveModelHiddenMetrics({
        modelMeta: { hideBuzz: true },
        ...member,
      }).buzz
    ).toBe(true);
  });

  it('the new setting wins over a legacy flag on the same entity', () => {
    expect(
      resolveModelHiddenMetrics({
        modelMeta: { hideDownloads: true, metricVisibility: { downloads: 'show' } },
        ...member,
      }).downloads
    ).toBe(false);
  });

  it('an unknown setting value falls back to the legacy flag', () => {
    expect(
      resolveModelHiddenMetrics({
        modelMeta: { hideBuzz: true, metricVisibility: { buzz: 'visible' } },
        ...member,
      }).buzz
    ).toBe(true);
  });

  it('nothing is hidden for a lapsed creator or for the owner, whatever is set', () => {
    const args = {
      versionMeta: { metricVisibility: { buzz: 'hide' } },
      modelMeta: { metricVisibility: { downloads: 'hide' } },
      userSettings: { hideModelGenerations: true },
    };
    const none = { buzz: false, downloads: false, generations: false };
    expect(resolveVersionHiddenMetrics({ ...args, hasValidMembership: false })).toEqual(none);
    expect(
      resolveVersionHiddenMetrics({ ...args, isOwnerOrModerator: true, hasValidMembership: true })
    ).toEqual(none);
  });
});

describe('carrying the privacy fields apart from meta', () => {
  it('resolves the same from the picked fields as from the whole meta', () => {
    const meta = {
      showcaseCollectionId: 3,
      hideGenerations: true,
      metricVisibility: { downloads: 'show', buzz: 'hide' },
    };
    const userSettings = { hideModelDownloads: true };
    expect(
      resolveModelHiddenMetrics({ modelMeta: pickMetaMetricPrivacy(meta), userSettings, ...member })
    ).toEqual(resolveModelHiddenMetrics({ modelMeta: meta, userSettings, ...member }));
  });

  it('counts only explicit hides as needing the membership check', () => {
    expect(getMetaMetricPrivacy({ metricVisibility: { buzz: 'show' } })).toEqual({
      buzz: false,
      downloads: false,
      generations: false,
    });
    expect(getMetaMetricPrivacy({ metricVisibility: { buzz: 'hide' } }).buzz).toBe(true);
  });
});
