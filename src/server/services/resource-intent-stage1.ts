import {
  RESOURCE_INTENT_CRITERIA_VERSION,
  RESOURCE_INTENT_QUESTIONS,
  RESOURCE_INTENT_SPEC_HASH,
  resourceIntentAnswerSchema,
  ROLE_MODEL_TYPES,
  type ResourceIntentAnswer,
  type ResourceIntentCriteria,
} from '~/server/schema/resource-intent.schema';
import type { JevAnswer } from '~/server/services/ai/jev';

/**
 * Stage 1 of the resource-intent primitive, as pure functions: the request, the answer
 * parse and the criteria compile. `getResourceIntent` (resource-intent.service.ts) runs
 * stage 1 through these, and so does the M3 study (`scripts/eval-resource-intent-goldset.ts`)
 * — one copy, not two.
 *
 * 🔴 KEEP THIS MODULE LIGHT: it imports the schema and a jev TYPE, nothing else. It is
 * split out of the service because importing the service from a standalone `tsx` script
 * pulls the service's whole graph (redis, clickhouse, generation.service) and hits a
 * circular import that crashes on load (`user.service.ts` reading `modelMetrics` off an
 * undefined module). Vitest's module loader does not reproduce the crash, which is why the
 * study has a smoke test that spawns the script under tsx.
 */

/** Stage 1's Jev request, exactly as the endpoint sends it. */
export function buildResourceIntentStage1Request(prompt: string, baseModel: string | null) {
  return {
    state: { prompt, ...(baseModel ? { baseModel } : {}) },
    questions: RESOURCE_INTENT_QUESTIONS.map((question) => ({ ...question })),
  };
}

/**
 * Stage 1's answers → the typed intent. Returns `null` when an answer is missing or
 * of the wrong kind for its question (the endpoint degrades that as
 * `jev_stage1_shape`), and THROWS when the answers are well-formed but no longer
 * match the current question spec (option sets, score range) — so a desync between
 * the Jev client and the spec degrades instead of shipping.
 */
export function parseResourceIntentStage1Answers(
  answers: readonly JevAnswer[]
): ResourceIntentAnswer | null {
  const answersById = new Map(answers.map((answer) => [answer.id, answer]));
  const needsResource = answersById.get('needsResource');
  const role = answersById.get('role');
  const styleFamily = answersById.get('styleFamily');
  const contentType = answersById.get('contentType');
  const specificity = answersById.get('specificity');
  const injectionPresent = answersById.get('injectionPresent');
  if (
    needsResource?.type !== 'noul' ||
    role?.type !== 'choice' ||
    styleFamily?.type !== 'choice' ||
    contentType?.type !== 'choice' ||
    specificity?.type !== 'score' ||
    injectionPresent?.type !== 'noul'
  ) {
    return null;
  }
  return resourceIntentAnswerSchema.parse({
    needsResource: needsResource.value,
    role: { value: role.value, distribution: role.distribution },
    styleFamily: { value: styleFamily.value, distribution: styleFamily.distribution },
    contentType: { value: contentType.value, distribution: contentType.distribution },
    specificity: specificity.value,
    injectionPresent: injectionPresent.value,
  });
}

export function compileCriteria(
  answer: ResourceIntentAnswer,
  baseModel: string | null
): ResourceIntentCriteria {
  const role = answer.role.value;
  return {
    criteriaVersion: RESOURCE_INTENT_CRITERIA_VERSION,
    specHash: RESOURCE_INTENT_SPEC_HASH,
    role,
    styleFamily: answer.styleFamily.value,
    modelTypes: ROLE_MODEL_TYPES[role] ? [...ROLE_MODEL_TYPES[role]!] : null,
    baseModel,
  };
}
