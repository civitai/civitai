import { ScanResultCode } from '~/shared/utils/prisma/enums';
import type { ModelFileInput } from '~/server/schema/model-file.schema';

export function getModelFileFormat(filename: string): ModelFileFormat {
  if (filename.endsWith('.safetensors') || filename.endsWith('.sft')) return 'SafeTensor';
  else if (filename.endsWith('.gguf')) return 'GGUF';
  else if (filename.endsWith('.pt') || filename.endsWith('.ckpt')) return 'PickleTensor';
  else if (filename.endsWith('.zip')) return 'Other';

  return 'Other';
}

/** Map a safetensors dtype string to a ModelFileFp precision value. */
function safetensorsDtypeToFp(dtype: string): ModelFileFp | null {
  const d = dtype.toUpperCase();
  if (d === 'F16') return 'fp16';
  if (d === 'BF16') return 'bf16';
  if (d === 'F32' || d === 'F64') return 'fp32';
  if (d.startsWith('F8')) return 'fp8';
  return null;
}

/**
 * Read a .safetensors file's header (client-side) and infer the dominant weight
 * precision (fp16/bf16/fp32/fp8). Returns null when it can't be determined.
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
    const bytesByFp = new Map<ModelFileFp, number>();
    for (const [key, value] of Object.entries(header)) {
      if (key === '__metadata__' || !value?.dtype) continue;
      const fp = safetensorsDtypeToFp(value.dtype);
      if (!fp) continue;
      const offsets = value.data_offsets;
      const size = Array.isArray(offsets) && offsets.length === 2 ? offsets[1] - offsets[0] : 1;
      bytesByFp.set(fp, (bytesByFp.get(fp) ?? 0) + Math.max(size, 0));
    }

    let best: ModelFileFp | null = null;
    let bestBytes = -1;
    for (const [fp, bytes] of bytesByFp) {
      if (bytes > bestBytes) {
        best = fp;
        bestBytes = bytes;
      }
    }
    return best;
  } catch {
    return null;
  }
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
