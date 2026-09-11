import { describe, expect, it } from 'vitest';

import { constants } from '~/server/common/constants';
import {
  inferPrecisionFromFileName,
  inferSafetensorsPrecision,
  resolveUploadPrecision,
} from '~/utils/file-helpers';

const precisions = [...constants.modelFileFp];

/** Build a safetensors file whose header carries the given dtypes and byte shares. */
function safetensorsFile(
  name: string,
  dtypes: Array<[dtype: string, count: number, bytes: number]>
) {
  const header: Record<string, { dtype: string; data_offsets: [number, number] }> = {};
  let offset = 0;
  for (const [dtype, count, bytes] of dtypes) {
    const per = Math.floor(bytes / count);
    for (let i = 0; i < count; i++) {
      header[`${dtype}.${i}`] = { dtype, data_offsets: [offset, offset + per] };
      offset += per;
    }
  }
  const json = new TextEncoder().encode(JSON.stringify(header));
  const len = new Uint8Array(8);
  new DataView(len.buffer).setBigUint64(0, BigInt(json.byteLength), true);
  return new File([len, json], name);
}

/**
 * The two headers below are not invented. They were read from production on 2026-09-10 through
 * `/api/v1/model-files/<id>/tensor-metadata`, which is why the byte shares are lopsided: the
 * quantized bulk sits in U8, which the dtype mapper deliberately leaves unmapped, so the vote is
 * decided by the housekeeping tensors that are left.
 */
const MXFP8_HEADER: Array<[string, number, number]> = [
  ['F8_E4M3', 256, 12_498_501_632],
  ['BF16', 174, 643_142_808],
  ['U8', 256, 390_578_176],
];
const NVFP4_HEADER: Array<[string, number, number]> = [
  ['U8', 448, 6_077_550_752],
  ['F32', 239, 1_280_582_832],
  ['F8_E4M3', 224, 759_693_312],
  ['BF16', 191, 689_669_120],
];

describe('upload precision: filename fallback under the header', () => {
  // 🔴 These two cases are the bug. Reverting resolveUploadPrecision to return the header answer
  // makes them read 'fp8' and 'fp32' — the values production actually stored. Do not relax them
  // into `toBeTruthy`; the wrong answer is a real precision, so only the exact value fails.
  it('reads MXFP8 from the name when the scales were written as U8', async () => {
    const file = safetensorsFile('krea2_finalcut_pro_mxfp8.safetensors', MXFP8_HEADER);
    const headerFp = await inferSafetensorsPrecision(file);

    expect(headerFp).toBe('fp8');
    expect(resolveUploadPrecision({ fileName: file.name, headerFp, precisions })).toBe('mxfp8');
  });

  it('reads NVFP4 from the name when the weights were packed into U8', async () => {
    const file = safetensorsFile('KREAtivity_5.0_NVFP4.safetensors', NVFP4_HEADER);
    const headerFp = await inferSafetensorsPrecision(file);

    expect(headerFp).toBe('fp32');
    expect(resolveUploadPrecision({ fileName: file.name, headerFp, precisions })).toBe('nvfp4');
  });

  it('keeps the header when the name claims a precision a dtype can state', async () => {
    const file = safetensorsFile('some_model_fp8.safetensors', [['BF16', 4, 4_000_000]]);
    const headerFp = await inferSafetensorsPrecision(file);

    expect(headerFp).toBe('bf16');
    expect(resolveUploadPrecision({ fileName: file.name, headerFp, precisions })).toBe('bf16');
  });

  it('keeps a scheme the header observed directly over a contradicting name', async () => {
    const file = safetensorsFile('something_nf4.safetensors', [
      ['F8_E4M3', 8, 8_000_000],
      ['F8_E8M0', 8, 250_000],
    ]);
    const headerFp = await inferSafetensorsPrecision(file);

    expect(headerFp).toBe('mxfp8');
    expect(resolveUploadPrecision({ fileName: file.name, headerFp, precisions })).toBe('mxfp8');
  });
});

describe('inferPrecisionFromFileName', () => {
  it('prefers the longest option, so fp8_scaled is not read as fp8', () => {
    expect(inferPrecisionFromFileName('mymodel_fp8_scaled.safetensors', precisions)).toBe(
      'fp8_scaled'
    );
    expect(inferPrecisionFromFileName('mymodel-fp8-scaled.safetensors', precisions)).toBe(
      'fp8_scaled'
    );
  });

  it('accepts a camelCase hump as a word start', () => {
    expect(inferPrecisionFromFileName('RawGirlKreaNVFP4.safetensors', precisions)).toBe('nvfp4');
  });

  it('offers a precision a mod added at runtime and the constants do not carry', () => {
    expect(constants.modelFileFp).not.toContain('mxfp6');
    expect(inferPrecisionFromFileName('mymodel_mxfp6.safetensors', [...precisions, 'mxfp6'])).toBe(
      'mxfp6'
    );
  });

  // The positive control for the two negatives below: the same list, the same token, one
  // legal boundary — so a null there is the boundary rule firing, not a matcher that
  // can only ever return null.
  it('matches nf4 and int4 when they start a word', () => {
    expect(inferPrecisionFromFileName('PW2MQD_NF4_ZXWSGYEHXWCGH8B60.safetensors', precisions)).toBe(
      'nf4'
    );
    expect(inferPrecisionFromFileName('lora_int4.safetensors', precisions)).toBe('int4');
  });

  it('does not read a precision out of a trained-file job id', () => {
    expect(inferPrecisionFromFileName('PW2MQDNF4ZXWSGYEHXWCGH8B60.safetensors', precisions)).toBe(
      null
    );
    expect(inferPrecisionFromFileName('AGAGENF442Q05F8KABM73JT1C0.safetensors', precisions)).toBe(
      null
    );
  });

  it('does not read int4 out of an ordinary word', () => {
    expect(
      inferPrecisionFromFileName(
        'Jamie Lee Curtis LoRA use 0point4 strength.safetensors',
        precisions
      )
    ).toBe(null);
    expect(inferPrecisionFromFileName('SM-FinetunePaint40Art-Remake.safetensors', precisions)).toBe(
      null
    );
  });
});
