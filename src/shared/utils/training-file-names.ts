/**
 * Names are scoped by model VERSION, not model: each training run gets its own version and numbers
 * its epochs from its own start, so `<model>_epoch_3` is ambiguous within a model. The id carries
 * that, not the version name — version names are not unique within a model.
 */

/**
 * Model names reach 664 chars in prod; most filesystems reject a path component over 255 bytes.
 * The version id is never truncated — it is what makes the name unique.
 */
const MODEL_NAME_MAX = 80;
const ARCHITECTURE_MAX = 20;

function sanitize(value: string, maxLength: number) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, maxLength);
}

export type TrainingRunNameParts = {
  modelName: string;
  versionId: number;
  /** Short base-model key from `trainingArchitectureKey`, e.g. `pony`, `krea2`. Absent on older runs. */
  architecture?: string | null;
};

export function trainingRunFilePrefix({
  modelName,
  versionId,
  architecture,
}: TrainingRunNameParts) {
  const arch = architecture ? sanitize(architecture, ARCHITECTURE_MAX).replace(/^_+|_+$/g, '') : '';
  return [sanitize(modelName, MODEL_NAME_MAX), arch, String(versionId)].filter(Boolean).join('_');
}

export function trainingEpochModelFileName(args: TrainingRunNameParts & { epochNumber: number }) {
  return `${trainingRunFilePrefix(args)}_epoch_${args.epochNumber}.safetensors`;
}

export function trainingEpochSampleFileName(
  args: TrainingRunNameParts & { epochNumber: number; sampleNumber: number },
  extension: string
) {
  return `${trainingRunFilePrefix(args)}_epoch_${args.epochNumber}_sample_${
    args.sampleNumber
  }${extension}`;
}

export function trainingRunArchiveName(args: TrainingRunNameParts) {
  return `${trainingRunFilePrefix(args)}_training.zip`;
}
