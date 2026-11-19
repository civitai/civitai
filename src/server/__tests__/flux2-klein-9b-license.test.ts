import { describe, expect, it } from 'vitest';
import {
  ECO,
  baseModelRecords,
  licenses as sharedLicenses,
} from '@civitai/shared/basemodel.constants';
import type { BaseModel } from '@civitai/shared/basemodel.constants';
import {
  baseModelLicenses,
  getEffectiveCommercialUse,
  getEffectiveDifferentLicense,
  nonCommercialBaseModels,
  sameLicenseBaseModels,
  stopsCreatorEarnings,
} from '~/server/common/constants';
import { CommercialUse } from '~/shared/utils/prisma/enums';

const PERMALINK =
  'https://huggingface.co/black-forest-labs/FLUX.2-klein-9B/blob/92196c8e11f7b6cf2b7493e037d8c5345c559216/LICENSE.md';

// Derived from the records so a renamed or added 9B base model fails here instead of going unlicensed.
const klein9bRecords = baseModelRecords.filter(
  (r) => r.ecosystemId === ECO.Flux2Klein_9B || r.ecosystemId === ECO.Flux2Klein_9B_base
);

describe('Flux.2 Klein 9B licence registration', () => {
  it('covers both 9B base models', () => {
    expect(klein9bRecords.map((r) => r.name).sort()).toEqual([
      'Flux.2 Klein 9B',
      'Flux.2 Klein 9B-base',
    ]);
  });

  it.each(klein9bRecords.map((r) => [r.name, r] as const))(
    '%s shows the FLUX Non-Commercial License, in both copies',
    (name, record) => {
      const server = baseModelLicenses[name as BaseModel];
      expect(server, `no licence bound for base model '${name}'`).toBeDefined();
      expect(server!.name).toBe('FLUX Non-Commercial License v2.1');
      expect(server!.url).toBe(PERMALINK);

      const shared = sharedLicenses.find((l) => l.id === record.licenseId);
      const { id: _id, ...sharedFields } = shared!;
      expect(sharedFields).toEqual(server);
    }
  );
});

describe('what a Flux.2 Klein 9B version shows', () => {
  it('shows no commercial use and no different licence on merges, whatever the creator chose', () => {
    expect(getEffectiveCommercialUse([CommercialUse.Sell], 'Flux.2 Klein 9B')).toEqual([
      CommercialUse.None,
    ]);
    expect(getEffectiveDifferentLicense(true, 'Flux.2 Klein 9B')).toBe(false);
    expect(getEffectiveDifferentLicense(true, 'Flux.2 Klein 9B-base')).toBe(false);
  });

  it('leaves the creator’s choices on Flux.2 Klein 4B (control)', () => {
    expect(getEffectiveCommercialUse([CommercialUse.Sell], 'Flux.2 Klein 4B')).toEqual([
      CommercialUse.Sell,
    ]);
    expect(getEffectiveDifferentLicense(true, 'Flux.2 Klein 4B')).toBe(true);
  });
});

describe('which non-commercial base models stop creator earnings', () => {
  // Pins today's decision that the two rules match; narrow this deliberately if they diverge.
  it('every non-commercial base model, and no commercial one', () => {
    expect(nonCommercialBaseModels.filter((b) => stopsCreatorEarnings(b))).toEqual(
      nonCommercialBaseModels
    );
    expect(nonCommercialBaseModels).toEqual(
      expect.arrayContaining([
        'Flux.2 Klein 9B',
        'Flux.2 Klein 9B-base',
        'Flux.3 Klein',
        'Flux.3 Klein-base',
        'Ideogram 4.0',
        'Qwen 2.1',
      ])
    );
    for (const commercial of ['Flux.2 Klein 4B', 'Flux.2 Klein 4B-base', 'SDXL 1.0'])
      expect(stopsCreatorEarnings(commercial)).toBe(false);
  });
});

describe('the older non-commercial base models', () => {
  const OLDER = ['Flux.1 Krea', 'Flux.1 Kontext', 'Flux.2 D', 'Stable Cascade'];
  const sharedFor = (name: string) => {
    const record = baseModelRecords.find((r) => r.name === name);
    expect(record, `no base model record named '${name}'`).toBeDefined();
    return sharedLicenses.find((l) => l.id === record!.licenseId);
  };

  it.each(OLDER)('%s is non-commercial in both licence copies and earns nothing', (name) => {
    expect(nonCommercialBaseModels).toContain(name);
    expect(stopsCreatorEarnings(name)).toBe(true);
    expect(sharedFor(name)?.nonCommercial).toBe(true);
    expect(getEffectiveCommercialUse([CommercialUse.Sell], name)).toEqual([CommercialUse.None]);
  });

  it.each(['Flux.1 D', 'SDXL 1.0'])('%s stays commercial in both copies (control)', (name) => {
    expect(nonCommercialBaseModels).not.toContain(name);
    expect(stopsCreatorEarnings(name)).toBe(false);
    expect(sharedFor(name)?.nonCommercial).toBeFalsy();
    expect(getEffectiveCommercialUse([CommercialUse.Sell], name)).toEqual([CommercialUse.Sell]);
  });

  it.each(['Flux.1 Krea', 'Flux.1 Kontext', 'Flux.2 D'])(
    '%s shows the same licence in both copies',
    (name) => {
      const { id: _id, ...sharedFields } = sharedFor(name)!;
      expect(sharedFields).toEqual(baseModelLicenses[name as BaseModel]);
    }
  );

  it('Krea and Kontext keep the FLUX.1 [dev] licence Flux.1 D shows', () => {
    const flux1D = baseModelLicenses['Flux.1 D']!;
    for (const name of ['Flux.1 Krea', 'Flux.1 Kontext'] as const) {
      const { nonCommercial: _nc, ...rest } = baseModelLicenses[name]!;
      expect(rest).toEqual(flux1D);
    }
  });

  it('Flux.2 D shows the FLUX Non-Commercial License v2.1 from the FLUX.2 [dev] repository', () => {
    const license = baseModelLicenses['Flux.2 D']!;
    expect(license.name).toBe('FLUX Non-Commercial License v2.1');
    expect(license.url).toBe(
      'https://huggingface.co/black-forest-labs/FLUX.2-dev/blob/26afe3a78bb242c0a8bb181dcc8937bb16e5c66c/LICENSE.md'
    );
    expect(getEffectiveDifferentLicense(true, 'Flux.2 D')).toBe(false);
    expect(sameLicenseBaseModels).toContain('Flux.2 D');
    expect(sameLicenseBaseModels).not.toContain('SDXL 1.0');
    expect(getEffectiveDifferentLicense(true, 'SDXL 1.0')).toBe(true);
  });
});
