import { workflowOptions, type WorkflowOption } from './config/workflows';
import { probeFieldExists, PROBE_CTX } from './field-probe';

const hasFieldCache = new Map<string, boolean>();

/** Whether `workflow` exposes `fieldKey`, with the ecosystem left at its default. */
export function workflowHasField(workflow: string, fieldKey: string): boolean {
  const cacheKey = `${workflow}:${fieldKey}`;
  let result = hasFieldCache.get(cacheKey);
  if (result === undefined) {
    result = probeFieldExists(fieldKey, workflow, PROBE_CTX);
    hasFieldCache.set(cacheKey, result);
  }
  return result;
}

/**
 * Workflows that accept a given media type as input, derived from the form rather than a list.
 * Audio and model3d are output-only, so nothing accepts them.
 */
export function getWorkflowsForMediaType(
  mediaType: 'image' | 'video' | 'audio' | 'model3d'
): WorkflowOption[] {
  if (mediaType === 'audio' || mediaType === 'model3d') return [];
  if (mediaType === 'video')
    return workflowOptions.filter((w) => workflowHasField(w.graphKey, 'video'));
  // PolyGen's img2model3d feeds a single `sourceImage` nested behind the ecosystem + process
  // discriminators rather than the standard `images` array, so the probe cannot see it —
  // image-input 3D workflows are included by config instead.
  return workflowOptions.filter(
    (w) =>
      workflowHasField(w.graphKey, 'images') ||
      (w.category === 'model3d' && w.inputType === 'image')
  );
}
