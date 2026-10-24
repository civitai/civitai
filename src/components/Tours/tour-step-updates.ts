import type { StepWithData } from '~/types/tour';

const targets = (steps: readonly StepWithData[]) => steps.map((step) => String(step.target));

/**
 * Which step array a running tour should adopt.
 *
 * A tour's steps are cut from the full list by conditions that keep moving while the tour
 * runs — `hasGeneratedImages` flips the moment the user generates, which the content
 * generation tour asks them to do. Recomputing on every change is what lets the tail come
 * back; the danger is a recomputation that removes or replaces a step the user has already
 * walked past, which slides every later index down and lands them somewhere else.
 *
 * So a candidate is adopted only while the walked prefix — every step up to and including
 * the current one — is unchanged. Returns null to keep the current array, including when
 * the candidate is the same list, so an unchanged recomputation costs no render.
 */
export function nextTourSteps(
  current: readonly StepWithData[] | undefined,
  candidate: readonly StepWithData[],
  currentStep: number
): StepWithData[] | null {
  const before = targets(current ?? []);
  const after = targets(candidate);
  if (before.length === after.length && before.every((target, i) => target === after[i]))
    return null;

  const walked = currentStep + 1;
  if (
    currentStep > 0 &&
    (after.length < walked || before.slice(0, walked).some((target, i) => target !== after[i]))
  )
    return null;

  return [...candidate];
}
