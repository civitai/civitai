import { describe, expect, it, vi } from 'vitest';
import { CommercialUse } from '~/shared/utils/prisma/enums';

/**
 * The licence's commercial restrictions are emitted by ABSENCE: a clause appears for every
 * CommercialUse value the creator did NOT grant. So a permission with no clause silently
 * imposes no restriction, and asserting the clause map has a key proves nothing about the
 * document a buyer reads. These assert on the returned document.
 *
 * The carve-out sentence in "Sale of the Model" is what makes the split real. Attachment B's
 * preamble says every restriction on the Model reaches Merges too, so without it a creator who
 * forbids selling the model but allows selling merges gets a green tick on the site and a
 * licence that still forbids it. Delete that sentence and `withholds Sell, grants SellMerge`
 * must fail — if you are removing it, that is the case telling you why it is there.
 */

// model-version.service reaches the orchestrator through training.service, which throws on a
// missing token at import. Nothing on this path calls it.
vi.mock('~/server/services/training.service', () => ({}));

const { addAdditionalLicensePermissions } = await import('~/server/services/model-version.service');

const MODEL_CLAUSE = 'Sale of the Model:';
const MERGE_CLAUSE = 'Sale of Merges:';
const CARVE_OUT = '“the Model” does not include a Merge';

const buildLicense = (allowCommercialUse: CommercialUse[]) =>
  addAdditionalLicensePermissions('', {
    modelId: 1,
    modelName: 'Test Model',
    versionId: 2,
    username: 'tester',
    allowNoCredit: true,
    allowDerivatives: true,
    allowDifferentLicense: false,
    allowCommercialUse,
  });

const OTHERS = [CommercialUse.Image, CommercialUse.RentCivit, CommercialUse.Rent];

describe('sell / sell-merge split in the generated licence', () => {
  it('grants both: neither restriction appears', () => {
    const license = buildLicense([...OTHERS, CommercialUse.Sell, CommercialUse.SellMerge]);

    expect(license).not.toContain(MODEL_CLAUSE);
    expect(license).not.toContain(MERGE_CLAUSE);
  });

  it('grants Sell, withholds SellMerge: only the merge restriction appears', () => {
    const license = buildLicense([...OTHERS, CommercialUse.Sell]);

    expect(license).toContain(MERGE_CLAUSE);
    expect(license).not.toContain(MODEL_CLAUSE);
  });

  it('withholds Sell, grants SellMerge: the model restriction appears AND excludes merges', () => {
    const license = buildLicense([...OTHERS, CommercialUse.SellMerge]);

    expect(license).toContain(MODEL_CLAUSE);
    expect(license).toContain(CARVE_OUT);
    expect(license).not.toContain(MERGE_CLAUSE);
  });

  it('withholds both: both restrictions appear', () => {
    const license = buildLicense(OTHERS);

    expect(license).toContain(MODEL_CLAUSE);
    expect(license).toContain(MERGE_CLAUSE);
  });
});
