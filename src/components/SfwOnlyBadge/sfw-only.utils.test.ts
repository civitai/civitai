import { afterEach, describe, expect, it } from 'vitest';
import {
  getResourceSfwOnlyMessage,
  isBaseModelSfwOnly,
  isEcosystemNsfwRestricted,
  SFW_ONLY_RESOURCE_TOOLTIP,
  SFW_ONLY_TOOLTIP,
} from '~/components/SfwOnlyBadge/sfw-only.utils';
import { baseModelByName, baseModelRecords, ECO } from '~/shared/constants/basemodel.constants';

const illustrious = baseModelByName.get('Illustrious')!;
afterEach(() => {
  delete (illustrious as { matureRestricted?: unknown }).matureRestricted;
});
const restrict = (surfaces: ('generation' | 'models' | 'images')[]) =>
  Object.assign(illustrious, { matureRestricted: surfaces });

describe('isBaseModelSfwOnly', () => {
  it.each(['Ideogram 4.5', 'SD 3.5 Large', 'SDXL Turbo'])('%s is SFW only', (name) => {
    expect(isBaseModelSfwOnly(name)).toBe(true);
  });

  it.each(['Nano Banana', 'Illustrious', 'SDXL 1.0', undefined, null, 'Not A Base'])(
    '%s is not',
    (name) => {
      expect(isBaseModelSfwOnly(name)).toBe(false);
    }
  );

  it('follows a base model that gains the images restriction', () => {
    restrict(['images']);
    expect(isBaseModelSfwOnly('Illustrious')).toBe(true);
  });
});

describe('isEcosystemNsfwRestricted', () => {
  it('marks Ideogram, where every base is SFW only', () => {
    expect(isEcosystemNsfwRestricted(ECO.Ideogram)).toBe(true);
  });

  it('does not mark Nano Banana, which restricts generation only', () => {
    expect(isEcosystemNsfwRestricted(ECO.NanoBanana)).toBe(false);
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

  it('gives a base that restricts generation the generation copy', () => {
    expect(getResourceSfwOnlyMessage(resource('SDXL Turbo'))).toBe(SFW_ONLY_RESOURCE_TOOLTIP);
    expect(getResourceSfwOnlyMessage(resource('Nano Banana'))).toBe(SFW_ONLY_RESOURCE_TOOLTIP);
  });

  it('gives a base that restricts only posting the posting copy', () => {
    restrict(['images']);
    expect(getResourceSfwOnlyMessage(resource('Illustrious'))).toBe(SFW_ONLY_TOOLTIP);
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
