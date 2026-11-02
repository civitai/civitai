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

/** A version name that only repeated the model name leaves nothing behind, and an empty segment
 * would otherwise show up as a trailing or doubled underscore. */
function joinNameParts(...parts: string[]) {
  return parts.filter(Boolean).join('_');
}

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
  // Strip the model name in both spellings: a version called "BB Bunny v2" repeats it raw, one
  // called "bbBunnyV2" repeats it filenamized, and either way the segment would be doubled.
  // Trimmed because the strip leaves the separator behind, and a leading empty segment is what
  // `camelCase` capitalises — "BB Bunny v2" would come out as `V2` rather than `v2`.
  let versionName = filenamize(
    replaceInsensitive(replaceInsensitive(modelVersion.name, model.name, ''), modelName, '').trim()
  );
  if (versionName === modelName) versionName = '';

  // A LoRA keeps the name its creator uploaded — creators encode the base model, the variant or the
  // character there, and `<model>_<version>` cannot carry any of it.
  const keepsUploadedName =
    model.type === ModelType.LORA || model.type === ModelType.LoCon || modelName.length === 0;
  if (keepsUploadedName) return fileName;

  const ext = file.name.split('.').pop();
  if (!constants.modelFileTypes.includes(file.type as ModelFileType)) return file.name;
  const fileType = file.type as ModelFileType;

  if (fileType === 'Training Data') {
    fileName = `${joinNameParts(modelName, versionName, 'trainingData')}.zip`;
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

    fileName = `${joinNameParts(modelName, versionName)}${fileSuffix}.${ext}`;
  }
  return fileName;
}

/** Basenames that say nothing about the model they belong to: framework and trainer defaults. */
export const GENERIC_FILE_BASENAMES = [
  'model',
  'diffusion_pytorch_model',
  'pytorch_model',
  'pytorch_lora_weights',
  'adapter_model',
  'text_encoder',
  'text_encoder_2',
  'unet',
  'transformer',
  'vae',
  'ae',
  'clip',
  'checkpoint',
  'weights',
  'output',
  'final',
  'last',
  'untitled',
  'file',
  'download',
] as const;

const genericBasenames = new Set<string>(GENERIC_FILE_BASENAMES);
const genericNamePatterns = [
  /-\d+-of-\d+$/, // shard: model-00001-of-00003
  /^[0-9a-hjkmnp-tv-z]{26}$/, // ULID: a training job id
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, // UUID
  /^[0-9a-f]{16,}$/, // hash
  /^\d+$/,
];

export function isGenericFileName(fileName: string) {
  const dot = fileName.lastIndexOf('.');
  const basename = (dot > 0 ? fileName.slice(0, dot) : fileName)
    .toLowerCase()
    .replace(/\.(fp16|fp32|bf16|fp8)$/, '');
  if (!basename || genericBasenames.has(basename)) return true;
  return genericNamePatterns.some((pattern) => pattern.test(basename));
}

/**
 * The name before siblings are considered: the uploaded name, which is what the model page lists
 * and what workflows look files up by, unless it is generic.
 */
function preferredFileName(args: Parameters<typeof computeFileName>[0]) {
  const { model, file } = args;
  // A Textual Inversion's filename is its prompt token in A1111, and training data is loaded by no
  // workflow tool, so both keep the scheme.
  if (model.type === ModelType.TextualInversion || file.type === 'Training Data')
    return computeFileName(args);
  return isGenericFileName(file.name) ? computeFileName(args) : file.name;
}

/** Windows and macOS file systems ignore case, so names equal in any case overwrite each other. */
function fileNameKey(fileName: string) {
  return fileName.toLowerCase();
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
 * Names every file on a version at once, so no two share a name. A file keeps its preferred name
 * unless another file's preferred name equals it; the colliding files then try the scheme name,
 * then the scheme with the variant suffix, then with the file id, each accepted only if no other
 * file holds or is trying the same name.
 */
function nameVersionFiles(
  model: NameableModel,
  modelVersion: NameableVersion,
  files: NameableFile[]
): string[] {
  const names = files.map(
    (file) => file.overrideName || preferredFileName({ model, modelVersion, file })
  );
  const counts = new Map<string, number>();
  for (const name of names) counts.set(fileNameKey(name), (counts.get(fileNameKey(name)) ?? 0) + 1);

  const taken = new Set<string>();
  let moving: number[] = [];
  files.forEach((file, i) => {
    if (file.overrideName || counts.get(fileNameKey(names[i])) === 1)
      taken.add(fileNameKey(names[i]));
    else moving.push(i);
  });

  const schemeOf = (file: NameableFile) => computeFileName({ model, modelVersion, file });
  const stages: Array<(file: NameableFile) => string | undefined> = [
    schemeOf,
    (file) => {
      const suffix = variantSuffix(file);
      return suffix ? insertBeforeExtension(schemeOf(file), suffix) : undefined;
    },
    (file) =>
      file.id != null ? insertBeforeExtension(schemeOf(file), String(file.id)) : undefined,
  ];
  for (const stage of stages) {
    const candidates = moving.map((i) => stage(files[i]));
    const tried = new Map<string, number>();
    for (const candidate of candidates) {
      if (candidate)
        tried.set(fileNameKey(candidate), (tried.get(fileNameKey(candidate)) ?? 0) + 1);
    }
    moving = moving.filter((i, j) => {
      const candidate = candidates[j];
      if (!candidate) return true;
      const key = fileNameKey(candidate);
      if (taken.has(key) || tried.get(key) !== 1) return true;
      names[i] = candidate;
      taken.add(key);
      return false;
    });
  }

  // Nothing above told these apart: no id, or `<scheme>_<id>` is another file's uploaded name.
  for (const i of moving) {
    const base = files[i].id != null ? `${files[i].id}_` : '';
    let attempt = 1;
    let candidate: string;
    do {
      candidate = insertBeforeExtension(schemeOf(files[i]), `${base}${attempt++}`);
    } while (taken.has(fileNameKey(candidate)));
    names[i] = candidate;
    taken.add(fileNameKey(candidate));
  }
  return names;
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
  if (!versionFiles?.length) return preferredFileName({ model, modelVersion, file });

  // API callers pass a destructured copy of the file, so find it by id, or by content without one.
  let index = versionFiles.indexOf(file);
  if (index < 0 && file.id != null) index = versionFiles.findIndex((c) => c.id === file.id);
  if (index < 0 && file.id == null) {
    index = versionFiles.findIndex(
      (c) =>
        c.id == null &&
        c.name === file.name &&
        (c.overrideName ?? null) === (file.overrideName ?? null) &&
        c.type === file.type &&
        JSON.stringify(c.metadata) === JSON.stringify(file.metadata)
    );
  }
  const files = index < 0 ? [file, ...versionFiles] : versionFiles;
  return nameVersionFiles(model, modelVersion, files)[index < 0 ? 0 : index];
}
