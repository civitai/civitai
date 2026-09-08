import { isEqual } from 'lodash-es';
import {
  DEFAULT_GENERATION_TRIAL_LIMIT,
  acceptsBlueBuzz,
  buildModelVersionTerms,
  separateGenerationPriceMissing,
  type ModelVersionTerms,
} from '@civitai/buzz';
import { EARLY_ACCESS_CONFIG, nsfwRestrictedBaseModels } from '~/server/common/constants';
import type { ModelVersionPaidAccessInputSchema } from '~/server/schema/model-version.schema';
import type { BaseModel } from '~/shared/constants/basemodel.constants';
import { ModelUsageControl } from '~/shared/utils/prisma/enums';
import type { FormPaidAccessConfig } from '~/components/Resource/Forms/model-version-monetization-defaults';

/**
 * The pure half of ModelVersionUpsertForm's submit: every refusal, the
 * dirty-check skip, and the payload construction, with no store/React/tRPC in
 * reach. Extracted so the form-graph port can be differentially tested against
 * it — the golden fixtures in __tests__/model-version-submit.test.ts pin the
 * CURRENT behavior, money-path transforms included.
 */

// Wrap the terms in the permanent/timed gate shape (or null for an off/invalid gate).
function toGate(
  config: FormPaidAccessConfig,
  terms: ModelVersionTerms
): ModelVersionPaidAccessInputSchema | null {
  if (config.permanent) return { permanent: true, terms };
  const timeframeDays = config.timeframe ?? 0;
  if (timeframeDays <= 0) return null;
  return { permanent: false, timeframeDays, terms };
}

export function toPaidAccessInput(
  config: FormPaidAccessConfig | null | undefined,
  usageControl: ModelUsageControl | undefined
): ModelVersionPaidAccessInputSchema | null {
  if (!config || config.accessPrice == null) return null;
  // Only downloadable or on-site-generation versions can be gated; other usage controls (internal /
  // external API) can't set paid access at all.
  if (
    usageControl &&
    usageControl !== ModelUsageControl.Download &&
    usageControl !== ModelUsageControl.Generation
  )
    return null;
  const terms = buildModelVersionTerms({
    accessPrice: config.accessPrice,
    generationPrice: config.generationPrice,
    freePreviewGenerations: config.freePreviewGenerations,
    genOnly: usageControl === ModelUsageControl.Generation,
    freeGeneration: config.freeGeneration,
    acceptsBlueBuzz: config.acceptsBlueBuzz,
  });
  return toGate(config, terms);
}

export type GenerationMode = 'bundled' | 'separate' | 'free';
export const generationModeOf = (config: FormPaidAccessConfig | null | undefined): GenerationMode =>
  config?.freeGeneration ? 'free' : config?.generationPrice != null ? 'separate' : 'bundled';

export function toDonationGoalInput(config: FormPaidAccessConfig | null | undefined) {
  // A donation goal only makes sense for a timed gate (it ends the window early); permanent never ends.
  if (config?.permanent || !config?.donationGoalEnabled || !config.donationGoal) return null;
  return { amount: config.donationGoal };
}

export function toFormPaidAccessConfig(
  paidAccess: { timeframeDays: number | null; terms: ModelVersionTerms } | null | undefined,
  donationGoal: { goalAmount: number } | null | undefined
): FormPaidAccessConfig | null {
  if (!paidAccess) return null;
  const terms = paidAccess.terms ?? {};
  const paidGen = terms.generation && !('free' in terms.generation) ? terms.generation : undefined;
  return {
    // No timeframeDays on the row => a permanent (never-expiring) gate.
    permanent: paidAccess.timeframeDays == null,
    timeframe: paidAccess.timeframeDays ?? EARLY_ACCESS_CONFIG.timeframeValues[0],
    // "Price for access" is the download price when downloadable; for a gen-only version (no download
    // tier) it's the generation price. The separate generation-only tier only exists with a download bundle.
    accessPrice: terms.download?.price ?? paidGen?.price,
    generationPrice: terms.download ? paidGen?.price : undefined,
    freeGeneration: !!terms.generation && `free` in terms.generation,
    acceptsBlueBuzz: acceptsBlueBuzz(terms),
    freePreviewGenerations: paidGen?.trialLimit ?? DEFAULT_GENERATION_TRIAL_LIMIT,
    donationGoalEnabled: !!donationGoal,
    donationGoal: donationGoal?.goalAmount,
  };
}

/** The fields the decision reads; the rest of the form data rides through into the payload. */
export type ModelVersionSubmitData = {
  baseModel?: string;
  baseModelType?: string | null;
  usageControl?: ModelUsageControl;
  paidAccessConfig?: FormPaidAccessConfig | null;
  rightsAffirmed?: boolean;
  skipTrainedWords?: boolean;
  trainedWords?: string[];
  clipSkip?: number | null;
  epochs?: number | null;
  steps?: number | null;
  licensingFee?: number | null;
  monetization?: unknown;
  recommendedResources?:
    | ({ id: number; strength?: number | null } & Record<string, unknown>)[]
    | null;
} & Record<string, unknown>;

export type ModelVersionSubmitContext = {
  modelId: number | undefined;
  modelNsfw: boolean;
  /** private || poi || non-commercial base model — the gate is dropped at submit. */
  gateSuppressed: boolean;
  /** poi || non-commercial — fee zeroed and legacy monetization nulled. */
  monetizationBlocked: boolean;
  showClipSkip: boolean;
  genMode: GenerationMode;
  requiresRightsAffirmation: boolean;
  isDirty: boolean;
  versionId: number | undefined;
  /** `toFormPaidAccessConfig(version.paidAccess, version.donationGoal)` — the dirty-check baseline. */
  storedPaidAccessConfig: FormPaidAccessConfig | null;
  templateId: number | undefined;
  bountyId: number | undefined;
};

export type ModelVersionSubmitDecision =
  | {
      kind: 'refuse';
      code:
        | 'nsfw_restricted_base_model'
        | 'generation_price_missing'
        | 'rights_affirmation_required';
      title: string;
      message: string;
      field?: 'paidAccessConfig.generationPrice' | 'rightsAffirmed';
    }
  | { kind: 'skip' }
  | {
      kind: 'submit';
      payload: Record<string, unknown>;
      submittedFee: number;
      submittedGate: ModelVersionPaidAccessInputSchema | null;
      gatedConfig: FormPaidAccessConfig | null | undefined;
    };

export function decideModelVersionSubmit(
  { recommendedResources: rawRecommendedResources, ...data }: ModelVersionSubmitData,
  ctx: ModelVersionSubmitContext
): ModelVersionSubmitDecision {
  if (
    ctx.modelNsfw &&
    data.baseModel &&
    nsfwRestrictedBaseModels.includes(data.baseModel as BaseModel)
  ) {
    return {
      kind: 'refuse',
      code: 'nsfw_restricted_base_model',
      title: 'Base Model License Restriction',
      message: `NSFW models cannot use base models with license restrictions. The base model "${
        data.baseModel
      }" is restricted for NSFW content. Restricted base models: ${nsfwRestrictedBaseModels.join(
        ', '
      )}`,
    };
  }

  const gatedConfig = ctx.gateSuppressed ? null : data.paidAccessConfig;
  // Keyed to the gate the submit actually sends, not to the config: a usage control that can't be gated
  // leaves the pricing controls unmounted with their values intact, and refusing over a price nobody can
  // see (for a gate that would be dropped anyway) is a save the creator has no way to unblock.
  const submittedGate = toPaidAccessInput(gatedConfig, data.usageControl);

  // A generation grant with no price of its own is charged at the DOWNLOAD price (see `generationPrice`),
  // so an empty box under "a cheaper generation-only price" bills the full access price while the screen
  // says cheaper. Nothing downstream can tell that apart from a deliberate "same as access price", so the
  // refusal has to happen here, where the creator's choice still exists.
  if (
    ctx.genMode === 'separate' &&
    submittedGate &&
    data.usageControl !== ModelUsageControl.Generation &&
    separateGenerationPriceMissing(data.paidAccessConfig?.generationPrice)
  ) {
    return {
      kind: 'refuse',
      code: 'generation_price_missing',
      title: 'Generation price required',
      message: 'Enter a generation-only price, or choose "Same as the access price"',
      field: 'paidAccessConfig.generationPrice',
    };
  }

  if (ctx.requiresRightsAffirmation && !data.rightsAffirmed) {
    return {
      kind: 'refuse',
      code: 'rights_affirmation_required',
      title: 'Confirmation required',
      message: 'You must confirm you hold the rights to monetize this model',
      field: 'rightsAffirmed',
    };
  }

  const shouldSubmit =
    ctx.isDirty ||
    !ctx.versionId ||
    !!ctx.templateId ||
    !!ctx.bountyId ||
    !isEqual(data.paidAccessConfig, ctx.storedPaidAccessConfig);
  if (!shouldSubmit) return { kind: 'skip' };

  const submittedFee = ctx.monetizationBlocked ? 0 : data.licensingFee ?? 0;
  const recommendedResources =
    rawRecommendedResources?.map(({ id, strength }) => ({
      resourceId: id,
      settings: { strength },
    })) ?? [];

  return {
    kind: 'submit',
    submittedFee,
    submittedGate,
    gatedConfig,
    payload: {
      ...data,
      // Don't persist a stale clip skip for base models that don't use it.
      clipSkip: ctx.showClipSkip ? data.clipSkip ?? null : null,
      epochs: data.epochs ?? null,
      steps: data.steps ?? null,
      modelId: ctx.modelId ?? -1,
      // A POI model earns nothing: the fee editor is unmounted for one, so its stored value would
      // otherwise ride along untouched behind a section that shows no controls at all.
      licensingFee: submittedFee,
      paidAccess: submittedGate,
      // Keyed to the gate that is actually sent: a goal ends a timed window early, so writing one for a
      // version whose gate was just rejected leaves a goal against nothing to end.
      donationGoal: submittedGate ? toDonationGoalInput(gatedConfig) : null,
      trainedWords: data.skipTrainedWords ? [] : data.trainedWords,
      baseModelType: data.baseModelType,
      monetization: ctx.monetizationBlocked ? null : data.monetization,
      recommendedResources,
      templateId: ctx.templateId,
      bountyId: ctx.bountyId,
    },
  };
}
