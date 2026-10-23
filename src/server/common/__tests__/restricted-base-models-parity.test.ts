import { describe, expect, it } from 'vitest';
import { nsfwRestrictedBaseModels } from '~/server/common/constants';
import { baseModelRecords, licenseById } from '~/shared/constants/basemodel.constants';
import { NSFW_RESTRICTED_BASE_MODELS } from '../../../../apps/event-engine/src/common/constants/feed.constants';
import { NSFW_RESTRICTED_BASE_MODELS as SUBMODULE_RESTRICTED_BASE_MODELS } from '../../../../event-engine-common/constants/feed.constants';

// `nsfwRestrictedBaseModels` (derived from the licence flags in constants.ts) is the source. The
// shared registry and the event-engine feed keep their own copies; a base missing from the
// event-engine list has its R/X/XXX images served in feeds built there, and nothing alerts on it.
// The RestrictedBaseModels table is deliberately not checked here: it is guarded at runtime by
// the reconcile-restricted-images divergence gauge, and a test must not read production rows.
describe('restricted base models parity', () => {
  const source = [...nsfwRestrictedBaseModels].sort();

  it('shared registry licences flag the same bases', () => {
    const shared = baseModelRecords
      .filter((record) => record.licenseId && licenseById.get(record.licenseId)?.disableMature)
      .map((record) => record.name)
      .sort();
    expect(shared).toEqual(source);
  });

  it('event-engine feed restricts the same bases', () => {
    expect([...NSFW_RESTRICTED_BASE_MODELS].sort()).toEqual(source);
  });

  // The image and model feeds this app serves import the submodule's copy, not the one above.
  // `it.fails` until the pointer moves past civitai/event-engine-common#16 (adds Ideogram); that
  // bump turns this red, which is the cue to make it a plain `it`.
  it.fails('event-engine-common feed restricts the same bases', () => {
    expect([...SUBMODULE_RESTRICTED_BASE_MODELS].sort()).toEqual(source);
  });
});
