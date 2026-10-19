import { describe, expect, it } from 'vitest';
import {
  HIDDEN_BY_ACCOUNT_DEFAULT,
  HIDDEN_BY_MODEL,
  inheritedMetricPrivacyHints,
} from '~/components/Resource/Forms/metric-privacy-hints';

describe('inheritedMetricPrivacyHints', () => {
  it('names the account default on exactly the metrics it hides', () => {
    expect(
      inheritedMetricPrivacyHints({
        userSettings: { hideModelDownloads: true, hideModelGenerations: true },
        isOwner: true,
      })
    ).toEqual({ downloads: HIDDEN_BY_ACCOUNT_DEFAULT, generations: HIDDEN_BY_ACCOUNT_DEFAULT });
  });

  it('names the model when the model hides a metric the account does not', () => {
    expect(
      inheritedMetricPrivacyHints({
        userSettings: { hideModelDownloads: true },
        modelMeta: { hideBuzz: true, hideDownloads: true },
        isOwner: true,
      })
    ).toEqual({ downloads: HIDDEN_BY_ACCOUNT_DEFAULT, buzz: HIDDEN_BY_MODEL });
  });

  it("ignores the editor's own defaults on a model they do not own", () => {
    expect(
      inheritedMetricPrivacyHints({
        userSettings: { hideModelDownloads: true },
        modelMeta: { hideGenerations: true },
        isOwner: false,
      })
    ).toEqual({ generations: HIDDEN_BY_MODEL });
  });
});
