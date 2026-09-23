import { describe, expect, it } from 'vitest';
import { ModelUsageControl } from '~/shared/utils/prisma/enums';
import {
  decideModelVersionSubmit,
  type ModelVersionSubmitContext,
  type ModelVersionSubmitData,
} from '~/components/Resource/Forms/model-version-submit';

/**
 * Golden fixtures over the pure submit decision — the oracle the form-graph
 * port of ModelVersionUpsertForm will be differentially tested against. These
 * pin CURRENT behavior (money-path transforms included), captured 2026-09-08
 * from the extracted handler; they are parity pins, not endorsements.
 */

const baseData = (): ModelVersionSubmitData => ({
  id: 10,
  name: 'v1.0',
  modelId: 5,
  baseModel: 'SDXL 1.0',
  usageControl: ModelUsageControl.Download,
  trainedWords: ['cat'],
  skipTrainedWords: false,
  epochs: undefined,
  steps: undefined,
  clipSkip: 2,
  licensingFee: 0,
  monetization: null,
  baseModelType: null,
  paidAccessConfig: null,
  rightsAffirmed: false,
  recommendedResources: [],
  requireAuth: true,
  useMonetization: false,
});

const baseCtx = (): ModelVersionSubmitContext => ({
  modelId: 5,
  modelNsfw: false,
  gateSuppressed: false,
  monetizationBlocked: false,
  showClipSkip: true,
  genMode: 'bundled',
  requiresRightsAffirmation: false,
  isDirty: true,
  versionId: 10,
  storedPaidAccessConfig: null,
  templateId: undefined,
  bountyId: undefined,
});

const timedGate = (over: Record<string, unknown> = {}) => ({
  permanent: false,
  timeframe: 3,
  accessPrice: 5000,
  generationPrice: undefined,
  freeGeneration: false,
  acceptsBlueBuzz: false,
  freePreviewGenerations: 10,
  donationGoalEnabled: false,
  donationGoal: undefined,
  ...over,
});

const decide = (
  data: Partial<ModelVersionSubmitData> = {},
  ctx: Partial<ModelVersionSubmitContext> = {}
) => decideModelVersionSubmit({ ...baseData(), ...data }, { ...baseCtx(), ...ctx });

const submitOf = (d: ReturnType<typeof decide>) => {
  if (d.kind !== 'submit') throw new Error(`expected submit, got ${d.kind}`);
  return d;
};

describe('decideModelVersionSubmit: payload shape', () => {
  it('minimal no-charge submit (full payload pin)', () => {
    expect(decide()).toEqual({
      kind: 'submit',
      submittedFee: 0,
      submittedGate: null,
      gatedConfig: null,
      payload: {
        id: 10,
        name: 'v1.0',
        modelId: 5,
        baseModel: 'SDXL 1.0',
        usageControl: 'Download',
        trainedWords: ['cat'],
        skipTrainedWords: false,
        epochs: null,
        steps: null,
        clipSkip: 2,
        licensingFee: 0,
        monetization: null,
        baseModelType: null,
        paidAccessConfig: null,
        rightsAffirmed: false,
        requireAuth: true,
        useMonetization: false,
        paidAccess: null,
        donationGoal: null,
        recommendedResources: [],
        templateId: undefined,
        bountyId: undefined,
      },
    });
  });

  it('skipTrainedWords sends an empty word list', () => {
    const d = submitOf(decide({ skipTrainedWords: true }));
    expect(d.payload.trainedWords).toEqual([]);
    expect(d.payload.skipTrainedWords).toBe(true);
  });

  it('a hidden clip skip is nulled, not persisted stale', () => {
    const d = submitOf(decide({}, { showClipSkip: false }));
    expect(d.payload.clipSkip).toBeNull();
  });

  it('recommendedResources rename: {id, strength} -> {resourceId, settings.strength}', () => {
    const d = submitOf(
      decide({
        recommendedResources: [
          { id: 111, strength: 0.8, model: { id: 1 } },
          { id: 222, strength: null, model: { id: 2 } },
        ],
      })
    );
    expect(d.payload.recommendedResources).toEqual([
      { resourceId: 111, settings: { strength: 0.8 } },
      { resourceId: 222, settings: { strength: null } },
    ]);
  });
});

describe('decideModelVersionSubmit: paid access gate', () => {
  it('timed gate with a separate generation price (full payload pin)', () => {
    const d = submitOf(
      decide({ paidAccessConfig: timedGate({ generationPrice: 500 }) }, { genMode: 'separate' })
    );
    expect(d.submittedGate).toEqual({
      permanent: false,
      timeframeDays: 3,
      terms: { download: { price: 5000 }, generation: { price: 500, trialLimit: 10 } },
    });
    expect(d.payload.paidAccess).toEqual(d.submittedGate);
    expect(d.payload.donationGoal).toBeNull();
  });

  it('bundled: no generation tier price, trial limit rides on the grant', () => {
    const d = submitOf(decide({ paidAccessConfig: timedGate() }));
    expect(d.submittedGate).toEqual({
      permanent: false,
      timeframeDays: 3,
      terms: { download: { price: 5000 }, generation: { trialLimit: 10 } },
    });
  });

  it('free generation grant', () => {
    const d = submitOf(
      decide({ paidAccessConfig: timedGate({ freeGeneration: true }) }, { genMode: 'free' })
    );
    expect(d.submittedGate).toEqual({
      permanent: false,
      timeframeDays: 3,
      terms: { download: { price: 5000 }, generation: { free: true } },
    });
  });

  it('generation-only usage control prices the generation tier, no download tier', () => {
    const d = submitOf(
      decide({ usageControl: ModelUsageControl.Generation, paidAccessConfig: timedGate() })
    );
    expect(d.submittedGate).toEqual({
      permanent: false,
      timeframeDays: 3,
      terms: { generation: { price: 5000, trialLimit: 10 } },
    });
  });

  it('a non-gateable usage control drops the gate entirely', () => {
    const d = submitOf(
      decide({
        usageControl: ModelUsageControl.InternalGeneration,
        paidAccessConfig: timedGate(),
      })
    );
    expect(d.submittedGate).toBeNull();
    expect(d.payload.paidAccess).toBeNull();
  });

  it('an UNDEFINED usage control still allows the gate (current behavior, pinned)', () => {
    const d = submitOf(decide({ usageControl: undefined, paidAccessConfig: timedGate() }));
    expect(d.submittedGate).not.toBeNull();
  });

  it('gate suppression drops the gate but keeps the fee; the raw config still rides in the payload', () => {
    const d = submitOf(
      decide({ paidAccessConfig: timedGate(), licensingFee: 100 }, { gateSuppressed: true })
    );
    expect(d.submittedGate).toBeNull();
    expect(d.payload.paidAccess).toBeNull();
    expect(d.submittedFee).toBe(100);
    expect(d.payload.licensingFee).toBe(100);
    // shouldUnregister:false survival — stripped by the server's input schema, not here
    expect(d.payload.paidAccessConfig).toEqual(timedGate());
  });

  it('monetizationBlocked zeroes the fee and nulls legacy monetization (full pin)', () => {
    const d = submitOf(
      decide(
        { licensingFee: 100, monetization: { type: 'legacy' } },
        { gateSuppressed: true, monetizationBlocked: true }
      )
    );
    expect(d.submittedFee).toBe(0);
    expect(d.payload.licensingFee).toBe(0);
    expect(d.payload.monetization).toBeNull();
  });
});

describe('decideModelVersionSubmit: donation goal', () => {
  it('rides only on a timed gate', () => {
    const d = submitOf(
      decide({
        paidAccessConfig: timedGate({ donationGoalEnabled: true, donationGoal: 60000 }),
      })
    );
    expect(d.payload.donationGoal).toEqual({ amount: 60000 });
  });

  it('a permanent gate never sends a goal, even when enabled', () => {
    const d = submitOf(
      decide({
        paidAccessConfig: timedGate({
          permanent: true,
          donationGoalEnabled: true,
          donationGoal: 60000,
        }),
      })
    );
    expect(d.submittedGate).toEqual({
      permanent: true,
      terms: { download: { price: 5000 }, generation: { trialLimit: 10 } },
    });
    expect(d.payload.donationGoal).toBeNull();
  });
});

describe('decideModelVersionSubmit: refusals and skip', () => {
  it('refuses an NSFW model on a license-restricted base model', () => {
    const d = decide({ baseModel: 'SD 3' }, { modelNsfw: true });
    expect(d).toMatchObject({
      kind: 'refuse',
      code: 'nsfw_restricted_base_model',
      title: 'Base Model License Restriction',
    });
  });

  it('refuses a separate generation mode with no generation price', () => {
    expect(decide({ paidAccessConfig: timedGate() }, { genMode: 'separate' })).toEqual({
      kind: 'refuse',
      code: 'generation_price_missing',
      title: 'Generation price required',
      message: 'Enter a generation-only price, or choose "Same as the access price"',
      field: 'paidAccessConfig.generationPrice',
    });
  });

  it('refuses an unaffirmed charge when affirmation is required', () => {
    expect(decide({ paidAccessConfig: timedGate() }, { requiresRightsAffirmation: true })).toEqual({
      kind: 'refuse',
      code: 'rights_affirmation_required',
      title: 'Confirmation required',
      message: 'You must confirm you hold the rights to monetize this model',
      field: 'rightsAffirmed',
    });
  });

  it('skips a clean save of an existing version', () => {
    expect(decide({}, { isDirty: false })).toEqual({ kind: 'skip' });
  });

  it('a template forces the submit even when clean', () => {
    const d = submitOf(decide({}, { isDirty: false, templateId: 77 }));
    expect(d.payload.templateId).toBe(77);
  });

  it('a paid-access change forces the submit even when RHF says clean', () => {
    const config = timedGate();
    const d = decide(
      { paidAccessConfig: config },
      { isDirty: false, storedPaidAccessConfig: null }
    );
    expect(d.kind).toBe('submit');
    expect(
      decide({ paidAccessConfig: config }, { isDirty: false, storedPaidAccessConfig: config })
    ).toEqual({ kind: 'skip' });
  });
});
