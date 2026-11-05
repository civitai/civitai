/** GLB is the only format the inline viewer and the `model3DPreview` render can load. */
export function isGlbFormat(format: string | null | undefined) {
  return (format ?? '').trim().toLowerCase().replace(/^\./, '') === 'glb';
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

type Model3DFileLike = { format: string; variant: string | null; isPrimary: boolean };

/** Whether the inline viewer can show a saved Model3D file. Armature-only meshes have no visible geometry. */
export function isViewableModel3DFile(file: Model3DFileLike) {
  return isGlbFormat(file.format) && !(file.variant ?? 'primary').endsWith('-armature');
}

/**
 * The file a single-file preview should mount: the primary when it's viewable, else the first viewable
 * file (an FBX-primary model can still ship a GLB variant). With nothing viewable it returns the
 * primary, so the viewer shows its download fallback.
 */
export function pickModel3DPreviewFile<T extends Model3DFileLike>(files: T[]): T | null {
  return (
    files.find((f) => f.isPrimary && isViewableModel3DFile(f)) ??
    files.find(isViewableModel3DFile) ??
    files.find((f) => f.isPrimary) ??
    files[0] ??
    null
  );
}
