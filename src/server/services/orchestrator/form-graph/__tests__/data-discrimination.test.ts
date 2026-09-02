import { describe, expect, it } from 'vitest';
import type { GenerationData } from '../types';

/**
 * `GenerationData` must be a DISCRIMINATED union on `ecosystem`: every family
 * arm emits its ecosystem with a literal type, so handlers narrow with
 * `Extract<GenerationData, { ecosystem: 'Kling' }>` instead of loose casts.
 * An arm whose emit regresses to `string` widens `Extract<..., never-matched>`
 * results and the type-level assertions here catch it.
 */

type Assert<T extends true> = T;
type NotNever<T> = [T] extends [never] ? false : true;

type Eco = GenerationData['ecosystem'];

describe('GenerationData discrimination', () => {
  it('every ecosystem literal extracts a real arm, and no arm is stringly typed', () => {
    // a single string-typed arm would make Eco = string and every line below fail
    type _finite = Assert<string extends Eco ? false : true>;
    type ArmOf<E extends Eco> = Extract<GenerationData, { ecosystem: E }>;
    type _sd = Assert<NotNever<ArmOf<'SDXL'>>>;
    type _zimage = Assert<NotNever<ArmOf<'ZImageBase'>>>;
    type _flux = Assert<NotNever<ArmOf<'Flux1'>>>;
    type _klein = Assert<NotNever<ArmOf<'Flux2Klein_4B'>>>;
    type _qwen = Assert<NotNever<ArmOf<'Qwen3'>>>;
    type _grok = Assert<NotNever<ArmOf<'Grok'>>>;
    type _wan = Assert<NotNever<ArmOf<'WanVideo14B_I2V_480p'>>>;
    type _ltx = Assert<NotNever<ArmOf<'LTXV23'>>>;
    type _kling = Assert<NotNever<ArmOf<'Kling'>>>;
    type _ace = Assert<NotNever<ArmOf<'Ace'>>>;
    type _music = Assert<NotNever<ArmOf<'MiniMaxMusic3'>>>;
    type _polygen = Assert<NotNever<ArmOf<'PolyGen'>>>;
    type _trellis = Assert<NotNever<ArmOf<'Trellis2'>>>;
    // arms carry their family fields
    type _klingCfg = Assert<'cfgScale' extends keyof ArmOf<'Kling'> ? true : false>;
    type _aceBpm = Assert<'bpm' extends keyof ArmOf<'Ace'> ? true : false>;
    expect(true).toBe(true);
  });
});
