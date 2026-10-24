import { describe, expect, it } from 'vitest';
import {
  ECO,
  baseModelRecords,
  licenses as sharedLicenses,
} from '@civitai/shared/basemodel.constants';
import { baseModelLicenses } from '~/server/common/constants';
import type { BaseModel } from '@civitai/shared/basemodel.constants';

// The licence link on the Krea 2 Raw and Turbo model cards, pinned to the commit that
// published the 22 Jun 2026 text.
const PERMALINK =
  'https://cdn.jsdelivr.net/gh/krea-ai/krea-2@db3984fbc6e13b34c0064990fc2d95ac64d00058/assets/hf_samples/LICENSE.pdf';

// Derived from the records so a renamed base model fails here instead of going unlicensed.
const krea2Records = baseModelRecords.filter((r) => r.ecosystemId === ECO.Krea2);

describe('Krea 2 licence registration', () => {
  it('covers both checkpoints', () => {
    expect(krea2Records.map((r) => r.name).sort()).toEqual(['Krea 2', 'Krea 2 Turbo']);
  });

  it.each(krea2Records.map((r) => [r.name, r] as const))(
    '%s shows the Krea 2 Community License, in both copies',
    (name, record) => {
      const server = baseModelLicenses[name as BaseModel];
      expect(server, `no licence bound for base model '${name}'`).toBeDefined();
      expect(server!.name).toBe('Krea 2 Community License Agreement');
      expect(server!.url).toBe(PERMALINK);

      const shared = sharedLicenses.find((l) => l.id === record.licenseId);
      const { id: _id, ...sharedFields } = shared!;
      expect(sharedFields).toEqual(server);
    }
  );

  // Commercial use is allowed below a revenue threshold, so it is not non-commercial.
  it('imposes no commercial or mature restriction', () => {
    const server = baseModelLicenses['Krea 2']!;
    expect(server.nonCommercial).toBeUndefined();
    expect(server.disableMature).toBeUndefined();
    expect(server.restrictedNsfwLevels).toBeUndefined();
    expect(server.requiresSameLicense).toBeUndefined();
  });
});
