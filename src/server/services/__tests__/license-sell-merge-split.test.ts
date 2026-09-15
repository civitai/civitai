import { describe, expect, it, vi } from 'vitest';
import { CommercialUse } from '~/shared/utils/prisma/enums';

/**
 * The licence's commercial restrictions are emitted by ABSENCE: a clause appears for every
 * CommercialUse value the creator did NOT grant. So a permission with no clause silently
 * imposes no restriction, and asserting the clause map has a key proves nothing about the
 * document a buyer reads. These assert on the returned document.
 *
 * The disapplying sentence in "Sale of the Model" is what makes the split real. Attachment B's
 * preamble extends every restriction to "the Model and Derivatives of the Model" and defines
 * Derivatives to include Merges — TWO arms. So the sentence has to disapply the Permission, not
 * narrow what "the Model" means: narrowing the noun leaves the Derivatives arm still catching
 * merges, and the creator gets a green tick over a licence that forbids the thing. Delete or
 * reword that sentence and `withholds Sell, grants SellMerge` must fail — if you are removing it
 * as redundant next to a clause already headed "Sale of the Model", that is the case telling you
 * why it is not.
 *
 * It is asserted INSIDE the Sale of the Model clause rather than anywhere in the document,
 * because moving it into the preamble would disapply it from every other clause and a
 * document-wide `toContain` would stay green through that.
 */

// model-version.service reaches the orchestrator through training.service, which throws on a
// missing token at import. Nothing on this path calls it.
vi.mock('~/server/services/training.service', () => ({}));

const { addAdditionalLicensePermissions } = await import('~/server/services/model-version.service');

const MODEL_CLAUSE = 'Sale of the Model:';
const MERGE_CLAUSE = 'Sale of Merges:';
const DISAPPLIES_TO_MERGES = 'This restriction does not apply to a Merge.';

/** The Sale of the Model clause body alone, so an assertion cannot be satisfied from elsewhere. */
const saleOfModelClause = (license: string) => {
  const start = license.indexOf(MODEL_CLAUSE);
  if (start === -1) return '';
  const end = license.indexOf('</b>', start);
  return license.slice(start, end === -1 ? undefined : end);
};

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
    expect(saleOfModelClause(license)).toContain(DISAPPLIES_TO_MERGES);
    expect(license).not.toContain(MERGE_CLAUSE);
  });

  /**
   * The carve-out in Sale of the Model only works because the preamble expands a restriction
   * to Derivatives ONLY where the restriction references the Model, and yields where it states
   * its own scope. Restore the old flat sentence -- "The below restrictions apply to the Model
   * and Derivatives of the Model, even though only the Model is referenced" -- and the carve-out
   * stops working: a Merge is a Derivative, so the restriction reaches it again and the creator
   * gets a green tick over a licence that forbids the sale. The clause cannot defend itself here;
   * this is the assertion that does.
   */
  it('the preamble expands a restriction conditionally, and yields to a stated scope', () => {
    const license = buildLicense(OTHERS);

    expect(license).toContain('A restriction below that references the Model applies to');
    expect(license).toContain('except to the extent that restriction expressly states otherwise');
    expect(license).not.toContain('even though only the Model is referenced');
  });

  it('withholds both: both restrictions appear', () => {
    const license = buildLicense(OTHERS);

    expect(license).toContain(MODEL_CLAUSE);
    expect(license).toContain(MERGE_CLAUSE);
    expect(saleOfModelClause(license)).toContain(DISAPPLIES_TO_MERGES);
  });
});
