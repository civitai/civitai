import { TRPCError } from '@trpc/server';
import {
  GENERATION_LICENSE_NOT_ACCEPTED,
  GENERATION_LICENSE_TERMS,
  getGenerationLicenseTerms,
  getTrainingLicenseTerms,
  hasAcceptedGenerationLicense,
  type GenerationLicenseTerms,
} from '~/shared/constants/generation-license.constants';

/** Records the user's acceptance of the licence an ecosystem requires, at the server's time. */
export async function acceptGenerationLicense({
  userId,
  ecosystem,
}: {
  userId: number;
  ecosystem: string;
}) {
  const terms = getGenerationLicenseTerms(ecosystem);
  if (!terms)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'This model has no licence to accept.' });

  // Loaded on call: a static import puts user.service in the orchestrator's module graph, and the
  // cycle that makes leaves a test's mock of user.service unapplied in its other importers.
  const { patchUserSettings } = await import('~/server/services/user.service');
  await patchUserSettings(userId, {
    mergeInto: {
      generationLicenseAcceptances: {
        [terms.key]: { version: terms.version, acceptedAt: new Date().toISOString() },
      },
    },
    location: 'generation-license.service:acceptGenerationLicense',
  });
  return { key: terms.key, version: terms.version };
}

/**
 * Refuses a generation on an ecosystem whose licence the user has not accepted. Called on every
 * submit path, not on whatIf: pricing a request binds no one to anything.
 */
export async function assertGenerationLicenseAccepted({
  ecosystem,
  userId,
}: {
  ecosystem: string | undefined;
  userId: number | undefined;
}) {
  const terms = getGenerationLicenseTerms(ecosystem);
  if (!terms || (await hasAccepted(terms, userId))) return;
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: `Accept the ${terms.title} in the Civitai generator before generating with this model.`,
    cause: GENERATION_LICENSE_NOT_ACCEPTED,
  });
}

/** Refuses a training run on an AI Toolkit ecosystem whose licence the user has not accepted. */
export async function assertTrainingLicenseAccepted({
  ecosystem,
  userId,
}: {
  ecosystem: string | undefined;
  userId: number | undefined;
}) {
  const terms = getTrainingLicenseTerms(ecosystem);
  if (!terms || (await hasAccepted(terms, userId))) return;
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: `Accept the ${terms.title} before training with this model.`,
    cause: GENERATION_LICENSE_NOT_ACCEPTED,
  });
}

/** The AI Toolkit training ecosystems whose licence the user has yet to accept. */
export async function pendingTrainingLicenseEcosystems(userId: number): Promise<string[]> {
  const settings = await loadSettings(userId);
  return GENERATION_LICENSE_TERMS.filter(
    (terms) => !hasAcceptedGenerationLicense(settings?.generationLicenseAcceptances, terms)
  ).flatMap((terms) => terms.trainingEcosystems);
}

async function loadSettings(userId: number | undefined) {
  if (!userId) return undefined;
  const { getUserSettings } = await import('~/server/services/user.service');
  return getUserSettings(userId);
}

async function hasAccepted(terms: GenerationLicenseTerms, userId: number | undefined) {
  const settings = await loadSettings(userId);
  return hasAcceptedGenerationLicense(settings?.generationLicenseAcceptances, terms);
}
