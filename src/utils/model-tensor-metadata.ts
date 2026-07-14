import type { ModelFileType } from '~/server/common/constants';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

const SAFETENSORS_HEADER_LIMIT_BYTES = 64 * MiB;
const GGUF_HEADER_READ_SIZES = [1 * MiB, 4 * MiB, 16 * MiB, 64 * MiB];

const COMFY_INFERENCE_RESERVE_BYTES = Math.floor(0.8 * GiB);
const COMFY_EXTRA_RESERVED_BYTES = 400 * MiB;
const COMFY_DYNAMIC_VRAM_PAGE_BYTES = 32 * MiB;

type FetchLike = typeof fetch;

export type ModelTensorFormat = 'SafeTensor' | 'GGUF';
export type DetectedModelTensorType =
  | 'Checkpoint'
  | 'LoRA'
  | 'VAE'
  | 'TextEncoder'
  | 'VisionEncoder'
  | 'UNet'
  | 'DiffusionModel'
  | 'ControlNet';
export type ModelTensorVramSupport = {
  modelType?: string | null;
  fileType?: string | null;
};

export type ModelTensorInfo = {
  name: string;
  shape: number[];
  dtype: string;
  sizeBytes: number;
};

export type ModelTensorDtypeSummary = {
  dtype: string;
  count: number;
  bytes: number;
};

export type ModelTensorDisplayGroup = {
  id: string;
  name: string;
  displayCount: number;
  tensorCount: number;
  sizeBytes: number;
  tensors: ModelTensorInfo[];
};

export type ModelTensorDisplayRow =
  | { type: 'group'; group: ModelTensorDisplayGroup }
  | { type: 'tensor'; tensor: ModelTensorInfo };

export type ModelVramEstimate = {
  estimatedMinimumVramBytes: number;
  recommendedVramBytes: number;
  residentWeightsBytes: number;
  fullyResidentWeightsBytes: number;
  inferenceReserveBytes: number;
  extraReservedBytes: number;
  dynamicVramPageBytes: number;
};

export type ModelTensorAnalysis = {
  format: ModelTensorFormat;
  tensorCount: number;
  totalTensorBytes: number;
  dtypeCounts: ModelTensorDtypeSummary[];
  weightPrecision: string | null;
  detectedModelType: DetectedModelTensorType | null;
  largestTensor: ModelTensorInfo | null;
  vramEstimate: ModelVramEstimate | null;
  tensors: ModelTensorInfo[];
};

type ParseModelTensorMetadataOptions = {
  url: string;
  format: ModelTensorFormat;
  fileSizeBytes?: number;
  estimateVram?: boolean;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
};

export async function parseModelTensorMetadata({
  url,
  format,
  fileSizeBytes,
  estimateVram = true,
  signal,
  fetchImpl = fetch,
}: ParseModelTensorMetadataOptions): Promise<ModelTensorAnalysis> {
  const tensors =
    format === 'SafeTensor'
      ? await parseSafetensorsTensors({ url, signal, fetchImpl })
      : await parseGgufTensors({ url, fileSizeBytes, signal, fetchImpl });

  return analyzeModelTensors(format, tensors, { estimateVram });
}

export function analyzeModelTensors(
  format: ModelTensorFormat,
  tensors: ModelTensorInfo[],
  { estimateVram = true }: { estimateVram?: boolean } = {}
): ModelTensorAnalysis {
  const dtypeCounts = new Map<string, ModelTensorDtypeSummary>();
  let totalTensorBytes = 0;
  let largestTensor: ModelTensorInfo | null = null;

  for (const tensor of tensors) {
    totalTensorBytes += tensor.sizeBytes;
    if (!largestTensor || tensor.sizeBytes > largestTensor.sizeBytes) largestTensor = tensor;

    const summary = dtypeCounts.get(tensor.dtype) ?? {
      dtype: tensor.dtype,
      count: 0,
      bytes: 0,
    };
    summary.count += 1;
    summary.bytes += tensor.sizeBytes;
    dtypeCounts.set(tensor.dtype, summary);
  }

  const dtypeSummary = [...dtypeCounts.values()].sort((a, b) => b.bytes - a.bytes);

  return {
    format,
    tensorCount: tensors.length,
    totalTensorBytes,
    dtypeCounts: dtypeSummary,
    weightPrecision: getDominantWeightPrecision(dtypeSummary),
    detectedModelType: format === 'SafeTensor' ? detectModelTypeFromTensors(tensors) : null,
    largestTensor,
    vramEstimate: estimateVram ? estimateComfyDynamicOffloadVram(tensors) : null,
    tensors,
  };
}

export function getDominantWeightPrecision(dtypeCounts: ModelTensorDtypeSummary[]) {
  const bytesByPrecision = new Map<string, number>();

  for (const { dtype, bytes } of dtypeCounts) {
    if (!Number.isFinite(bytes) || bytes <= 0) continue;
    const precision = toWeightPrecision(dtype);
    bytesByPrecision.set(precision, (bytesByPrecision.get(precision) ?? 0) + bytes);
  }

  let dominant: { precision: string; bytes: number } | null = null;
  for (const [precision, bytes] of bytesByPrecision) {
    if (!dominant || bytes > dominant.bytes) dominant = { precision, bytes };
  }

  return dominant?.precision ?? null;
}

export function weightPrecisionToModelFileFp(
  weightPrecision: string | null | undefined
): ModelFileFp | null {
  switch (weightPrecision?.toUpperCase()) {
    case 'FP32':
    case 'FP64':
      return 'fp32';
    case 'FP16':
      return 'fp16';
    case 'BF16':
      return 'bf16';
    case 'FP8':
      return 'fp8';
    case 'NF4':
      return 'nf4';
    default:
      return null;
  }
}

export function detectModelTypeFromTensors(
  tensors: Pick<ModelTensorInfo, 'name'>[]
): DetectedModelTensorType | null {
  const names = tensors.map(({ name }) => name.toLowerCase());
  const has = (predicate: (name: string) => boolean) => names.some(predicate);
  const count = (predicate: (name: string) => boolean) => names.filter(predicate).length;
  const startsWithAny = (name: string, prefixes: string[]) =>
    prefixes.some((prefix) => name.startsWith(prefix));

  const hasLoraA = has((name) => /\.lora_(?:a|down)\.weight$/.test(name));
  const hasLoraB = has((name) => /\.lora_(?:b|up)\.weight$/.test(name));
  if (hasLoraA && hasLoraB) return 'LoRA';

  if (
    has((name) =>
      startsWithAny(name, [
        'control_model.',
        'controlnet_blocks.',
        'controlnet_down_blocks.',
        'controlnet_mid_block.',
        'zero_convs.',
        'input_hint_block.',
      ])
    )
  )
    return 'ControlNet';

  const diffusionPrefixes = ['model.diffusion_model.', 'diffusion_model.'];
  const hasDiffusionNamespace = has((name) => startsWithAny(name, diffusionPrefixes));
  const hasCheckpointComponents = has((name) =>
    startsWithAny(name, ['first_stage_model.', 'cond_stage_model.', 'conditioner.embedders.'])
  );
  if (hasDiffusionNamespace && hasCheckpointComponents) return 'Checkpoint';

  const encoderCount = count((name) => name.startsWith('encoder.'));
  const decoderCount = count((name) => name.startsWith('decoder.'));
  const hasVaeEncoderStructure = has((name) =>
    /^(?:encoder\.(?:down|downsamples|conv_in|mid)|quant_conv\.)/.test(name)
  );
  const hasVaeDecoderStructure = has((name) =>
    /^(?:decoder\.(?:up|upsamples|conv_out|mid)|post_quant_conv\.)/.test(name)
  );
  if (encoderCount >= 2 && decoderCount >= 2 && hasVaeEncoderStructure && hasVaeDecoderStructure)
    return 'VAE';

  if (
    has((name) => name.includes('vision_model.embeddings.')) &&
    has((name) => name.includes('vision_model.encoder.'))
  )
    return 'VisionEncoder';

  const hasClipTextEncoder =
    has((name) => name.includes('text_model.embeddings.')) &&
    has((name) => name.includes('text_model.encoder.'));
  const hasLlmTextEncoder =
    has((name) => name.endsWith('embed_tokens.weight')) &&
    count((name) => /(?:^|\.)layers\.\d+\./.test(name)) >= 2;
  const hasT5TextEncoder =
    has((name) => name === 'shared.weight' || name.endsWith('.shared.weight')) &&
    count((name) => /(?:^|\.)encoder\.block\.\d+\./.test(name)) >= 2;
  if (hasClipTextEncoder || hasLlmTextEncoder || hasT5TextEncoder) return 'TextEncoder';

  const hasInputBlocks = has((name) =>
    /^(?:(?:model\.)?diffusion_model\.)?input_blocks\./.test(name)
  );
  const hasMiddleBlock = has((name) =>
    /^(?:(?:model\.)?diffusion_model\.)?middle_block\./.test(name)
  );
  const hasOutputBlocks = has((name) =>
    /^(?:(?:model\.)?diffusion_model\.)?output_blocks\./.test(name)
  );
  if (hasInputBlocks && hasMiddleBlock && hasOutputBlocks) return 'UNet';

  const hasFluxBlocks =
    has((name) => name.startsWith('double_blocks.')) &&
    has((name) => name.startsWith('single_blocks.'));
  const hasJointTransformer =
    has((name) => name.startsWith('joint_blocks.')) &&
    has((name) => /^(?:x|context)_embedder\./.test(name));
  const hasDiffusersTransformer =
    has((name) => name.startsWith('transformer_blocks.')) &&
    has((name) => /^(?:patch_embed|pos_embed|proj_in|x_embedder)\./.test(name));
  const hasKreaTransformer =
    count((name) => /^blocks\.\d+\./.test(name)) >= 2 &&
    has((name) => name === 'first.weight') &&
    has((name) => name === 'last.linear.weight');
  if (hasFluxBlocks || hasJointTransformer || hasDiffusersTransformer || hasKreaTransformer)
    return 'DiffusionModel';

  return null;
}

export function getModelFileTypeCorrection({
  detectedModelType,
  modelType,
  currentFileType,
}: {
  detectedModelType: DetectedModelTensorType | null | undefined;
  modelType?: string | null;
  currentFileType?: string | null;
}): ModelFileType | null {
  if (!detectedModelType) return null;

  let canonicalType: ModelFileType;
  let compatibleTypes: readonly string[] = [];

  switch (detectedModelType) {
    case 'Checkpoint':
      canonicalType = 'Model';
      compatibleTypes = modelType === 'Checkpoint' ? ['Model', 'Pruned Model'] : ['Model'];
      break;
    case 'LoRA':
      if (modelType === 'LORA' || modelType === 'DoRA' || modelType === 'LoCon') {
        canonicalType = 'Model';
        compatibleTypes = ['Model', 'Pruned Model'];
      } else {
        canonicalType = 'Enhancement LoRA';
      }
      break;
    case 'VAE':
      canonicalType = modelType === 'VAE' ? 'Model' : 'VAE';
      break;
    case 'TextEncoder':
      canonicalType = modelType === 'TextEncoder' ? 'Model' : 'Text Encoder';
      break;
    case 'VisionEncoder':
      canonicalType =
        modelType === 'CLIPVision'
          ? 'Model'
          : modelType === 'CLIP'
          ? 'Vision Encoder'
          : 'CLIPVision';
      break;
    case 'UNet':
      canonicalType = modelType === 'UNet' ? 'Model' : 'UNet';
      break;
    case 'DiffusionModel':
      canonicalType = modelType === 'UNet' ? 'Model' : 'Diffusion Model';
      break;
    case 'ControlNet':
      canonicalType = modelType === 'Controlnet' ? 'Model' : 'ControlNet';
      break;
  }

  if (currentFileType === canonicalType || compatibleTypes.includes(currentFileType ?? ''))
    return null;
  return canonicalType;
}

function toWeightPrecision(dtype: string) {
  const normalized = normalizePrecision(dtype);
  if (normalized.startsWith('F8')) return 'FP8';

  const floatMatch = /^F(\d+)$/.exec(normalized);
  if (floatMatch) return `FP${floatMatch[1]}`;

  const quantizedMatch = /^(I?Q)(\d+)/.exec(normalized);
  if (quantizedMatch) return `${quantizedMatch[1]}${quantizedMatch[2]}`;

  const integerMatch = /^I(\d+)$/.exec(normalized);
  if (integerMatch) return `INT${integerMatch[1]}`;

  const unsignedIntegerMatch = /^U(\d+)$/.exec(normalized);
  if (unsignedIntegerMatch) return `UINT${unsignedIntegerMatch[1]}`;

  return normalized;
}

export function supportsTensorVramEstimate({ modelType, fileType }: ModelTensorVramSupport) {
  return modelType === 'Checkpoint' && CHECKPOINT_WEIGHT_FILE_TYPES.has(fileType ?? '');
}

export function buildTensorDisplayRows(tensors: ModelTensorInfo[]): ModelTensorDisplayRow[] {
  const topLevelGroups = new Map<string, ModelTensorInfo[]>();
  for (const tensor of tensors) {
    const groupName = getTopLevelGroupName(tensor.name);
    const group = topLevelGroups.get(groupName) ?? [];
    group.push(tensor);
    topLevelGroups.set(groupName, group);
  }

  const emittedGroups = new Set<string>();
  const rows: ModelTensorDisplayRow[] = [];

  for (const tensor of tensors) {
    const groupName = getTopLevelGroupName(tensor.name);
    const groupTensors = topLevelGroups.get(groupName) ?? [tensor];

    if (groupTensors.length <= 1) {
      rows.push({ type: 'tensor', tensor });
      continue;
    }

    if (emittedGroups.has(groupName)) continue;
    emittedGroups.add(groupName);

    rows.push({
      type: 'group',
      group: {
        id: groupName,
        name: groupName,
        displayCount: getDisplayGroupCount(groupName, groupTensors),
        tensorCount: groupTensors.length,
        sizeBytes: groupTensors.reduce((sum, item) => sum + item.sizeBytes, 0),
        tensors: groupTensors,
      },
    });
  }

  return rows;
}

export function inferTensorMetadataFormat(file: {
  name?: string | null;
  metadata?: BasicFileMetadata | null;
}): ModelTensorFormat | null {
  const format = file.metadata?.format;
  if (format === 'SafeTensor' || format === 'GGUF') return format;

  const lowerName = file.name?.toLowerCase() ?? '';
  if (lowerName.endsWith('.safetensors') || lowerName.endsWith('.sft')) return 'SafeTensor';
  if (lowerName.endsWith('.gguf')) return 'GGUF';

  return null;
}

function estimateComfyDynamicOffloadVram(tensors: ModelTensorInfo[]): ModelVramEstimate {
  const layerGroups = buildLayerGroups(tensors);
  let residentWeightsBytes = 0;

  for (const layer of layerGroups)
    residentWeightsBytes = Math.max(residentWeightsBytes, layer.bytes);
  const largestTensorBytes = Math.max(...tensors.map((tensor) => tensor.sizeBytes), 0);
  residentWeightsBytes = roundUpToPage(
    Math.max(residentWeightsBytes, largestTensorBytes),
    COMFY_DYNAMIC_VRAM_PAGE_BYTES
  );
  const fullyResidentWeightsBytes = roundUpToPage(
    tensors.reduce((sum, tensor) => sum + tensor.sizeBytes, 0),
    COMFY_DYNAMIC_VRAM_PAGE_BYTES
  );
  const baseReserveBytes = COMFY_INFERENCE_RESERVE_BYTES + COMFY_EXTRA_RESERVED_BYTES;

  return {
    estimatedMinimumVramBytes: residentWeightsBytes + baseReserveBytes,
    recommendedVramBytes: fullyResidentWeightsBytes + baseReserveBytes,
    residentWeightsBytes,
    fullyResidentWeightsBytes,
    inferenceReserveBytes: COMFY_INFERENCE_RESERVE_BYTES,
    extraReservedBytes: COMFY_EXTRA_RESERVED_BYTES,
    dynamicVramPageBytes: COMFY_DYNAMIC_VRAM_PAGE_BYTES,
  };
}

function buildLayerGroups(tensors: ModelTensorInfo[]) {
  const groups = new Map<string, { name: string; bytes: number }>();

  for (const tensor of tensors) {
    const name = getLayerGroupName(tensor.name);
    const group = groups.get(name) ?? { name, bytes: 0 };
    group.bytes += tensor.sizeBytes;
    groups.set(name, group);
  }

  return [...groups.values()];
}

function getTopLevelGroupName(name: string) {
  return name.split('.')[0] || name;
}

function getLayerGroupName(name: string) {
  const parts = name.split('.');
  const numericIndex = parts.findIndex((part, index) => index > 0 && /^\d+$/.test(part));
  if (numericIndex > 0) return parts.slice(0, numericIndex + 1).join('.');
  return parts[0] || name;
}

function getDisplayGroupCount(groupName: string, tensors: ModelTensorInfo[]) {
  const childSegments = tensors.map((tensor) => {
    const suffix = tensor.name.slice(groupName.length + 1);
    return suffix.split('.')[0];
  });
  const numericChildren = childSegments.filter((segment) => /^\d+$/.test(segment));
  if (numericChildren.length === childSegments.length) return new Set(numericChildren).size;
  return tensors.length;
}

function roundUpToPage(value: number, pageSize: number) {
  if (value <= 0) return 0;
  return Math.ceil(value / pageSize) * pageSize;
}

async function parseSafetensorsTensors({
  url,
  signal,
  fetchImpl,
}: Pick<ParseModelTensorMetadataOptions, 'url' | 'signal' | 'fetchImpl'>) {
  const prefix = await fetchByteRange(url, 0, 7, { signal, fetchImpl });
  const headerLength = readUint64LE(prefix, 0);
  if (headerLength <= 0 || headerLength > SAFETENSORS_HEADER_LIMIT_BYTES) {
    throw new Error('SafeTensor header is missing or too large to parse safely');
  }

  const headerBytes = await fetchByteRange(url, 8, 7 + headerLength, { signal, fetchImpl });
  const header = JSON.parse(new TextDecoder().decode(headerBytes)) as Record<string, unknown>;
  const tensors: ModelTensorInfo[] = [];

  for (const [name, value] of Object.entries(header)) {
    if (name === '__metadata__' || !isSafetensorEntry(value)) continue;

    tensors.push({
      name,
      shape: value.shape,
      dtype: normalizePrecision(value.dtype),
      sizeBytes: getSafetensorSizeBytes(value),
    });
  }

  return tensors;
}

function isSafetensorEntry(value: unknown): value is {
  dtype: string;
  shape: number[];
  data_offsets?: [number, number];
} {
  if (!value || typeof value !== 'object') return false;
  const entry = value as { dtype?: unknown; shape?: unknown; data_offsets?: unknown };
  const offsetsValid =
    entry.data_offsets == null ||
    (Array.isArray(entry.data_offsets) &&
      entry.data_offsets.length === 2 &&
      entry.data_offsets.every((offset) => Number.isFinite(offset)));

  return (
    typeof entry.dtype === 'string' &&
    Array.isArray(entry.shape) &&
    entry.shape.every((dimension) => Number.isFinite(dimension)) &&
    offsetsValid
  );
}

function getSafetensorSizeBytes(entry: {
  dtype: string;
  shape: number[];
  data_offsets?: [number, number];
}) {
  if (entry.data_offsets) {
    const [start, end] = entry.data_offsets;
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) return end - start;
  }

  const dtypeBytes = SAFETENSORS_DTYPE_BYTES[normalizePrecision(entry.dtype)] ?? 0;
  return getElementCount(entry.shape) * dtypeBytes;
}

async function parseGgufTensors({
  url,
  signal,
  fetchImpl,
}: Pick<ParseModelTensorMetadataOptions, 'url' | 'fileSizeBytes' | 'signal' | 'fetchImpl'>) {
  let lastError: unknown;

  for (const readSize of GGUF_HEADER_READ_SIZES) {
    const bytes = await fetchByteRange(url, 0, readSize - 1, {
      signal,
      fetchImpl,
      allowShort: true,
    });

    try {
      return parseGgufHeader(bytes);
    } catch (error) {
      if (!(error instanceof NeedMoreBytesError)) throw error;
      lastError = error;
    }
  }

  throw lastError ?? new Error('GGUF header is too large to parse safely');
}

function parseGgufHeader(bytes: Uint8Array) {
  const reader = new ByteReader(bytes);
  const magic = reader.ascii(4);
  if (magic !== 'GGUF') throw new Error('File is not a GGUF model');

  reader.uint32(); // version
  const tensorCount = reader.uint64();
  const metadataCount = reader.uint64();

  if (tensorCount > 1_000_000 || metadataCount > 1_000_000) {
    throw new Error('GGUF header declares an unreasonable number of entries');
  }

  for (let i = 0; i < metadataCount; i++) {
    reader.string();
    skipGgufMetadataValue(reader, reader.uint32());
  }

  const tensors: ModelTensorInfo[] = [];
  for (let i = 0; i < tensorCount; i++) {
    const name = reader.string();
    const dimensionCount = reader.uint32();
    if (dimensionCount > 16) throw new Error('GGUF tensor has an invalid dimension count');

    const shape: number[] = [];
    for (let dimension = 0; dimension < dimensionCount; dimension++) shape.push(reader.uint64());

    const ggmlType = reader.uint32();
    reader.uint64(); // tensor data offset
    const typeInfo = GGML_TYPES[ggmlType];

    tensors.push({
      name,
      shape,
      dtype: typeInfo?.name ?? `GGML_${ggmlType}`,
      sizeBytes: typeInfo ? getGgmlTensorSizeBytes(shape, typeInfo) : 0,
    });
  }

  return tensors;
}

function skipGgufMetadataValue(reader: ByteReader, valueType: number): void {
  switch (valueType) {
    case 0:
    case 1:
    case 7:
      reader.skip(1);
      return;
    case 2:
    case 3:
      reader.skip(2);
      return;
    case 4:
    case 5:
    case 6:
      reader.skip(4);
      return;
    case 8:
      reader.string();
      return;
    case 9: {
      const itemType = reader.uint32();
      const itemCount = reader.uint64();
      if (itemCount > 1_000_000) throw new Error('GGUF metadata array is too large');
      for (let i = 0; i < itemCount; i++) skipGgufMetadataValue(reader, itemType);
      return;
    }
    case 10:
    case 11:
    case 12:
      reader.skip(8);
      return;
    default:
      throw new Error(`Unsupported GGUF metadata value type ${valueType}`);
  }
}

function getGgmlTensorSizeBytes(
  shape: number[],
  typeInfo: { blockSize: number; typeSize: number }
) {
  const [rowElements = 1, ...outerDimensions] = shape;
  const rowBytes = Math.ceil(rowElements / typeInfo.blockSize) * typeInfo.typeSize;
  const rowCount = outerDimensions.length ? getElementCount(outerDimensions) : 1;
  return rowBytes * rowCount;
}

function getElementCount(shape: number[]) {
  return shape.reduce((product, dimension) => product * dimension, 1);
}

async function fetchByteRange(
  url: string,
  start: number,
  end: number,
  {
    signal,
    fetchImpl = fetch,
    allowShort = false,
  }: { signal?: AbortSignal; fetchImpl?: FetchLike; allowShort?: boolean } = {}
) {
  const response = await fetchImpl(url, {
    headers: { Range: `bytes=${start}-${end}` },
    signal,
  });

  if (!response.ok) throw new Error(`Failed to fetch model metadata range: ${response.status}`);
  if (response.status !== 206) {
    throw new Error('Model host does not support byte-range requests');
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const expectedLength = end - start + 1;
  if (!allowShort && bytes.length < expectedLength) {
    throw new Error('Model metadata range response was shorter than expected');
  }

  return bytes;
}

function readUint64LE(bytes: Uint8Array, offset: number) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const low = view.getUint32(offset, true);
  const high = view.getUint32(offset + 4, true);
  const value = high * 2 ** 32 + low;
  if (value > Number.MAX_SAFE_INTEGER) throw new Error('64-bit integer exceeds safe range');
  return value;
}

function normalizePrecision(dtype: string) {
  return dtype.toUpperCase();
}

class NeedMoreBytesError extends Error {}

class ByteReader {
  private offset = 0;
  private readonly decoder = new TextDecoder();
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  ascii(length: number) {
    return new TextDecoder('ascii').decode(this.readBytes(length));
  }

  uint32() {
    this.require(4);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  uint64() {
    this.require(8);
    const value = readUint64LE(this.bytes, this.offset);
    this.offset += 8;
    return value;
  }

  string() {
    const length = this.uint64();
    return this.decoder.decode(this.readBytes(length));
  }

  skip(length: number) {
    this.require(length);
    this.offset += length;
  }

  private readBytes(length: number) {
    this.require(length);
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  private require(length: number) {
    if (this.offset + length > this.bytes.length) throw new NeedMoreBytesError();
  }
}

const SAFETENSORS_DTYPE_BYTES: Record<string, number> = {
  F64: 8,
  F32: 4,
  F16: 2,
  BF16: 2,
  F8_E5M2: 1,
  F8_E4M3: 1,
  F8_E4M3FN: 1,
  F8_E4M3FNUZ: 1,
  I64: 8,
  U64: 8,
  I32: 4,
  U32: 4,
  I16: 2,
  U16: 2,
  I8: 1,
  U8: 1,
  BOOL: 1,
};

const CHECKPOINT_WEIGHT_FILE_TYPES = new Set(['Model', 'Pruned Model', 'UNet', 'Diffusion Model']);

// Mirrors llama.cpp's current ggml_type enum and block sizes for GGUF tensor-info parsing.
const GGML_TYPES: Record<number, { name: string; blockSize: number; typeSize: number }> = {
  0: { name: 'F32', blockSize: 1, typeSize: 4 },
  1: { name: 'F16', blockSize: 1, typeSize: 2 },
  2: { name: 'Q4_0', blockSize: 32, typeSize: 18 },
  3: { name: 'Q4_1', blockSize: 32, typeSize: 20 },
  6: { name: 'Q5_0', blockSize: 32, typeSize: 22 },
  7: { name: 'Q5_1', blockSize: 32, typeSize: 24 },
  8: { name: 'Q8_0', blockSize: 32, typeSize: 34 },
  9: { name: 'Q8_1', blockSize: 32, typeSize: 36 },
  10: { name: 'Q2_K', blockSize: 256, typeSize: 84 },
  11: { name: 'Q3_K', blockSize: 256, typeSize: 110 },
  12: { name: 'Q4_K', blockSize: 256, typeSize: 144 },
  13: { name: 'Q5_K', blockSize: 256, typeSize: 176 },
  14: { name: 'Q6_K', blockSize: 256, typeSize: 210 },
  15: { name: 'Q8_K', blockSize: 256, typeSize: 292 },
  16: { name: 'IQ2_XXS', blockSize: 256, typeSize: 66 },
  17: { name: 'IQ2_XS', blockSize: 256, typeSize: 74 },
  18: { name: 'IQ3_XXS', blockSize: 256, typeSize: 98 },
  19: { name: 'IQ1_S', blockSize: 256, typeSize: 50 },
  20: { name: 'IQ4_NL', blockSize: 32, typeSize: 18 },
  21: { name: 'IQ3_S', blockSize: 256, typeSize: 110 },
  22: { name: 'IQ2_S', blockSize: 256, typeSize: 82 },
  23: { name: 'IQ4_XS', blockSize: 256, typeSize: 136 },
  24: { name: 'I8', blockSize: 1, typeSize: 1 },
  25: { name: 'I16', blockSize: 1, typeSize: 2 },
  26: { name: 'I32', blockSize: 1, typeSize: 4 },
  27: { name: 'I64', blockSize: 1, typeSize: 8 },
  28: { name: 'F64', blockSize: 1, typeSize: 8 },
  29: { name: 'IQ1_M', blockSize: 256, typeSize: 56 },
  30: { name: 'BF16', blockSize: 1, typeSize: 2 },
  34: { name: 'TQ1_0', blockSize: 256, typeSize: 54 },
  35: { name: 'TQ2_0', blockSize: 256, typeSize: 66 },
  39: { name: 'MXFP4', blockSize: 32, typeSize: 17 },
  40: { name: 'NVFP4', blockSize: 64, typeSize: 36 },
  41: { name: 'Q1_0', blockSize: 128, typeSize: 18 },
};
