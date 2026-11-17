import { LOCAL_OVERRIDE_SEGMENT, type FliptVariantDetail } from '@civitai/flipt';
import { ensureFliptInitialized, getFliptVariantDetailSync } from '~/server/flipt/client';
import { buildFliptContext } from '~/server/services/feature-flags.service';
import {
  EXPERIMENT_PIN_SEGMENT_PREFIX,
  experimentKeys,
  experiments,
  isExperimentVariant,
  parseExperimentOverrides,
  type ExperimentAssignment,
  type ExperimentAssignments,
  type ExperimentKey,
} from '~/shared/constants/experiments.constants';
import type { SessionUser } from '~/types/session';

const warnedInvalid = new Set<string>();

export function resolveExperimentAssignment(
  key: ExperimentKey,
  detail: FliptVariantDetail | null
): ExperimentAssignment {
  const { defaultVariant, fliptKey } = experiments[key];
  if (!detail) return { variant: defaultVariant, assignment: 'unavailable' };
  if (!detail.match) return { variant: defaultVariant, assignment: 'off' };
  if (!isExperimentVariant(key, detail.variantKey)) {
    if (!warnedInvalid.has(fliptKey)) {
      warnedInvalid.add(fliptKey);
      console.warn(`[experiments] ${fliptKey} returned unknown variant "${detail.variantKey}"`);
    }
    return { variant: defaultVariant, assignment: 'invalid' };
  }
  if (detail.segmentKeys.includes(LOCAL_OVERRIDE_SEGMENT)) {
    return { variant: detail.variantKey, assignment: 'override' };
  }
  if (detail.segmentKeys.some((s) => s.startsWith(EXPERIMENT_PIN_SEGMENT_PREFIX))) {
    return { variant: detail.variantKey, assignment: 'pinned' };
  }
  return { variant: detail.variantKey, assignment: 'rule' };
}

export async function getExperimentAssignments({
  user,
  overrideCookie,
}: {
  user: SessionUser;
  overrideCookie?: string;
}): Promise<ExperimentAssignments> {
  await ensureFliptInitialized();
  // Both: bucketing hashes the entity id, while every pin and tester segment matches context.
  const entityId = String(user.id);
  const context = buildFliptContext(user);
  const overrides = user.isModerator ? parseExperimentOverrides(overrideCookie) : {};

  const out = {} as ExperimentAssignments;
  for (const key of experimentKeys) {
    const override = overrides[key];
    out[key] = override
      ? { variant: override, assignment: 'override' }
      : resolveExperimentAssignment(
          key,
          getFliptVariantDetailSync(experiments[key].fliptKey, entityId, context)
        );
  }
  return out;
}
