import { ScanResultCode } from '~/shared/utils/prisma/enums';
import type { ModelFileInput } from '~/server/schema/model-file.schema';

export function getModelFileFormat(filename: string): ModelFileFormat {
  if (filename.endsWith('.safetensors') || filename.endsWith('.sft')) return 'SafeTensor';
  else if (filename.endsWith('.gguf')) return 'GGUF';
  else if (filename.endsWith('.pt') || filename.endsWith('.ckpt')) return 'PickleTensor';
  else if (filename.endsWith('.zip')) return 'Other';

  return 'Other';
}

const SAFETENSORS_DTYPE_TO_FP: Record<string, string> = {
  F16: 'fp16',
  BF16: 'bf16',
  F32: 'fp32',
  F64: 'fp32',
  F8_E8M0: 'mxfp8',
  I8: 'int8',
};

/**
 * Map a safetensors dtype string to a precision value. Scaling schemes
 * (fp8_scaled, nvfp4, …) aren't dtypes and can't be inferred from the header.
 * U8 is deliberately unmapped: bitsandbytes packs nf4/fp4 weights as U8, so
 * guessing int8 there would auto-fill the wrong supported value.
 */
function safetensorsDtypeToFp(dtype: string): string | null {
  const d = dtype.toUpperCase();
  return SAFETENSORS_DTYPE_TO_FP[d] ?? (d.startsWith('F8') ? 'fp8' : null);
}

/**
 * Read a .safetensors file's header (client-side) and infer the dominant weight
 * precision. Returns null when it can't be determined.
 * Only the JSON header is read — never the tensor data — so this is cheap.
 */
export async function inferSafetensorsPrecision(file: File): Promise<ModelFileFp | null> {
  try {
    const name = file.name.toLowerCase();
    if (!name.endsWith('.safetensors') && !name.endsWith('.sft')) return null;

    // First 8 bytes: little-endian uint64 header length.
    const lenBuf = await file.slice(0, 8).arrayBuffer();
    if (lenBuf.byteLength < 8) return null;
    const headerLen = Number(new DataView(lenBuf).getBigUint64(0, true));
    // Guard against corrupt/absurd header sizes (cap at 64MB).
    if (!Number.isFinite(headerLen) || headerLen <= 0 || headerLen > 64 * 1024 * 1024) return null;

    const headerBuf = await file.slice(8, 8 + headerLen).arrayBuffer();
    const header = JSON.parse(new TextDecoder().decode(headerBuf)) as Record<
      string,
      { dtype?: string; data_offsets?: [number, number] }
    >;

    // Pick the dtype that accounts for the most bytes of tensor data.
    const bytesByFp = new Map<string, number>();
    for (const [key, value] of Object.entries(header)) {
      if (key === '__metadata__' || !value?.dtype) continue;
      const fp = safetensorsDtypeToFp(value.dtype);
      if (!fp) continue;
      const offsets = value.data_offsets;
      const size = Array.isArray(offsets) && offsets.length === 2 ? offsets[1] - offsets[0] : 1;
      bytesByFp.set(fp, (bytesByFp.get(fp) ?? 0) + Math.max(size, 0));
    }

    let best: string | null = null;
    let bestBytes = -1;
    for (const [fp, bytes] of bytesByFp) {
      if (bytes > bestBytes) {
        best = fp;
        bestBytes = bytes;
      }
    }

    // MXFP8 stores weights as F8_E4M3 with F8_E8M0 shared-exponent scales (~1 byte
    // per 32 elements), so the scale tensors' presence identifies it, not byte share.
    if (best === 'fp8' && bytesByFp.has('mxfp8')) best = 'mxfp8';

    // Precision options are mod-managed at runtime; the union lags behind them.
    return best as ModelFileFp | null;
  } catch {
    return null;
  }
}

/**
 * The precisions whose answer from the header is authoritative, so a file name may never
 * contradict one. Deliberately NOT every precision `SAFETENSORS_DTYPE_TO_FP` can emit: that map
 * also emits `int8` and `mxfp8`, which a dtype states only sometimes — MXFP8 scales are usually
 * written as U8 rather than F8_E8M0, and GPTQ int8 packs into the unmapped I32 — so a name may
 * supply those, and `resolveUploadPrecision` still keeps either when the header did observe it.
 * Adding a row to that map does not update this set; keep the two in step by hand.
 */
const DTYPE_STATEABLE_FP = new Set(['fp32', 'fp16', 'bf16', 'fp8']);

const isAlphanumeric = (char: string) => /[A-Za-z0-9]/.test(char);

/**
 * Whether `name[index]` starts a word. A separator counts, and so does a camelCase hump — whose
 * lowercase letter may sit behind a version number, as in `v20NF4` and `_51NVFP4`. An UPPERCASE
 * letter before the token does not count, digits between or not: trained-file job ids are 26-char
 * base32, uppercase letters AND digits, so `F2NF4J1W4CGCKYETAEQJT9B5A0` has to be refused by the
 * same rule that accepts `TzigoAnimeFlux_v2NF4`. That refuses all 12 of the prod names where a
 * digit precedes an uppercase token and keeps the 4 real ones. Index 0 is a word start by
 * construction, so an id that BEGINS with a token is still accepted — 1 row in 40,351, left
 * alone. Missing an all-lowercase glued name (`ltx23devnvfp4`) is the side to fail on.
 */
function startsWord(name: string, index: number) {
  if (index === 0) return true;
  if (!isAlphanumeric(name[index - 1])) return true;
  if (!/[A-Z]/.test(name[index])) return false;

  let before = index - 1;
  while (before >= 0 && /[0-9]/.test(name[before])) before--;
  if (before < 0 || !isAlphanumeric(name[before])) return true;
  return /[a-z]/.test(name[before]);
}

/** A trailing digit means the token was part of a longer number (`_int40_`), not the token. */
function endsWord(name: string, index: number) {
  return index >= name.length || !/[0-9]/.test(name[index]);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `fp8_scaled` is written `fp8-scaled` or `fp8 scaled` about as often, so each run of
 * separators in the option becomes an optional one.
 */
function tokenPattern(precision: string) {
  return precision
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(escapeRegExp)
    .join('[-_. ]?');
}

/**
 * Find a precision named in a file's name. Candidates are the values `precisions` offers minus
 * `DTYPE_STATEABLE_FP` — which is narrower than "what a dtype can state", so `int8` and `mxfp8`
 * are candidates here and a header answering one of the other four CAN be contradicted. That is
 * the accepted tradeoff, not an oversight; `resolveUploadPrecision` carries the rest of the rule.
 * Longest option first, which matters only when a mod adds a variant of an existing option —
 * `fp4` inside `nvfp4` is refused by the word-start rule, not by the ordering.
 */
export function inferPrecisionFromFileName(
  fileName: string,
  precisions: readonly string[]
): ModelFileFp | null {
  const candidates = precisions
    .filter((precision) => precision && !DTYPE_STATEABLE_FP.has(precision.toLowerCase()))
    .sort((a, b) => b.length - a.length);

  for (const precision of candidates) {
    const pattern = tokenPattern(precision);
    if (!pattern) continue;
    const matcher = new RegExp(pattern, 'gi');
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(fileName)) !== null) {
      if (startsWord(fileName, match.index) && endsWord(fileName, match.index + match[0].length))
        return precision as ModelFileFp;
      matcher.lastIndex = match.index + 1;
    }
  }

  return null;
}

/**
 * Combine the two signals for an upload. A header answer outside `DTYPE_STATEABLE_FP` was
 * observed directly and wins outright (F8_E8M0 scales are MXFP8 whatever the name says). One
 * inside it loses to any name that claims a candidate precision — deliberately, since that is
 * how a U8-packed NVFP4 body stops being read as the fp32 of its leftover tensors, and the
 * uploader can still edit the field.
 */
export function resolveUploadPrecision({
  fileName,
  headerFp,
  precisions,
}: {
  fileName: string;
  headerFp: ModelFileFp | null;
  precisions: readonly string[];
}): ModelFileFp | null {
  if (headerFp && !DTYPE_STATEABLE_FP.has(headerFp)) return headerFp;
  return inferPrecisionFromFileName(fileName, precisions) ?? headerFp;
}

/**
 * Maps llama.cpp's LLAMA_FTYPE enum (stored in GGUF `general.file_type`) to the
 * quant-type strings the upload form offers. Unquantized ftypes (F32/F16/BF16)
 * and quant schemes not in the form are intentionally omitted -> no auto-fill.
 * Source: llama.cpp include/llama.h.
 */
const GGUF_FTYPE_TO_QUANT: Record<number, ModelFileQuantType> = {
  2: 'Q4_0',
  3: 'Q4_1',
  7: 'Q8_0',
  8: 'Q5_0',
  9: 'Q5_1',
  10: 'Q2_K',
  11: 'Q3_K_S',
  12: 'Q3_K_M',
  13: 'Q3_K_L',
  14: 'Q4_K_S',
  15: 'Q4_K_M',
  16: 'Q5_K_S',
  17: 'Q5_K_M',
  18: 'Q6_K',
  19: 'IQ2_XXS',
  20: 'IQ2_XS',
  21: 'Q2_K_S',
  22: 'IQ3_XS',
  23: 'IQ3_XXS',
  24: 'IQ1_S',
  25: 'IQ4_NL',
  28: 'IQ2_S',
  29: 'IQ2_M',
  30: 'IQ4_XS',
  31: 'IQ1_M',
};

// Thrown when the parser runs past the chunk we've read so far, signalling the
// caller to read a larger chunk and retry.
class GgufNeedMoreBytes extends Error {}

/** Read `general.file_type` from the GGUF metadata header of a byte chunk. */
function readGgufFileType(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let off = 0;
  const need = (n: number) => {
    if (off + n > bytes.length) throw new GgufNeedMoreBytes();
  };
  const u32 = () => {
    need(4);
    const v = view.getUint32(off, true);
    off += 4;
    return v;
  };
  const u64 = () => {
    need(8);
    const lo = view.getUint32(off, true);
    const hi = view.getUint32(off + 4, true);
    off += 8;
    return hi * 2 ** 32 + lo;
  };
  const readStr = () => {
    const len = u64();
    need(len);
    const s = decoder.decode(bytes.subarray(off, off + len));
    off += len;
    return s;
  };
  const skipValue = (valueType: number) => {
    switch (valueType) {
      case 0: // uint8
      case 1: // int8
      case 7: // bool
        need(1);
        off += 1;
        return;
      case 2: // uint16
      case 3: // int16
        need(2);
        off += 2;
        return;
      case 4: // uint32
      case 5: // int32
      case 6: // float32
        need(4);
        off += 4;
        return;
      case 8: {
        // string
        const len = u64();
        need(len);
        off += len;
        return;
      }
      case 9: {
        // array
        const itemType = u32();
        const count = u64();
        if (count > 50_000_000) throw new Error('GGUF metadata array is too large');
        for (let i = 0; i < count; i++) skipValue(itemType);
        return;
      }
      case 10: // uint64
      case 11: // int64
      case 12: // float64
        need(8);
        off += 8;
        return;
      default:
        throw new Error(`Unsupported GGUF metadata value type ${valueType}`);
    }
  };

  need(4);
  if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'GGUF') return null;
  off = 4;
  u32(); // version
  u64(); // tensor count
  const metadataCount = u64();
  if (metadataCount > 1_000_000) return null;

  for (let i = 0; i < metadataCount; i++) {
    const key = readStr();
    const valueType = u32();
    if (key === 'general.file_type') {
      // file_type is written as UINT32 (4); accept INT32 (5) defensively.
      if (valueType === 4 || valueType === 5) return u32();
      skipValue(valueType);
      return null;
    }
    skipValue(valueType);
  }
  return null;
}

/**
 * Read a .gguf file's header (client-side) and infer the quantization type from
 * `general.file_type`. Returns null when it can't be determined. Only the header
 * is read (growing the chunk if needed), never the tensor data.
 */
export async function inferGgufQuantType(file: File): Promise<ModelFileQuantType | null> {
  if (!file.name.toLowerCase().endsWith('.gguf')) return null;
  // `general.*` keys come first by convention, so file_type is usually within the
  // first few KB — but grow the read if it sits past large tokenizer arrays.
  const chunkSizes = [256 * 1024, 4 * 1024 * 1024, 32 * 1024 * 1024];
  for (const chunkSize of chunkSizes) {
    const readSize = Math.min(chunkSize, file.size);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.slice(0, readSize).arrayBuffer());
    } catch {
      return null;
    }
    try {
      const ftype = readGgufFileType(bytes);
      return ftype != null ? GGUF_FTYPE_TO_QUANT[ftype] ?? null : null;
    } catch (e) {
      // Only retry with a bigger chunk if there are more bytes to read.
      if (e instanceof GgufNeedMoreBytes && readSize < file.size) continue;
      return null;
    }
  }
  return null;
}

const unscannedFile = {
  scannedAt: null,
  scanRequestedAt: null,
  rawScanResult: null,
  virusScanMessage: null,
  virusScanResult: ScanResultCode.Pending,
  pickleScanMessage: null,
  pickleScanResult: ScanResultCode.Pending,
};

export function prepareFile(file: ModelFileInput) {
  // .zip files can contain formats that aren't inferable from the extension (e.g. Diffusers),
  // so trust an explicit metadata.format for those. Otherwise infer from the filename — for
  // every file type, not only `Model` (multi-file packs use VAE / Text Encoder / Diffusion Model).
  const providedFormat = file.name.endsWith('.zip') ? file.metadata?.format : undefined;
  const format: ModelFileFormat = providedFormat ?? getModelFileFormat(file.name);

  return {
    ...file,
    ...(file.id ? {} : unscannedFile), // Only set unscannedFile on new files
    metadata: {
      ...file.metadata,
      format,
    },
  };
}
