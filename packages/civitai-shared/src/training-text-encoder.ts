/**
 * Training base models (the in-app trainer's base keys, which the Training Studio's version keys share)
 * whose trainer cannot train the text encoder: the text encoder rate is locked at 0 and the field is
 * disabled. The in-app trainer's `textEncoderLR` overrides and the Training Studio's lock both read this.
 */
export const TEXT_ENCODER_LOCKED_BASES = [
  'flux_dev',
  'flux2_dev',
  // 'flux2_dev_edit', // Disabled for now
  'chroma',
  'qwen_image',
  'zimageturbo',
  'zimagebase',
  'flux2klein_4b',
  'flux2klein_9b',
  'ltx2',
  'ltx23',
  'ltx25',
  'minimaxh3',
  // 'sd3_medium',
  // 'sd3_large',
  'hy_720_fp8',
  'wan_2_1_i2v_14b_720p',
  'wan_2_1_t2v_14b',
  'wan_2_2_t2v_a14b',
  'hidream_o1',
  'anima',
  'boogu',
  'ming',
  'qwen21',
  'krea2',
  'mageflow',
  'ideogram4',
  'acestep_15',
  'yue2',
  'acestep_15_xl_base',
  'acestep_15_xl_sft',
] as const;

const LOCKED: ReadonlySet<string> = new Set(TEXT_ENCODER_LOCKED_BASES);

export const isTextEncoderLockedBase = (base: string): boolean => LOCKED.has(base);
