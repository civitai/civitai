import {
  BASE_MODEL_ATTESTATION_OWNER_ONLY_MESSAGE,
  baseModelAttestationRequiredMessage,
  baseModelsRequiringAttestation,
  buildBaseModelAttestation,
  hasBaseModelAttestation,
  requiresBaseModelAttestation,
  type BaseModelAttestation,
} from '~/shared/constants/base-model-attestation.constants';
import { ModelStatus, type ModelType } from '~/shared/utils/prisma/enums';
import { throwBadRequestError } from '~/server/utils/errorHandling';

type PublishingVersion = {
  baseModel: string;
  publishedAt: Date | null;
  meta: unknown;
  model: { type: ModelType | string; userId: number };
};

/**
 * Refuses to make a version public without its owner's attestation. A version that has already been
 * public is grandfathered, except where `grandfatherPublished` is off: a private model's versions carry
 * a publishedAt from their private publish, so going public is their first share.
 */
export function assertBaseModelAttestations({
  versions,
  grandfatherPublished = true,
}: {
  versions: PublishingVersion[];
  grandfatherPublished?: boolean;
}) {
  const now = Date.now();
  for (const { baseModel, publishedAt, meta, model } of versions) {
    if (!baseModelsRequiringAttestation.includes(baseModel)) continue;
    if (!requiresBaseModelAttestation({ baseModel, modelType: model.type })) continue;
    if (grandfatherPublished && publishedAt && publishedAt.getTime() <= now) continue;
    if (hasBaseModelAttestation(meta, { baseModel, ownerId: model.userId })) continue;
    throw throwBadRequestError(baseModelAttestationRequiredMessage(baseModel));
  }
}

/**
 * Refuses an edit that brings an already-public version into scope (a base model or model type
 * change) without an attestation. Otherwise publishing out of scope and then switching would walk
 * around the publish gate, which grandfathers anything already public.
 */
export function assertNoUnattestedScopeEntry({
  before,
  after,
  ownerId,
}: {
  before?: { baseModel: string; modelType: ModelType | string; publishedAt: Date | null };
  after: { baseModel: string; modelType: ModelType | string; status?: ModelStatus; meta: unknown };
  ownerId: number;
}) {
  if (!requiresBaseModelAttestation(after)) return;
  if (before && requiresBaseModelAttestation(before)) return;
  const isOrWasPublic =
    before?.publishedAt != null ||
    after.status === ModelStatus.Published ||
    after.status === ModelStatus.Scheduled;
  if (!isOrWasPublic) return;
  if (hasBaseModelAttestation(after.meta, { baseModel: after.baseModel, ownerId })) return;
  throw throwBadRequestError(baseModelAttestationRequiredMessage(after.baseModel));
}

/**
 * The attestation to record for a version save, if any. Only the owner can give it: a moderator
 * saving someone else's version isn't the person the statement is about.
 */
export function resolveBaseModelAttestation({
  actorId,
  ownerId,
  attested,
  baseModel,
  modelType,
  existingMeta,
}: {
  actorId: number;
  ownerId: number;
  attested?: boolean;
  baseModel: string;
  modelType: ModelType | string;
  existingMeta?: unknown;
}): BaseModelAttestation | undefined {
  if (!attested || !requiresBaseModelAttestation({ baseModel, modelType })) return undefined;
  if (hasBaseModelAttestation(existingMeta, { baseModel, ownerId })) return undefined;
  if (actorId !== ownerId) throw throwBadRequestError(BASE_MODEL_ATTESTATION_OWNER_ONLY_MESSAGE);
  return buildBaseModelAttestation(ownerId, baseModel);
}
