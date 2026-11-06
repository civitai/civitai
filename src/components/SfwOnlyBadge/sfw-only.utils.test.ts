import { afterEach, describe, expect, it } from 'vitest';
import {
  getResourceSfwOnlyMessage,
  isBaseModelSfwOnly,
  isEcosystemNsfwRestricted,
  SFW_ONLY_RESOURCE_TOOLTIP,
  SFW_ONLY_TOOLTIP,
} from '~/components/SfwOnlyBadge/sfw-only.utils';
import { baseModelLicenses, nsfwRestrictedBaseModels } from '~/server/common/constants';
import { NsfwLevel } from '~/server/common/enums';
import type { BaseModel } from '~/shared/constants/basemodel.constants';
import { baseModelRecords, ECO } from '~/shared/constants/basemodel.constants';

const original = { ...baseModelLicenses };
afterEach(() => Object.assign(baseModelLicenses, original));

describe('isBaseModelSfwOnly', () => {
  it('marks exactly the bases the licence flags restrict', () => {
    const marked = baseModelRecords.map((r) => r.name).filter((name) => isBaseModelSfwOnly(name));
    expect(marked.sort()).toEqual([...nsfwRestrictedBaseModels].sort());
  });

  it.each(['Ideogram 4.5', 'SD 3.5 Large', 'SDXL Turbo'])('%s is SFW only', (name) => {
    expect(isBaseModelSfwOnly(name)).toBe(true);
  });

  it.each(['Illustrious', 'SDXL 1.0', 'Flux.2 D', undefined, null, 'Not A Base'])(
    '%s is not',
    (name) => {
      expect(isBaseModelSfwOnly(name)).toBe(false);
    }
  );

  // The badge reads the licence table, not a copied list: flagging a licence is the whole change.
  it('follows a licence that gains disableMature', () => {
    expect(isBaseModelSfwOnly('Illustrious')).toBe(false);
    baseModelLicenses['Illustrious' as BaseModel] = { url: '', name: 'Fake', disableMature: true };
    expect(isBaseModelSfwOnly('Illustrious')).toBe(true);
  });

  // Deliberate: a licence restricting only some mature levels is in nsfwRestrictedBaseModels but
  // "SFW only" would overstate it. It needs its own wording, not this badge.
  it('does not mark a licence that restricts only some mature levels', () => {
    baseModelLicenses['Illustrious' as BaseModel] = {
      url: '',
      name: 'Fake',
      restrictedNsfwLevels: [NsfwLevel.XXX],
    };
    expect(isBaseModelSfwOnly('Illustrious')).toBe(false);
  });
});

describe('isEcosystemNsfwRestricted', () => {
  it('marks Ideogram, where every base is restricted', () => {
    expect(isEcosystemNsfwRestricted(ECO.Ideogram)).toBe(true);
  });

  it('does not mark SDXL, which holds SDXL Turbo among unrestricted bases', () => {
    expect(
      baseModelRecords.some((r) => r.ecosystemId === ECO.SDXL && r.name === 'SDXL Turbo')
    ).toBe(true);
    expect(isEcosystemNsfwRestricted(ECO.SDXL)).toBe(false);
  });

  it('does not mark an ecosystem with no bases', () => {
    expect(isEcosystemNsfwRestricted(-1)).toBe(false);
  });
});

describe('getResourceSfwOnlyMessage', () => {
  const resource = (baseModel: string, model: { sfwOnly?: boolean; minor?: boolean } = {}) => ({
    baseModel,
    model,
  });

  it('gives a restricted base the posting copy', () => {
    expect(getResourceSfwOnlyMessage(resource('SDXL Turbo'))).toBe(SFW_ONLY_TOOLTIP);
  });

  it('keeps the stronger sfwOnly claim when the base is restricted too', () => {
    expect(getResourceSfwOnlyMessage(resource('SDXL Turbo', { sfwOnly: true }))).toBe(
      SFW_ONLY_RESOURCE_TOOLTIP
    );
  });

  it('keeps the minor claim on an unrestricted base', () => {
    expect(getResourceSfwOnlyMessage(resource('SDXL 1.0', { minor: true }))).toBe(
      SFW_ONLY_RESOURCE_TOOLTIP
    );
  });

  it('gives nothing for an unrestricted base', () => {
    expect(getResourceSfwOnlyMessage(resource('SDXL 1.0'))).toBeUndefined();
  });
});
