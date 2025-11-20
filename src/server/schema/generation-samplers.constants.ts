import { Scheduler } from '@civitai/client';
import type { Sampler } from '~/server/common/constants';

// Sampler to Scheduler mapping
// Extracted to avoid circular dependency between generation.constants.ts and generation.schema.ts
export const samplersToSchedulers = {
  'Euler a': Scheduler.EULER_A,
  Euler: Scheduler.EULER,
  LMS: Scheduler.LMS,
  Heun: Scheduler.HEUN,
  DPM2: Scheduler.DP_M2,
  'DPM2 a': Scheduler.DP_M2A,
  'DPM++ 2S a': Scheduler.DP_M2SA,
  'DPM++ 2M': Scheduler.DP_M2M,
  // 'DPM++ 2M SDE': 'DPM2MSDE',
  'DPM++ SDE': Scheduler.DPMSDE,
  'DPM fast': Scheduler.DPM_FAST,
  'DPM adaptive': Scheduler.DPM_ADAPTIVE,
  'LMS Karras': Scheduler.LMS_KARRAS,
  'DPM2 Karras': Scheduler.DP_M2_KARRAS,
  'DPM2 a Karras': Scheduler.DP_M2A_KARRAS,
  'DPM++ 2S a Karras': Scheduler.DP_M2SA_KARRAS,
  'DPM++ 2M Karras': Scheduler.DP_M2M_KARRAS,
  // 'DPM++ 2M SDE Karras': 'DPM2MSDEKarras',
  'DPM++ SDE Karras': Scheduler.DPMSDE_KARRAS,
  'DPM++ 3M SDE': Scheduler.DP_M3MSDE,
  // 'DPM++ 3M SDE Karras': 'DPM3MSDEKarras',
  // 'DPM++ 3M SDE Exponential': 'DPM3MSDEExponential',
  DDIM: Scheduler.DDIM,
  PLMS: Scheduler.PLMS,
  UniPC: Scheduler.UNI_PC,
  LCM: Scheduler.LCM,
  undefined: Scheduler.UNDEFINED,
} as const as Record<Sampler | 'undefined', Scheduler>;

export const generationSamplers = Object.keys(samplersToSchedulers) as Sampler[];
