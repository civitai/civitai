import { describe, expect, it } from 'vitest';
import { baseModelRecords, licenseById } from '@civitai/shared/basemodel.constants';
import { baseModelLicenses } from '~/server/common/constants';
import type { BaseModel } from '@civitai/shared/basemodel.constants';

// Catch-alls with no single licence of their own.
const UNLICENSED = ['ODOR', 'Other', 'Upscaler'];

const licensed = baseModelRecords.filter((r) => !UNLICENSED.includes(r.name));

describe('base model licences', () => {
  it('leaves only the catch-alls without a licence', () => {
    expect(
      baseModelRecords
        .filter((r) => !r.licenseId)
        .map((r) => r.name)
        .sort()
    ).toEqual([...UNLICENSED].sort());
  });

  // The version page and enforcement read the app's copy; creator-studio's licensing fee
  // and the generator footer read the shared one. Any field that differs shows one thing
  // and enforces another.
  it.each(licensed.map((r) => [r.name, r] as const))(
    '%s says the same thing in both copies',
    (name, record) => {
      const shared = licenseById.get(record.licenseId!);
      const app = baseModelLicenses[name as BaseModel];
      expect(shared, `no shared licence ${record.licenseId}`).toBeDefined();
      expect(app, `no app licence for '${name}'`).toBeDefined();

      const { id: _id, ...sharedFields } = shared!;
      expect(app).toEqual(sharedFields);
    }
  );
});
