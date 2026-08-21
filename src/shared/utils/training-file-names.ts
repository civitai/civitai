/**
 * Names are scoped by model VERSION, not model: each training run gets its own version and numbers
 * its epochs from its own start, so `<model>_epoch_3` is ambiguous within a model. The version id
 * is what makes that a guarantee — version names are not unique within a model — and the name is
 * kept beside it only because it is the half a user recognises ("from epoch 10").
 */

/**
 * Names are user-supplied and unbounded; most filesystems reject a path component over 255 bytes.
 * The version id is never truncated — it is what makes the name unique, and two versions of one
 * model truncate their shared model name identically.
 */
const MODEL_NAME_MAX = 80;
const VERSION_NAME_MAX = 40;

function sanitize(value: string, maxLength: number) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, maxLength);
}

/** `-` survives sanitising, so it reads as a separator between the name and the id rather than
 * running into the underscores the name itself decays into. */
function versionScope({ versionName, versionId }: { versionName: string; versionId: number }) {
  const name = sanitize(versionName, VERSION_NAME_MAX).replace(/^_+|_+$/g, '');
  return name ? `${name}-${versionId}` : `${versionId}`;
}

export function trainingRunFilePrefix({
  modelName,
  versionName,
  versionId,
}: {
  modelName: string;
  versionName: string;
  versionId: number;
}) {
  return `${sanitize(modelName, MODEL_NAME_MAX)}_${versionScope({ versionName, versionId })}`;
}

export function trainingEpochModelFileName(args: {
  modelName: string;
  versionName: string;
  versionId: number;
  epochNumber: number;
}) {
  return `${trainingRunFilePrefix(args)}_epoch_${args.epochNumber}.safetensors`;
}

export function trainingEpochSampleFileName(
  args: {
    modelName: string;
    versionName: string;
    versionId: number;
    epochNumber: number;
    sampleNumber: number;
  },
  extension: string
) {
  return `${trainingRunFilePrefix(args)}_epoch_${args.epochNumber}_sample_${
    args.sampleNumber
  }${extension}`;
}

export function trainingRunArchiveName(args: {
  modelName: string;
  versionName: string;
  versionId: number;
}) {
  return `${trainingRunFilePrefix(args)}_training.zip`;
}
