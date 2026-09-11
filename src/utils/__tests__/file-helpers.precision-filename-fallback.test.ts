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

  // Both production headers happen to have their tensor COUNT order agree with their BYTE
  // order, so they cannot tell the byte weighting from one-point-per-tensor. This one disagrees:
  // scoring per tensor reads fp32.
  it('decides the header vote on bytes, not on how many tensors carry a dtype', async () => {
    const file = safetensorsFile('plain.safetensors', [
      ['BF16', 2, 20_000_000],
      ['F32', 50, 50_000],
    ]);

    expect(await inferSafetensorsPrecision(file)).toBe('bf16');
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
  it('reads a separator inside an option as optional', () => {
    expect(inferPrecisionFromFileName('mymodel_fp8_scaled.safetensors', precisions)).toBe(
      'fp8_scaled'
    );
    expect(inferPrecisionFromFileName('mymodel-fp8-scaled.safetensors', precisions)).toBe(
      'fp8_scaled'
    );
  });

  // The live list cannot exercise the longest-first sort: no option in it is a word-start-legal
  // prefix of another, and `fp4` inside `nvfp4` is refused by the word-start rule rather than by
  // the ordering. It becomes load-bearing the moment a mod adds a variant of an existing option,
  // which is what this pins — without the sort, `fp8_scaled` wins because it is listed first.
  it('prefers the longest option when a shorter one is a legal prefix of it', () => {
    expect(
      inferPrecisionFromFileName('mymodel_fp8_scaled_v2.safetensors', [
        ...precisions,
        'fp8_scaled_v2',
      ])
    ).toBe('fp8_scaled_v2');
  });

  // `modelFileOptions` is trimmed but never lowercased, so a mod can add `FP8`. Without a
  // case-folded filter it escapes the dtype-stateable check and overrides a correct header.
  it('does not offer a dtype-stateable option a mod typed in capitals', () => {
    expect(inferPrecisionFromFileName('mymodel_fp8.safetensors', [...precisions, 'FP8'])).toBe(
      null
    );
  });

  it('accepts a camelCase hump as a word start', () => {
    expect(inferPrecisionFromFileName('RawGirlKreaNVFP4.safetensors', precisions)).toBe('nvfp4');
  });

  // Real prod names. A version number between the lowercase hump and the token is the common
  // shape and must survive the rule that refuses job ids.
  it('accepts a version number between the hump and the token', () => {
    expect(inferPrecisionFromFileName('TzigoAnimeFlux_v2NF4.safetensors', precisions)).toBe('nf4');
    expect(
      inferPrecisionFromFileName('fluxedUpFluxNSFW_51NVFP4-Nunchaku.safetensors', precisions)
    ).toBe('nvfp4');
    expect(
      inferPrecisionFromFileName('projectGaiaFlux1D_v20NF4Uncensored.safetensors', precisions)
    ).toBe('nf4');
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

  // 🔴 The digit-preceded ids are the ones that matter. Base32 is uppercase letters AND digits,
  // so a rule that accepted any [a-z0-9] before an uppercase token minted `nf4` for 12 real prod
  // job ids while every fixture here passed. Keep at least one digit-preceded id in this list.
  it('does not read a precision out of a trained-file job id', () => {
    expect(inferPrecisionFromFileName('PW2MQDNF4ZXWSGYEHXWCGH8B60.safetensors', precisions)).toBe(
      null
    );
    expect(inferPrecisionFromFileName('AGAGENF442Q05F8KABM73JT1C0.safetensors', precisions)).toBe(
      null
    );
    expect(inferPrecisionFromFileName('F2NF4J1W4CGCKYETAEQJT9B5A0.safetensors', precisions)).toBe(
      null
    );
    expect(inferPrecisionFromFileName('3HAF53NF4S8FDQMV8HC9Z8C300.safetensors', precisions)).toBe(
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

  // The only case `endsWord` decides on its own: a separator satisfies `startsWord`, so
  // nothing else can refuse it.
  it('does not read int4 out of a longer number at a word start', () => {
    expect(inferPrecisionFromFileName('model_int40_fix.safetensors', precisions)).toBe(null);
  });
});
