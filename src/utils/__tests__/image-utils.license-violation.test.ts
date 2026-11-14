import { describe, expect, it } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import type { ImageResourceHelper } from '~/shared/utils/prisma/models';
import { hasImageLicenseViolation } from '~/utils/image-utils';

const resource = (modelVersionBaseModel: string | null) =>
  ({ modelName: 'Model', modelVersionBaseModel } as ImageResourceHelper);

describe('hasImageLicenseViolation', () => {
  it('flags a mature image on a base model that restricts mature images', () => {
    const result = hasImageLicenseViolation({
      nsfwLevel: NsfwLevel.R,
      resourceHelper: [resource('SDXL 1.0'), resource('SD 3.5 Large')],
    });
    expect(result.violation).toBe(true);
    expect(result.restrictedResources?.map((r) => r.baseModel)).toEqual(['SD 3.5 Large']);
  });

  it('does not flag a PG-13 image on the same base model', () => {
    expect(
      hasImageLicenseViolation({
        nsfwLevel: NsfwLevel.PG13,
        resourceHelper: [resource('SD 3.5 Large')],
      }).violation
    ).toBe(false);
  });

  it('does not flag a base model that restricts generation only', () => {
    expect(
      hasImageLicenseViolation({
        nsfwLevel: NsfwLevel.XXX,
        resourceHelper: [resource('Nano Banana'), resource(null)],
      }).violation
    ).toBe(false);
  });
});
