/** `.GLB ` → `glb`: formats arrive from the orchestrator and file names un-normalised. */
export function normalizeModel3DFormat(format: string | null | undefined) {
  return (format ?? '').trim().toLowerCase().replace(/^\./, '');
}

/** GLB is the only format the inline viewer and the `model3DPreview` render can load. */
export function isGlbFormat(format: string | null | undefined) {
  return normalizeModel3DFormat(format) === 'glb';
}

/**
 * Files the inline three.js viewer can show: GLB only (GLTFLoader doesn't read FBX), minus
 * armature-only meshes, which have no visible geometry.
 */
export function isInlineViewableModel3DFile(file: {
  format: string | null | undefined;
  variant?: string | null;
}) {
  return isGlbFormat(file.format) && !(file.variant ?? 'primary').endsWith('-armature');
}

type Model3DStepLike = {
  $type: string;
  status?: string | null;
  output: Array<{ type: string; available: boolean; format?: string }>;
};

/**
 * Whether a 3D workflow delivered its mesh as a non-GLB file (Tripo quad is FBX-only). Its
 * `model3DPreview` step, when one was chained, can never render, so a canceled or expired preview
 * doesn't mean the generation failed.
 */
export function isFbxOnlyDelivered(steps: Model3DStepLike[]) {
  return steps.some(
    (step) =>
      step.$type === 'polyGen' &&
      step.status === 'succeeded' &&
      step.output.some(
        (blob) => blob.type === 'model3d' && blob.available && !isGlbFormat(blob.format)
      )
  );
}
