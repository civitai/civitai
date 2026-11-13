import { ModelType } from '~/shared/utils/prisma/enums';

/**
 * Base models whose licensor asks each creator to confirm, at upload, that they had the right to train
 * the model and share it on Civitai. Bump the version whenever the wording changes: the statement is
 * stored verbatim on the version, so a record keeps the text that was actually agreed to.
 */
export const BASE_MODEL_ATTESTATION_VERSION = 1;
export const BASE_MODEL_ATTESTATION_STATEMENT =
  'I confirm I have the right to train this model on its training data and to share it on Civitai.';
export const baseModelAttestationRequiredMessage = (baseModel: string) =>
  `Models built on ${baseModel} need your confirmation that you have the right to train and share them. Edit this version and tick the confirmation to publish.`;
export const BASE_MODEL_ATTESTATION_OWNER_ONLY_MESSAGE =
  "Only the model's owner can confirm they have the right to train and share it.";

export const baseModelsRequiringAttestation: readonly string[] = ['MiniMax H3'];
/** Trained weights only: workflows, wildcards and components carry no training to attest to. */
export const attestationModelTypes: readonly ModelType[] = [
  ModelType.LORA,
  ModelType.LoCon,
  ModelType.DoRA,
  ModelType.Checkpoint,
];

export type BaseModelAttestation = {
  userId: number;
  affirmedAt: string;
  version: number;
  statement: string;
  baseModel: string;
};

export function requiresBaseModelAttestation({
  baseModel,
  modelType,
}: {
  baseModel?: string | null;
  modelType?: ModelType | string | null;
}): boolean {
  if (!baseModel || !modelType) return false;
  return (
    baseModelsRequiringAttestation.includes(baseModel) &&
    (attestationModelTypes as readonly string[]).includes(modelType)
  );
}

export function buildBaseModelAttestation(userId: number, baseModel: string): BaseModelAttestation {
  return {
    userId,
    affirmedAt: new Date().toISOString(),
    version: BASE_MODEL_ATTESTATION_VERSION,
    statement: BASE_MODEL_ATTESTATION_STATEMENT,
    baseModel,
  };
}

/** Every field is validated: a half-formed record must read as absent, so the creator is asked again. */
export function readBaseModelAttestation(meta: unknown): BaseModelAttestation | null {
  const value = (meta as { baseModelAttestation?: unknown } | null)?.baseModelAttestation;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Partial<BaseModelAttestation>;
  const valid =
    typeof record.userId === 'number' &&
    typeof record.version === 'number' &&
    typeof record.statement === 'string' &&
    record.statement.length > 0 &&
    typeof record.baseModel === 'string' &&
    typeof record.affirmedAt === 'string' &&
    !Number.isNaN(Date.parse(record.affirmedAt));
  return valid ? (record as BaseModelAttestation) : null;
}

/**
 * The record must be for the current wording, this base model, and the model's current owner: it is
 * a named person's statement, so it doesn't carry over to a new owner or a different base model.
 */
export function hasBaseModelAttestation(
  meta: unknown,
  { baseModel, ownerId }: { baseModel: string; ownerId: number }
): boolean {
  const record = readBaseModelAttestation(meta);
  return (
    record?.version === BASE_MODEL_ATTESTATION_VERSION &&
    record.baseModel === baseModel &&
    record.userId === ownerId
  );
}
