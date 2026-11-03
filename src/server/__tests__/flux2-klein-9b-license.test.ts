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
