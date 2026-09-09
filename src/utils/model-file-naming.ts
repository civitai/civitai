import { constants } from '~/server/common/constants';
import type { ModelFileType } from '~/server/common/constants';
import { ModelType } from '~/shared/utils/prisma/enums';
import { filenamize, replaceInsensitive } from '~/utils/string-helpers';

export type NameableModel = { name: string; type: ModelType };
export type NameableVersion = { name: string; trainedWords?: string[] };
export type NameableFile = {
  id?: number;
  name: string;
  overrideName?: string | null;
  type: ModelFileType | string;
  /** Prisma hands this back as JsonValue; `variantSuffix` narrows it rather than trusting a cast. */
  metadata?: unknown;
};

function computeFileName({
  model,
  modelVersion,
  file,
}: {
  model: NameableModel;
  modelVersion: NameableVersion;
  file: NameableFile;
}) {
  let fileName = file.name;
  const modelName = filenamize(model.name);
  let versionName = filenamize(replaceInsensitive(modelVersion.name, modelName, ''));

  if (modelName.length === 0) return fileName;

  const ext = file.name.split('.').pop();
  if (!constants.modelFileTypes.includes(file.type as ModelFileType)) return file.name;
  const fileType = file.type as ModelFileType;

  if (fileType === 'Training Data') {
    fileName = `${modelName}_${versionName}_trainingData.zip`;
  } else if (model.type === ModelType.TextualInversion) {
    const trainedWord = modelVersion.trainedWords?.[0];
    let fileSuffix = '';
    if (fileType === 'Negative') fileSuffix = '-neg';

    if (trainedWord) fileName = `${trainedWord}${fileSuffix}.${ext}`;
  } else if (fileType !== 'VAE') {
    let fileSuffix = '';
    if (fileName.toLowerCase().includes('-inpainting')) {
      versionName = versionName.replace(/_?inpainting/i, '');
      fileSuffix = '-inpainting';
    } else if (fileName.toLowerCase().includes('.instruct-pix2pix')) {
      versionName = versionName.replace(/_?instruct|-?pix2pix/gi, '');
      fileSuffix = '.instruct-pix2pix';
    } else if (fileType === 'Text Encoder') fileSuffix = '_txt';

    fileName = `${modelName}_${versionName}${fileSuffix}.${ext}`;
  }
  return fileName;
}

function insertBeforeExtension(fileName: string, suffix: string) {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return `${fileName}_${suffix}`;
  return `${fileName.slice(0, dot)}_${suffix}${fileName.slice(dot)}`;
}

function variantSuffix(file: NameableFile) {
  const metadata = (file.metadata ?? {}) as Record<string, unknown>;
  return [metadata.size, metadata.fp, metadata.quantType]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .map((part) => filenamize(part))
    .join('_');
}

/**
 * The download filename for one file, unique among the files it sits beside. Without `versionFiles`
 * every file on a version resolves to the same name, which is how a version offering full and
 * pruned downloads served both under one name and the second overwrote the first.
 */
export function resolveModelFileName({
  model,
  modelVersion,
  file,
  versionFiles,
}: {
  model: NameableModel;
  modelVersion: NameableVersion;
  file: NameableFile;
  versionFiles?: NameableFile[];
}): string {
  if (file.overrideName) return file.overrideName;

  const fileName = computeFileName({ model, modelVersion, file });
  if (!versionFiles?.length) return fileName;

  const nameOf = (candidate: NameableFile) =>
    candidate.overrideName || computeFileName({ model, modelVersion, file: candidate });
  const twins = versionFiles.filter((candidate) => nameOf(candidate) === fileName);
  if (twins.length < 2) return fileName;

  const suffix = variantSuffix(file);
  if (suffix) {
    const candidate = insertBeforeExtension(fileName, suffix);
    const stillShared = twins.some(
      (twin) =>
        twin.id !== file.id &&
        insertBeforeExtension(nameOf(twin), variantSuffix(twin)) === candidate
    );
    if (!stillShared) return candidate;
  }

  // Nothing about the file itself tells it apart from its twin, so fall back to the one thing that
  // is guaranteed distinct.
  return file.id != null ? insertBeforeExtension(fileName, String(file.id)) : fileName;
}
